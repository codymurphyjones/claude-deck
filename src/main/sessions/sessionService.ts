import { webContents } from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import { baseName } from '@shared/paths'
import type { GoalState, LaunchOptions, MeshRole, SessionInfo, SessionKind } from '@shared/types'
import type { AuthService } from '../auth/authService'
import { broadcast, pushTimeline, settings, state, toast, updateState } from '../context'
import { loadEnvironment, setupCommand } from '../env/environmentService'
import { currentBranch, snapshot, toplevel } from '../git/gitService'
import { emitLibrary, ensureProject, findProjectForFolder, getChat, updateChat, upsertChat } from '../library'
import { MeshService } from '../mesh/meshService'
import { focusSession, notify, updateSleepBlocker } from '../notify/notifyService'
import type { PtyService } from '../pty/ptyService'
import { defaultShell, locateClaude, runtime } from '../runtime'
import { copyTranscriptTo, findTranscript, sessionUsage } from '../transcripts/transcriptService'
import { stripAnsi, truncate, uuid } from '../util'
import {
  createWorktree,
  enforceLimit,
  findWorktreeByPath,
  getWorktree,
  handoffToLocal,
  handoffToWorktree,
  touchWorktree
} from '../worktrees/worktreeService'
import { buildClaudeArgs, claudeEnv, plainEnv } from './launch'
import { ChatProcess, type PermissionDecision } from '../chat/chatProcess'
import { loadConversation } from '../chat/history'
import { chatToText, type ChatOp } from '@shared/chat'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type HookPayload = {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  permission_mode?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  notification_type?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

type HookResult = { stdout?: string; exitCode?: number }

const ctxOut = (event: string, text: string | undefined): HookResult =>
  text ? { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) } : {}

export class SessionService extends EventEmitter {
  readonly sessions = new Map<string, SessionInfo & { contextTokens?: number; queued?: string[]; turnFiles?: Set<string> }>()
  readonly mesh: MeshService
  /** Claude sessions run as structured chat processes (no terminal). */
  readonly chats = new Map<string, ChatProcess>()
  private active = new Map<number, string | undefined>()
  private reviewNudges = new Map<string, number[]>()
  /** Window that hosts sessions created without one (scheduled tasks). */
  defaultHost = 0
  terminalReader: ((s: SessionInfo, lines: number) => Promise<string | undefined>) | undefined

  constructor(
    private pty: PtyService,
    private auth: AuthService
  ) {
    super()
    this.mesh = new MeshService({
      sessions: () => [...this.sessions.values()],
      get: (id) => this.sessions.get(id),
      inject: (id, text) => this.inject(id, text),
      readTerminal: (id, lines) => this.readTerminal(id, lines),
      shellOf: (id) => [...this.sessions.values()].find((x) => x.kind === 'shell' && x.launch.parentId === id && this.pty.has(x.id)),
      sessionChanged: (id) => {
        const s = this.sessions.get(id)
        if (s) this.changed(s)
      }
    })
    pty.on('data', (id: string, data: string) => {
      const s = this.sessions.get(id)
      const wc = s ? webContents.fromId(s.hostWindow) : undefined
      if (wc && !wc.isDestroyed()) wc.send('pty:data', id, data)
      else broadcast('pty:data', id, data)
    })
    pty.on('exit', (id: string, code: number) => this.onExit(id, code))
    auth.on('changed', (st: { loggedIn: boolean }) => {
      if (!st.loggedIn) return
      for (const s of this.sessions.values()) if (s.status === 'waiting-auth') void this.start(s)
    })
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => this.public(s))
  }

  private public(s: SessionInfo & { contextTokens?: number; queued?: string[]; turnFiles?: Set<string> }): SessionInfo & { contextTokens?: number; queuedCount?: number } {
    const { queued, turnFiles: _t, ...rest } = s
    return { ...rest, queuedCount: queued?.length ?? 0 }
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  private changed(s: SessionInfo): void {
    broadcast('session:update', this.public(s))
    updateSleepBlocker([...this.sessions.values()].some((x) => x.status === 'working'))
    broadcast('buddy:update', this.list())
  }

  setActive(windowId: number, id: string | undefined, focused: boolean): void {
    this.active.set(windowId, focused ? id : undefined)
    if (id) {
      const s = this.sessions.get(id)
      if (s && s.unread) {
        s.unread = false
        this.changed(s)
      }
    }
  }

  markAllRead(): void {
    for (const s of this.sessions.values())
      if (s.unread) {
        s.unread = false
        this.changed(s)
      }
  }

  private isActive(s: SessionInfo): boolean {
    return [...this.active.values()].includes(s.id)
  }

  private uniqueName(name: string, exceptId?: string): string {
    const taken = new Set([...this.sessions.values()].filter((s) => s.id !== exceptId && s.kind === 'claude').map((s) => s.name.toLowerCase()))
    if (!taken.has(name.toLowerCase())) return name
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`
  }

  // ---------------- creation ----------------
  async create(kind: SessionKind, launch: LaunchOptions, hostWindow: number): Promise<SessionInfo> {
    hostWindow ||= this.defaultHost
    const L: LaunchOptions = { ...launch }
    if (L.templateId) {
      const t = settings().sessionTemplates.find((x) => x.id === L.templateId)
      if (t) {
        L.model ??= t.model
        L.effort ??= t.effort
        L.permissionMode ??= t.permissionMode
        L.appendSystemPrompt = [t.appendSystemPrompt, L.appendSystemPrompt].filter(Boolean).join('\n\n') || undefined
        L.addDirs = [...(t.addDirs ?? []), ...(L.addDirs ?? [])]
        L.role ??= t.role
        L.remoteControl ??= t.remoteControl
        L.initialPrompt ??= t.initialPrompt
        if (t.useWorktree && !L.worktree && !L.resumeId) L.worktree = {}
      }
    }
    let cwd = L.cwd
    if (kind === 'claude' && L.quick) {
      cwd = path.join(runtime.scratchDir, new Date().toISOString().slice(0, 10) + '-' + uuid().slice(0, 6))
      fs.mkdirSync(cwd, { recursive: true })
    }
    if (!cwd || !fs.existsSync(cwd)) throw new Error(`Folder does not exist: ${cwd}`)
    let setup: string | undefined
    let worktreeId: string | undefined
    let projectFolder = cwd
    if (kind === 'claude' && L.worktree) {
      const wt = await createWorktree({ repoCwd: cwd, ...L.worktree })
      projectFolder = findProjectForFolder(cwd)?.folders[0] ?? wt.repoRoot
      cwd = wt.path
      worktreeId = wt.id
      setup = setupCommand(loadEnvironment(wt.repoRoot))
      if (L.resumeId) copyTranscriptTo(L.resumeId, cwd)
      void enforceLimit((w) => this.isWorktreeProtected(w.id))
    } else {
      const wt = findWorktreeByPath(cwd)
      if (wt) {
        worktreeId = wt.id
        projectFolder = findProjectForFolder(wt.repoRoot)?.folders[0] ?? wt.repoRoot
        touchWorktree(wt.id)
      }
    }
    const root = (await toplevel(cwd)) ?? cwd
    const chat = L.resumeId ? getChat(L.resumeId) : undefined
    const project = kind === 'claude' && !L.quick ? ensureProject(projectFolder) : undefined
    const id = uuid()
    const baseNm =
      L.name ||
      (L.sideOf ? `${this.sessions.get(L.sideOf)?.name ?? 'side'} · side` : undefined) ||
      (chat && !L.fork ? chat.name : undefined) ||
      (kind === 'shell' ? 'Shell' : kind === 'login' ? 'Sign in' : kind === 'command' ? L.name || 'Command' : L.quick ? 'Quick chat' : baseName(cwd))
    const s: SessionInfo = {
      id,
      kind,
      name: kind === 'claude' ? this.uniqueName(baseNm) : baseNm,
      cwd,
      root,
      claudeSessionId: kind === 'claude' ? (L.resumeId && !L.fork ? L.resumeId : L.resumeId ? undefined : uuid()) : undefined,
      projectId: project?.id,
      worktreeId,
      status: 'starting',
      createdAt: Date.now(),
      lastActivity: Date.now(),
      lastUserInput: 0,
      unread: false,
      role: L.role ?? 'free',
      pendingMessages: 0,
      files: [],
      branch: await currentBranch(root),
      hostWindow,
      launch: L,
      temporary: !!L.sideOf
    }
    if (kind === 'claude' && settings().mesh.enabled) {
      const g = await this.mesh.groupFor(cwd, root)
      s.meshGroup = g.key
      this.mesh.ensureGroup(g.key, g.label)
    }
    this.sessions.set(id, s)
    if (s.meshGroup) s.meshColor = this.mesh.colorFor(s.meshGroup)
    if (kind === 'claude' && s.claudeSessionId) this.recordChat(s)
    this.changed(s)
    await this.start(s)
    if (setup) await this.openShell(s.id, setup)
    if (kind === 'claude') pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'start', text: `Started in ${cwd}`, group: s.meshGroup })
    return this.public(s)
  }

  private recordChat(s: SessionInfo): void {
    if (!s.claudeSessionId) return
    upsertChat({
      claudeSessionId: s.claudeSessionId,
      name: s.name,
      cwd: s.cwd,
      projectId: s.projectId,
      worktreeId: s.worktreeId,
      branch: s.branch,
      model: s.launch.model,
      quick: s.launch.quick,
      hidden: s.temporary || undefined
    })
    if (s.worktreeId) touchWorktree(s.worktreeId, { chatId: s.claudeSessionId })
  }

  isWorktreeProtected(id: string): boolean {
    const w = getWorktree(id)
    if (!w) return false
    if ([...this.sessions.values()].some((s) => s.worktreeId === id && s.status !== 'exited')) return true
    return !!(w.chatId && getChat(w.chatId)?.pinned)
  }

  private async start(s: SessionInfo): Promise<void> {
    const size = this.pty.size(s.id)
    try {
      if (s.kind === 'claude') {
        if (!this.auth.status.checked) await this.auth.refresh()
        if (!this.auth.status.loggedIn) {
          s.status = 'waiting-auth'
          this.changed(s)
          return
        }
        s.status = 'starting'
        // Claude only saves a transcript once a conversation has a message; an empty
        // session can't be resumed, so start it fresh under the same id instead.
        const rid = s.launch.resumeId
        if (rid && !findTranscript(rid)) {
          s.claudeSessionId = s.launch.fork ? uuid() : rid
          s.launch = { ...s.launch, resumeId: undefined, fork: false }
          this.recordChat(s)
        }
        this.startChat(s)
      } else if (s.kind === 'login') {
        s.status = 'working'
        this.pty.spawn(s.id, locateClaude(settings().claudePath), this.auth.loginArgs(s.launch.login), { cwd: s.cwd, env: plainEnv(), ...size })
      } else if (s.kind === 'shell') {
        s.status = 'idle'
        this.pty.spawn(s.id, s.launch.command || defaultShell(settings().shell), s.launch.args ?? [], { cwd: s.cwd, env: plainEnv(), ...size })
      } else {
        s.status = 'working'
        this.pty.spawn(s.id, s.launch.command!, s.launch.args ?? [], { cwd: s.cwd, env: plainEnv(), ...size })
      }
    } catch (e) {
      s.status = 'exited'
      s.exitCode = -1
      toast(`Could not start ${s.name}: ${(e as Error).message}`, 'error')
    }
    this.changed(s)
  }

  private hostSend(s: SessionInfo, channel: string, ...args: unknown[]): void {
    const wc = webContents.fromId(s.hostWindow)
    if (wc && !wc.isDestroyed()) wc.send(channel, ...args)
    else broadcast(channel, ...args)
  }

  private startChat(s: SessionInfo): void {
    this.chats.get(s.id)?.removeAllListeners().kill()
    const chat = new ChatProcess()
    this.chats.set(s.id, chat)
    const rid = s.launch.resumeId
    if (rid) chat.items = loadConversation(findTranscript(rid))
    this.hostSend(s, 'chat:op', s.id, { op: 'reset', items: chat.items } satisfies ChatOp)
    chat.on('op', (o: ChatOp) => this.hostSend(s, 'chat:op', s.id, o))
    chat.on('meta', (m) => this.hostSend(s, 'chat:meta', s.id, m))
    chat.on('session', (sid: string) => {
      if (sid !== s.claudeSessionId) {
        s.claudeSessionId = sid
        this.recordChat(s)
        this.changed(s)
      }
    })
    chat.on('status', (st: 'working' | 'needs-input' | 'idle', perm?: { toolName: string; description?: string }) => {
      if (st === 'needs-input') {
        s.status = 'needs-input'
        s.attention = `Claude wants to use ${perm?.toolName ?? 'a tool'}${perm?.description ? `: ${perm.description}` : ''}`
        if (!this.isActive(s)) s.unread = true
        notify(perm?.toolName === 'AskUserQuestion' ? 'question' : 'permission', s, `${s.name} needs you`, s.attention)
      } else if (st === 'working') {
        s.status = 'working'
        s.attention = undefined
      } else if (s.status !== 'exited') {
        s.status = 'idle'
        s.attention = undefined
        this.mesh.onStatus(s)
      }
      s.lastActivity = Date.now()
      this.changed(s)
    })
    chat.on('exit', (code: number, stderr: string) => {
      if (this.chats.get(s.id) !== chat) return
      if (code !== 0 && stderr) chat.notice(stderr.split('\n').slice(-6).join('\n'), 'error')
      this.onExit(s.id, code)
    })
    chat.start(locateClaude(settings().claudePath), buildClaudeArgs(s), { cwd: s.cwd, env: claudeEnv(s) })
    s.status = 'idle'
    if (s.launch.initialPrompt) chat.send(s.launch.initialPrompt)
  }

  chatSnapshot(id: string) {
    const c = this.chats.get(id)
    return c ? { items: c.items, meta: c.meta } : { items: [], meta: { commands: [], tools: [], busy: false, queued: 0 } }
  }

  chatSend(id: string, text: string, images?: { mediaType: string; data: string }[]): boolean {
    const s = this.sessions.get(id)
    const c = this.chats.get(id)
    if (!s || !c) return false
    s.lastUserInput = Date.now()
    if (!c.alive) {
      toast('This session has ended — resume it first', 'error')
      return false
    }
    return c.send(text, { images })
  }

  chatInterrupt(id: string): void {
    this.chats.get(id)?.interrupt()
  }

  chatPermission(id: string, requestId: string, d: PermissionDecision): void {
    this.chats.get(id)?.respondPermission(requestId, d)
    const s = this.sessions.get(id)
    if (s && !this.chats.get(id)?.hasPendingPermission() && s.status === 'needs-input') {
      s.status = 'working'
      s.attention = undefined
      this.changed(s)
    }
  }

  async setMode(id: string, mode: string): Promise<void> {
    const c = this.chats.get(id)
    if (!c) return
    await c.setPermissionMode(mode)
    const s = this.sessions.get(id)
    if (s) {
      s.permissionMode = mode
      s.launch = { ...s.launch, permissionMode: mode }
      this.changed(s)
    }
  }

  async setModel(id: string, model: string): Promise<void> {
    const c = this.chats.get(id)
    if (!c) return
    await c.setModel(model)
    const s = this.sessions.get(id)
    if (s) {
      s.model = model
      s.launch = { ...s.launch, model: model || undefined }
      this.changed(s)
    }
  }

  typing(id: string): void {
    const s = this.sessions.get(id)
    if (s) s.lastUserInput = Date.now()
  }

  private onExit(id: string, code: number): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.status = 'exited'
    s.exitCode = code
    s.attention = undefined
    this.mesh.onStatus(s)
    this.changed(s)
    if (s.kind === 'login') void this.auth.refresh()
    if (s.kind === 'claude') pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'exit', text: `Exited (${code})`, group: s.meshGroup })
    this.emit('exit', s)
  }

  async openShell(parentId: string, command?: string): Promise<SessionInfo> {
    const parent = this.sessions.get(parentId)
    if (!parent) throw new Error('No such session')
    const existing = [...this.sessions.values()].find((x) => x.kind === 'shell' && x.launch.parentId === parentId)
    if (existing && this.pty.has(existing.id)) {
      if (command) this.pty.write(existing.id, command + '\r')
      return this.public(existing)
    }
    if (existing) this.close(existing.id)
    const shell = defaultShell(settings().shell)
    const isPs = /pwsh|powershell/i.test(shell)
    const args = command ? (isPs ? ['-NoLogo', '-NoExit', '-Command', command] : ['-c', `${command}; exec ${shell}`]) : isPs ? ['-NoLogo'] : []
    return this.create('shell', { cwd: parent.cwd, parentId, command: shell, args, name: `${parent.name} · shell` }, parent.hostWindow)
  }

  async runAction(parentId: string, command: string): Promise<SessionInfo> {
    return this.openShell(parentId, command)
  }

  // ---------------- terminal I/O ----------------
  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s) s.lastUserInput = Date.now()
    this.pty.write(id, data)
  }

  resize(id: string, cols: number, rows: number): void {
    this.pty.resize(id, cols, rows)
  }

  buffer(id: string): string {
    return this.pty.buffer(id)
  }

  repaint(id: string): void {
    this.pty.repaint(id)
  }

  /** Type a prompt into a Claude session and submit it. */
  inject(id: string, text: string, submit = true): boolean {
    const chat = this.chats.get(id)
    if (chat) return chat.send(text, { injected: true })
    if (!this.pty.has(id)) return false
    const multi = text.includes('\n') || text.length > 300
    this.pty.write(id, multi ? `\x1b[200~${text.replace(/\r?\n/g, '\r')}\x1b[201~` : text)
    if (submit) setTimeout(() => this.pty.write(id, '\r'), 120 + Math.min(500, Math.floor(text.length / 25)))
    return true
  }

  sendPrompt(id: string, text: string, mode: 'steer' | 'queue' = settings().followUp): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.lastUserInput = Date.now()
    // Chat sessions queue natively in the CLI.
    const chat = this.chats.get(id)
    if (chat) {
      chat.send(text)
      return
    }
    if (mode === 'queue' && (s.status === 'working' || s.status === 'needs-input')) {
      s.queued = [...(s.queued ?? []), text]
      this.changed(s)
      return
    }
    this.inject(id, text)
  }

  broadcastPrompt(ids: string[], text: string): void {
    for (const id of ids) this.sendPrompt(id, text, 'queue')
  }

  async readTerminal(id: string, lines: number): Promise<string> {
    const s = this.sessions.get(id)
    if (!s) return ''
    const chat = this.chats.get(id)
    if (chat) return chatToText(chat.items, Math.max(10, Math.round(lines / 4)))
    const fromView = this.terminalReader ? await this.terminalReader(s, lines).catch(() => undefined) : undefined
    if (fromView) return fromView
    return stripAnsi(this.pty.buffer(id)).split(/\r?\n/).slice(-lines).join('\n')
  }

  // ---------------- lifecycle actions ----------------
  close(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    for (const child of [...this.sessions.values()].filter((x) => x.launch.parentId === id)) this.close(child.id)
    this.pty.dispose(id)
    this.chats.get(id)?.removeAllListeners().kill()
    this.chats.delete(id)
    s.status = 'exited'
    this.mesh.onStatus(s)
    this.sessions.delete(id)
    if (s.temporary && s.claudeSessionId) updateChat(s.claudeSessionId, { hidden: true })
    broadcast('session:removed', id)
    broadcast('buddy:update', this.list())
    updateSleepBlocker([...this.sessions.values()].some((x) => x.status === 'working'))
    void enforceLimit((w) => this.isWorktreeProtected(w.id))
  }

  async restart(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s) return
    this.pty.dispose(id)
    this.chats.get(id)?.removeAllListeners().kill()
    if (s.kind === 'claude') {
      s.launch = { ...s.launch, resumeId: s.claudeSessionId, fork: false, continueLast: false, initialPrompt: undefined, worktree: undefined }
      s.exitCode = undefined
    }
    await this.start(s)
  }

  rename(id: string, name: string): void {
    const s = this.sessions.get(id)
    if (!s || !name.trim()) return
    s.name = s.kind === 'claude' ? this.uniqueName(name.trim(), id) : name.trim()
    if (s.claudeSessionId) updateChat(s.claudeSessionId, { name: s.name })
    this.changed(s)
  }

  setRole(id: string, role: MeshRole): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.role = role
    this.changed(s)
    if (s.status === 'idle' && role !== 'free')
      this.inject(id, `[Claude Deck] Your team role is now ${role.toUpperCase()}. Follow the role guidance for ${role}s from your instructions; check mesh_peers and board_list, then continue.`)
  }

  cycleMode(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (!this.chats.has(id)) return this.pty.write(id, '\x1b[Z')
    const order = ['default', 'acceptEdits', 'plan', 'auto']
    const cur = order.indexOf(s.permissionMode ?? 'default')
    void this.setMode(id, order[(cur + 1) % order.length])
  }

  async fork(id: string, opts: { worktree?: boolean; side?: boolean }): Promise<SessionInfo> {
    const s = this.sessions.get(id)
    if (!s?.claudeSessionId) throw new Error('This session has no conversation to fork yet')
    return this.create(
      'claude',
      {
        cwd: s.cwd,
        resumeId: s.claudeSessionId,
        fork: true,
        worktree: opts.worktree ? { carryChanges: true } : undefined,
        sideOf: opts.side ? s.id : undefined,
        name: opts.side ? undefined : `${s.name} fork`,
        model: s.launch.model,
        permissionMode: s.launch.permissionMode
      },
      s.hostWindow
    )
  }

  /** Move a session between a worktree and the local checkout, keeping the conversation. */
  async handoff(id: string): Promise<void> {
    const s = this.sessions.get(id)
    if (!s || s.kind !== 'claude' || !s.claudeSessionId) throw new Error('Nothing to hand off yet')
    const wasRunning = this.pty.has(id) || !!this.chats.get(id)?.alive
    this.pty.dispose(id)
    this.chats.get(id)?.removeAllListeners().kill()
    await new Promise((r) => setTimeout(r, 600)) // let Windows release file handles
    try {
      if (s.worktreeId) {
        const repo = await handoffToLocal(s.worktreeId)
        copyTranscriptTo(s.claudeSessionId, repo)
        const prev = s.worktreeId
        s.cwd = repo
        s.worktreeId = undefined
        updateChat(s.claudeSessionId, { worktreeId: prev, cwd: repo })
        toast('Handed off to your local checkout', 'success')
      } else {
        const chat = getChat(s.claudeSessionId)
        const rec = await handoffToWorktree(s.cwd, getWorktree(chat?.worktreeId))
        copyTranscriptTo(s.claudeSessionId, rec.path)
        s.cwd = rec.path
        s.worktreeId = rec.id
        touchWorktree(rec.id, { chatId: s.claudeSessionId })
        updateChat(s.claudeSessionId, { worktreeId: rec.id, cwd: rec.path })
        toast('Handed off to a background worktree', 'success')
      }
    } finally {
      s.root = (await toplevel(s.cwd)) ?? s.cwd
      s.branch = await currentBranch(s.root)
      if (s.meshGroup) {
        const g = await this.mesh.groupFor(s.cwd, s.root)
        s.meshGroup = g.key
      }
      if (!wasRunning) toast('Session restarted in its new location', 'info')
      await this.restart(id)
    }
  }

  // ---------------- goals ----------------
  setGoal(id: string, text: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    const now = Date.now()
    s.goal = { text, status: 'active', iterations: 0, maxIterations: settings().goalMaxIterations, startedAt: now, updatedAt: now }
    this.changed(s)
    this.sendPrompt(
      id,
      `Goal: ${text}\n\nWork on this autonomously until it is fully achieved; treat the goal text as your completion criteria and verify your work. When everything is done and verified, end your final message with the line GOAL_COMPLETE. If you are blocked and need my input, end with GOAL_BLOCKED and explain what you need.`,
      'queue'
    )
  }

  updateGoal(id: string, action: 'pause' | 'resume' | 'clear' | 'edit', text?: string): void {
    const s = this.sessions.get(id)
    if (!s?.goal) return
    const g: GoalState = s.goal
    if (action === 'clear') s.goal = undefined
    else if (action === 'pause') g.status = 'paused'
    else if (action === 'edit' && text) {
      g.text = text
      if (s.status === 'idle' && g.status === 'active') this.inject(id, `The goal was updated: ${text}\nContinue toward it. End with GOAL_COMPLETE when done.`)
    } else if (action === 'resume') {
      g.status = 'active'
      g.iterations = 0
      if (s.status === 'idle') this.inject(id, `Resume working on the goal: ${g.text}\nEnd with GOAL_COMPLETE when it is fully achieved, or GOAL_BLOCKED if you need me.`)
    }
    if (s.goal) s.goal.updatedAt = Date.now()
    this.changed(s)
  }

  private goalOnStop(s: SessionInfo, p: HookPayload): HookResult | undefined {
    const g = s.goal
    if (!g || g.status !== 'active') return undefined
    const last = p.last_assistant_message ?? ''
    if (/GOAL_COMPLETE/.test(last)) {
      g.status = 'done'
      notify('goal', s, `Goal complete · ${s.name}`, g.text)
      return undefined
    }
    if (/GOAL_BLOCKED/.test(last)) {
      g.status = 'blocked'
      notify('question', s, `Goal blocked · ${s.name}`, truncate(last, 200))
      return undefined
    }
    if (g.iterations >= g.maxIterations) {
      g.status = 'paused'
      notify('goal', s, `Goal paused · ${s.name}`, `Reached ${g.maxIterations} continuation turns`)
      return undefined
    }
    g.iterations++
    g.updatedAt = Date.now()
    return {
      stdout: JSON.stringify({
        decision: 'block',
        reason: `Claude Deck goal mode: keep working toward the goal "${g.text}" (continuation ${g.iterations}/${g.maxIterations}). If it is fully achieved and verified, say so and end with GOAL_COMPLETE. If you need the user, end with GOAL_BLOCKED.`
      })
    }
  }

  // ---------------- hooks ----------------
  async handleHook(sid: string, p: HookPayload): Promise<HookResult> {
    const s = this.sessions.get(sid)
    if (!s) return {}
    const ev = p.hook_event_name ?? ''
    if (p.session_id && p.session_id !== s.claudeSessionId) {
      s.claudeSessionId = p.session_id
      this.recordChat(s)
    }
    if (p.transcript_path) s.transcriptPath = p.transcript_path
    if (p.permission_mode) s.permissionMode = p.permission_mode
    s.lastActivity = Date.now()
    let result: HookResult = {}
    switch (ev) {
      case 'SessionStart': {
        if (s.status === 'starting') s.status = s.launch.initialPrompt ? 'working' : 'idle'
        result = ctxOut('SessionStart', this.mesh.contextForPrompt(s, true))
        break
      }
      case 'UserPromptSubmit': {
        s.status = 'working'
        s.attention = undefined
        // Injected mesh/scheduler prompts aren't the session's "task".
        const human = !!p.prompt && !/^\[(Claude Deck|Scheduled)/.test(p.prompt)
        if (human) s.lastPrompt = p.prompt
        s.turnFiles = new Set()
        if (s.claudeSessionId && human) updateChat(s.claudeSessionId, { lastPrompt: truncate(p.prompt ?? '', 300), updatedAt: Date.now() })
        void snapshot(s.root).then((sha) => {
          if (sha) s.turnSnapshot = sha
        })
        if (human) pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'prompt', text: truncate(p.prompt ?? '', 300), group: s.meshGroup })
        result = ctxOut('UserPromptSubmit', this.mesh.contextForPrompt(s, false))
        break
      }
      case 'PreToolUse': {
        s.status = 'working'
        const fp = (p.tool_input?.file_path ?? p.tool_input?.notebook_path) as string | undefined
        const d = this.mesh.checkEdit(s, p.tool_name ?? '', fp)
        if (d) {
          pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'permission', text: d.reason, group: s.meshGroup })
          result = { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } }) }
        }
        break
      }
      case 'PostToolUse': {
        if (s.status === 'needs-input' || s.status === 'idle') s.status = 'working'
        s.attention = undefined
        const tool = p.tool_name ?? ''
        const fp = (p.tool_input?.file_path ?? p.tool_input?.notebook_path) as string | undefined
        if (EDIT_TOOLS.has(tool) && fp) {
          const abs = path.resolve(s.cwd, fp)
          s.files = [abs, ...s.files.filter((f) => f !== abs)].slice(0, 200)
          s.turnFiles?.add(abs)
          this.mesh.recordEdit(s, tool, fp)
          broadcast('session:fileTouched', { id: s.id, path: abs, tool })
        } else if (tool === 'Read' && fp) this.mesh.recordRead(s, fp)
        else if (tool === 'Bash' || tool === 'PowerShell') {
          const cmd = String(p.tool_input?.command ?? '')
          if (cmd) pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'tool', text: `$ ${truncate(cmd, 160)}`, group: s.meshGroup })
        }
        result = ctxOut('PostToolUse', this.mesh.contextForTool(s))
        break
      }
      case 'Notification': {
        const msg = p.message ?? ''
        const type = p.notification_type ?? ''
        if (type === 'permission_prompt' || /permission/i.test(msg)) {
          s.status = 'needs-input'
          s.attention = msg
          notify('permission', s, `${s.name} needs permission`, msg)
          pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'permission', text: msg, group: s.meshGroup })
        } else if (type === 'idle_prompt' || /waiting for your input/i.test(msg)) {
          // Claude's own idle reminder; status already reflects it.
        } else if (msg) {
          s.attention = msg
          s.status = 'needs-input'
          notify('question', s, `${s.name} needs you`, msg)
        }
        break
      }
      case 'Stop': {
        s.lastAssistant = p.last_assistant_message
        const goal = this.goalOnStop(s, p)
        if (goal) {
          result = goal
          break
        }
        const meshReason = this.mesh.stopReason(s)
        if (meshReason && !p.stop_hook_active) {
          result = { stdout: JSON.stringify({ decision: 'block', reason: meshReason }) }
          break
        }
        s.status = 'idle'
        s.attention = undefined
        if (!this.isActive(s)) s.unread = true
        const usage = sessionUsage(s.transcriptPath)
        if (usage) (s as { contextTokens?: number }).contextTokens = usage.context
        notify('turn', s, `${s.name} is ready`, s.lastAssistant || 'Turn complete')
        pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'stop', text: truncate(s.lastAssistant ?? 'Turn complete', 240), group: s.meshGroup })
        this.nudgeReviewers(s)
        this.mesh.onStatus(s)
        const sx = this.sessions.get(s.id) as { queued?: string[] } | undefined
        if (sx?.queued?.length) {
          const next = sx.queued.shift()!
          setTimeout(() => this.inject(s.id, next), 350)
        }
        this.emit('idle', s)
        break
      }
    }
    this.changed(s)
    return result
  }

  /** Pair mode: when a driver finishes a turn that changed files, ask reviewers to look. */
  private nudgeReviewers(s: SessionInfo & { turnFiles?: Set<string> }): void {
    if (s.role === 'reviewer' || !s.turnFiles?.size) return
    const reviewers = this.mesh.peersOf(s).filter((p) => p.role === 'reviewer')
    if (!reviewers.length || !s.meshGroup) return
    const recent = (this.reviewNudges.get(s.id) ?? []).filter((t) => Date.now() - t < 30 * 60_000)
    if (recent.length >= 6) return
    recent.push(Date.now())
    this.reviewNudges.set(s.id, recent)
    const files = [...s.turnFiles].map((f) => path.relative(s.root, f) || f)
    for (const r of reviewers)
      this.mesh.callTool(s, 'mesh_send', { to: r.name, kind: 'request', text: `I just finished a turn that changed: ${files.join(', ')}. Please review these changes (git diff) and send me feedback, or an approval if they look good.` })
  }

  // ---------------- persistence ----------------
  saveOpenTabs(tabs: { sessionIds: string[] }[]): void {
    updateState((st) => {
      st.openTabs = tabs
        .map((t) => ({
          sessions: t.sessionIds
            .map((id) => this.sessions.get(id))
            .filter((s): s is SessionInfo => !!s && s.kind === 'claude' && !s.temporary && !s.launch.quick)
            .map((s) => ({ claudeSessionId: s.claudeSessionId, cwd: s.cwd, name: s.name, role: s.role }))
        }))
        .filter((t) => t.sessions.length)
    })
  }

  savedTabs() {
    return state().openTabs
  }

  focus(id: string): void {
    focusSession(id)
  }

  emitLibrary(): void {
    emitLibrary()
  }
}
