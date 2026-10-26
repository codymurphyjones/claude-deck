import { app } from 'electron'
import type { PermissionRequest } from '@shared/chat'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { agentEnv, meshServer, sessionBrief, sessionDirs } from '../../sessions/launch'
import { ChatBase, type ToolItem } from '../chatBase'
import type { AgentChat, LifecycleResult, PermissionDecision } from '../types'
import { pushBlockEnv } from '../../git/pushGuard'
import { AppServer } from './appServer'
import { codexHistory } from './history'
import { modePolicy } from './policy'
import { mcpTool, parseUnifiedDiff, patchTool, resultText, shellTool, webSearchTool, type FilePatch, type NormalizedTool } from './tools'

type Json = Record<string, unknown>
type Send = { text: string; images?: { mediaType: string; data: string }[]; userItemId: string; continued?: boolean }

const kindOf = (k: unknown): FilePatch['kind'] => {
  const t = typeof k === 'string' ? k : String((k as Json | undefined)?.type ?? 'update')
  return t === 'add' || t === 'delete' ? t : 'update'
}

/**
 * One Codex thread driven through `codex app-server`, normalized into ChatItems. Codex has no
 * hooks, so lifecycle events (prompt, tools, stop) are derived here from the event stream and
 * the app's responses applied: context is prepended to the next prompt, edit denials decline
 * the approval, and "keep going" results start another turn.
 */
export class CodexChat extends ChatBase implements AgentChat {
  private server = new AppServer()
  private threadId: string | undefined
  private transcriptPath: string | undefined
  private turnId: string | undefined
  private ready: Promise<void> | undefined
  private queue: Send[] = []
  private pendingContext: string[] = []
  private pendingPerms = new Map<
    string,
    {
      rpcId: number | string
      itemId: string
      legacy: boolean
      isCommand: boolean
      /** A rule Codex proposes for "always allow" (kept by Codex across sessions). */
      amendment?: unknown
      /** A question request (item/tool/requestUserInput): question text → its id. */
      questions?: { id: string; question: string }[]
    }
  >()
  /** Plan text as it streams in (item/plan/delta), per item. */
  private plans = new Map<string, string>()
  private denials = new Map<string, string>()
  /** The team edit guard's verdict per Codex item (from tool-start), awaited before an edit is approved. */
  private guards = new Map<string, Promise<LifecycleResult['deny']>>()
  private toolIds = new Map<string, string[]>() // codex item id -> tool item ids
  private outputs = new Map<string, string>()
  private model: string | undefined
  private effort: string | undefined
  private mode: string | undefined
  private modeDirty = false
  private lastText = ''
  private continued = false
  private usage: { input?: number; output?: number } = {}

  constructor(
    private command: string,
    private session: SessionInfo
  ) {
    super()
    const prov = settings().providers.codex
    this.model = session.launch.model || prov.defaultModel || undefined
    this.effort = session.launch.effort || prov.defaultEffort || undefined
    this.mode = session.launch.permissionMode || prov.defaultPermissionMode || undefined
  }

  get alive(): boolean {
    return this.server.alive
  }

  start(): void {
    const s = this.session
    this.server.on('notification', (method: string, params: Json) => {
      try {
        this.handle(method, params)
      } catch (e) {
        this.notice(`Display error: ${(e as Error).message}`, 'warn')
      }
    })
    this.server.on('request', (id: number | string, method: string, params: Json) =>
      void this.handleRequest(id, method, params).catch((e: Error) => {
        this.notice(`Approval error: ${e.message}`, 'warn')
        this.server.respondError(id, e.message)
      })
    )
    this.server.on('exit', (code: number, stderr: string) => {
      this.flushDeltas()
      for (const p of this.pendingPerms.values()) this.decide(p.itemId, { status: 'denied' })
      this.pendingPerms.clear()
      this.meta.busy = false
      this.emit('exit', code, stderr)
    })
    // A template's extra arguments: codex options (e.g. `-c key=value`, `--profile name`).
    this.server.start(this.command, s.launch.extraArgs ?? [], { cwd: s.cwd, env: agentEnv(s) })
    this.ready = this.open().catch((e: Error) => {
      this.notice(`Could not start Codex: ${e.message}`, 'error')
      this.server.kill()
    })
  }

  private async open(): Promise<void> {
    const s = this.session
    // experimentalApi: steering, questions (requestUserInput), plan mode, live settings… Older
    // app-servers ignore the capability and those calls fail softly (each has a fallback).
    await this.server.request('initialize', { clientInfo: { name: 'claude_deck', title: 'Claude Deck', version: app.getVersion() }, capabilities: { experimentalApi: true } })
    this.server.notify('initialized')
    const config: Json = {}
    if (settings().mesh.enabled) config['mcp_servers.deck-mesh'] = meshServer(s)
    const dirs = sessionDirs(s)
    if (dirs.length) config['sandbox_workspace_write.writable_roots'] = dirs
    if (this.effort) config.model_reasoning_effort = this.effort
    // In a chat's worktree, git can't push (git/pushGuard.ts). Codex filters the environment its shells
    // get (shell_environment_policy; by default it can drop names containing KEY, as GIT_CONFIG_KEY_n
    // do), so the block is also set explicitly there: `set` is applied after Codex's filtering.
    const block = pushBlockEnv(s.cwd)
    if (Object.keys(block).length) config['shell_environment_policy.set'] = block
    const { approvalPolicy, sandbox } = this.policy()
    const brief = sessionBrief(s)
    const params: Json = {
      cwd: s.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(brief ? { developerInstructions: brief } : {}),
      ...(Object.keys(config).length ? { config } : {})
    }
    // 'auto' mode: Codex's own reviewer decides approvals instead of the user. Not while the team
    // guard is on: its requests must come to the app (which answers for auto mode itself).
    if (this.mode === 'auto' && !this.guarding()) params.approvalsReviewer = 'auto_review'
    const rid = s.launch.resumeId
    // A fork continues a copy of the conversation as a new thread (side chats, fork into a worktree).
    const method = rid ? (s.launch.fork ? 'thread/fork' : 'thread/resume') : 'thread/start'
    const res = await this.server.request<Json>(method, rid ? { threadId: rid, ...params } : params)
    const thread = (res.thread as Json) ?? {}
    this.threadId = String(thread.id ?? rid ?? '')
    this.transcriptPath = typeof thread.path === 'string' ? thread.path : undefined
    this.meta.model = (res.model as string) ?? this.model
    this.emitMeta()
    if (this.threadId) this.emit('session', this.threadId)
    const r = await this.lifecycle?.({ type: 'session-start', sessionId: this.threadId, transcriptPath: this.transcriptPath })
    if (r?.context) this.pendingContext.push(r.context)
  }

  kill(): void {
    this.server.kill()
  }

  // ------------------------------------------------------------------ outgoing
  send(text: string, opts: { images?: { mediaType: string; data: string }[]; injected?: boolean } = {}): boolean {
    if (!this.alive) return false
    const queued = this.meta.busy
    const userItemId = this.nid('u')
    this.op({
      op: 'append',
      item: { kind: 'user', id: userItemId, ts: Date.now(), text, images: opts.images?.map((i) => `data:${i.mediaType};base64,${i.data}`), queued, injected: opts.injected }
    })
    const msg: Send = { text, images: opts.images, userItemId }
    if (queued) {
      // Into the running turn (`turn/steer`), as Claude takes messages mid-turn; queued for the next
      // turn when that isn't possible (no turn id yet, or an app-server without turn/steer).
      if (this.threadId && this.turnId) {
        const input: Json[] = [...(opts.images ?? []).map((i) => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` })), { type: 'text', text }]
        void this.server
          .request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input })
          .then(() => this.op({ op: 'patch', id: userItemId, patch: { queued: false } }))
          .catch(() => {
            this.queue.push(msg)
            this.meta.queued++
            this.emitMeta()
          })
        return true
      }
      this.queue.push(msg)
      this.meta.queued++
      this.emitMeta()
    } else void this.startTurn(msg)
    return true
  }

  private async startTurn(msg: Send): Promise<void> {
    this.meta.busy = true
    this.turnStart = Date.now()
    this.lastText = ''
    this.usage = {}
    this.continued = !!msg.continued
    this.emit('status', 'working')
    this.emitMeta()
    try {
      await this.ready
      if (!this.threadId) throw new Error('No Codex thread')
      const r = await this.lifecycle?.({ type: 'turn-start', prompt: msg.text, sessionId: this.threadId, transcriptPath: this.transcriptPath, permissionMode: this.mode })
      const context = [...this.pendingContext.splice(0), r?.context].filter(Boolean) as string[]
      const input: Json[] = [
        ...(context.length ? [{ type: 'text', text: context.join('\n\n') }] : []),
        ...(msg.images ?? []).map((i) => ({ type: 'image', url: `data:${i.mediaType};base64,${i.data}` })),
        { type: 'text', text: msg.text }
      ]
      const params: Json = { threadId: this.threadId, input }
      if (this.model) params.model = this.model
      if (this.effort) params.effort = this.effort
      // Plan mode: Codex's real plan mode (it plans and may ask questions; nothing is changed).
      if (this.mode === 'plan' && this.meta.model) params.collaborationMode = { mode: 'plan', settings: { model: this.meta.model, reasoning_effort: this.effort ?? null, developer_instructions: null } }
      if (this.modeDirty) {
        const p = this.policy()
        if (p.approvalPolicy) params.approvalPolicy = p.approvalPolicy
        if (p.sandboxPolicy) params.sandboxPolicy = p.sandboxPolicy
        this.modeDirty = false
      }
      const res = await this.server.request<Json>('turn/start', params)
      this.turnId = ((res.turn as Json | undefined)?.id as string) ?? this.turnId
    } catch (e) {
      this.notice((e as Error).message, 'error')
      await this.finishTurn({ status: 'failed', error: { message: (e as Error).message } })
    }
  }

  interrupt(): void {
    if (this.threadId && this.turnId) void this.server.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {})
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.mode = mode === 'default' ? undefined : mode
    this.modeDirty = true
    // The new policy only applies from the next turn; settle approvals already waiting in this one.
    for (const [requestId, p] of [...this.pendingPerms]) if (mode === 'bypassPermissions' || (mode === 'acceptEdits' && !p.isCommand)) this.respondPermission(requestId, { allow: true })
  }

/**
   * The Codex policy for the chosen mode. With team coordination on, edits must be checked against
   * peers' file claims before they happen (Claude's PreToolUse guard), so Codex asks before every edit
   * ('untrusted' does, per codex-rs core/src/safety.rs) and the app answers for the chosen mode
   * (autoAnswer): edits that pass the guard and modes that wouldn't ask are approved without a prompt.
   */
  private policy(): ReturnType<typeof modePolicy> {
    const p = modePolicy(this.mode)
    return this.guarding() ? { ...p, approvalPolicy: 'untrusted' } : p
  }

  /** Edits are checked against the team guard: team coordination on, and the chat can edit. */
  private guarding(): boolean {
    return settings().mesh.enabled && this.mode !== 'plan'
  }

  /**
   * Answer for the user when guarding, as the chosen mode would: workspace edits / auto / bypass
   * approve on their own (as without the guard); default and manual ask.
   */
  private autoApproves(isCommand: boolean): boolean {
    if (!this.guarding()) return false
    // Commands only in bypass: elsewhere one may be asking to leave the sandbox, which the mode
    // wouldn't approve on its own (Claude asks for commands in these modes too).
    if (isCommand) return this.mode === 'bypassPermissions'
    return this.mode === 'acceptEdits' || this.mode === 'auto' || this.mode === 'bypassPermissions'
  }

  async setModel(model: string): Promise<void> {
    this.model = model || undefined
    this.meta.model = this.model ?? this.meta.model
    this.emitMeta()
    // Into the running turn too (otherwise it applies from the next one).
    if (this.model && this.threadId && this.turnId) void this.server.request('turn/settings/update', { threadId: this.threadId, turnId: this.turnId, model: this.model }).catch(() => undefined)
  }

  respondPermission(requestId: string, d: PermissionDecision): void {
    const p = this.pendingPerms.get(requestId)
    if (!p) return
    this.pendingPerms.delete(requestId)
    // A question card's answers (QuestionCard sends { answers: { [question]: "a, b" } }).
    if (p.questions) {
      const given = (d.updatedInput?.answers ?? {}) as Record<string, string>
      const answers = d.allow ? Object.fromEntries(p.questions.map((q) => [q.id, { answers: given[q.question] ? [given[q.question]] : [] }])) : {}
      this.server.respond(p.rpcId, { answers })
      this.decide(p.itemId, { status: d.allow ? 'allowed' : 'denied' })
      if (!this.pendingPerms.size && this.meta.busy) this.emit('status', 'working')
      return
    }
    // "Always allow" a command: Codex's proposed rule when it offers one (it keeps it), else this session.
    const always = p.isCommand && p.amendment ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: p.amendment } } : 'acceptForSession'
    const decision = p.legacy ? (d.allow ? (d.always ? 'approved_for_session' : 'approved') : 'denied') : d.allow ? (d.always ? always : 'accept') : 'decline'
    this.server.respond(p.rpcId, { decision })
    this.decide(p.itemId, { status: d.allow ? 'allowed' : 'denied' })
    // Codex's decline carries no message: the user's feedback is sent to the agent separately.
    if (!d.allow && d.message?.trim()) this.steer(d.message.trim())
    if (!this.pendingPerms.size && this.meta.busy) this.emit('status', 'working')
  }

  /**
   * Get `text` to the agent now: into the running turn (`turn/steer`), else with the next prompt
   * (older app-servers without turn/steer, or no turn running).
   */
  private steer(text: string): void {
    const later = (): void => {
      this.pendingContext.push(text)
    }
    if (!this.threadId || !this.turnId) return later()
    this.server.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text }] }).catch(later)
  }

  hasPendingPermission(): boolean {
    return this.pendingPerms.size > 0
  }

  private decide(itemId: string, d: { status: 'allowed' | 'denied' }): void {
    for (const id of this.toolIds.get(itemId) ?? []) {
      const tool = this.findTool(id)
      if (!tool) continue
      const patch: Partial<ToolItem> = d.status === 'denied' ? { status: 'denied' } : {}
      if (tool.permission) patch.permission = { ...tool.permission, status: d.status, decidedAt: Date.now() }
      this.patchTool(id, patch)
    }
  }

  // ------------------------------------------------------------------ incoming
  private handle(method: string, p: Json): void {
    switch (method) {
      case 'turn/started': {
        this.turnId = ((p.turn as Json | undefined)?.id as string) ?? this.turnId
        return
      }
      case 'item/started':
        return this.itemStarted(p.item as Json)
      case 'item/completed':
        return this.itemCompleted(p.item as Json)
      case 'item/agentMessage/delta': {
        const id = `t-${p.itemId}`
        if (!this.items.some((x) => x.id === id)) this.op({ op: 'append', item: { kind: 'text', id, ts: Date.now(), text: '', streaming: true } })
        this.delta(id, 'text', String(p.delta ?? ''))
        return
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const id = `k-${p.itemId}`
        if (!this.items.some((x) => x.id === id)) this.op({ op: 'append', item: { kind: 'thinking', id, ts: Date.now(), text: '', streaming: true } })
        this.delta(id, 'text', String(p.delta ?? ''))
        return
      }
      case 'item/commandExecution/outputDelta': {
        const id = String(p.itemId)
        this.outputs.set(id, ((this.outputs.get(id) ?? '') + String(p.delta ?? '')).slice(-60_000))
        return
      }
      case 'thread/tokenUsage/updated': {
        const tu = (p.tokenUsage as Json | undefined) ?? {}
        const last = (tu.last as Json | undefined) ?? {}
        this.usage = { input: Number(last.inputTokens) || undefined, output: Number(last.outputTokens) || undefined }
        // The model's real context window, for the composer's context meter.
        const win = Number(tu.modelContextWindow)
        if (win > 0 && win !== this.meta.contextWindow) {
          this.meta.contextWindow = win
          this.emitMeta()
        }
        return
      }
      // Codex's to-do list for the turn, shown like Claude's TodoWrite.
      case 'turn/plan/updated': {
        const steps = Array.isArray(p.plan) ? (p.plan as Json[]) : []
        const todos = steps.map((st) => ({ content: String(st.step ?? ''), status: st.status === 'inProgress' ? 'in_progress' : String(st.status ?? 'pending') }))
        const id = `todo-${String(p.turnId ?? this.turnId ?? 'turn')}`
        const input = { todos, ...(p.explanation ? { explanation: String(p.explanation) } : {}) }
        if (this.findTool(id)) this.patchTool(id, { input })
        else this.op({ op: 'append', item: { kind: 'tool', id, ts: Date.now(), name: 'TodoWrite', toolKind: 'other', input, status: 'done' } })
        return
      }
      case 'item/plan/delta': {
        const id = String(p.itemId)
        const text = (this.plans.get(id) ?? '') + String(p.delta ?? '')
        this.plans.set(id, text)
        this.showPlan(id, text, true)
        return
      }
      case 'thread/compacted':
        return this.notice('Conversation compacted: older turns were summarized to free up context.', 'info')
      case 'model/rerouted':
        return this.notice(`Codex switched model: ${String(p.fromModel ?? '?')} → ${String(p.toModel ?? '?')}${p.reason ? ` (${String(p.reason)})` : ''}`, 'warn')
      case 'warning':
      case 'configWarning': {
        const m = (p.message ?? p.summary ?? (p.warning as Json | undefined)?.message) as string | undefined
        if (m) this.notice(String(m), 'warn')
        return
      }
      case 'turn/completed':
        void this.finishTurn((p.turn as Json) ?? {})
        return
      case 'error': {
        const err = (p.error as Json | undefined)?.message ?? p.message
        if (err) this.notice(String(err), p.willRetry ? 'warn' : 'error')
        return
      }
    }
  }

  private toolsOf(item: Json): NormalizedTool[] {
    switch (item.type) {
      case 'commandExecution':
        return [shellTool(item.command, item.cwd as string | undefined)]
      case 'fileChange':
        return ((item.changes as Json[]) ?? []).map((c) => patchTool(parseUnifiedDiff(String(c.path ?? ''), kindOf(c.kind), String(c.diff ?? ''))))
      case 'mcpToolCall':
        return [mcpTool(String(item.server ?? 'mcp'), String(item.tool ?? 'tool'), item.arguments)]
      case 'webSearch':
        return [webSearchTool(item.query)]
      // Subagents: shown like Claude's Agent tool.
      case 'collabAgentToolCall':
        return [{ name: 'Agent', toolKind: 'other', input: { description: String(item.tool ?? 'agent'), prompt: item.prompt ?? '', agents: item.receiverThreadIds ?? [], model: item.model ?? undefined } }]
      case 'subAgentActivity':
        return [{ name: 'Agent', toolKind: 'other', input: { description: `${String(item.agentPath ?? 'subagent')} ${String(item.kind ?? '')}`.trim() } }]
      default:
        return []
    }
  }

  private itemStarted(item: Json | undefined): void {
    if (!item) return
    const id = String(item.id)
    if (item.type === 'agentMessage') {
      if (!this.items.some((x) => x.id === `t-${id}`)) this.op({ op: 'append', item: { kind: 'text', id: `t-${id}`, ts: Date.now(), text: String(item.text ?? ''), streaming: true } })
      return
    }
    if (item.type === 'reasoning') {
      if (!this.items.some((x) => x.id === `k-${id}`)) this.op({ op: 'append', item: { kind: 'thinking', id: `k-${id}`, ts: Date.now(), text: '', streaming: true } })
      return
    }
    const tools = this.toolsOf(item)
    if (!tools.length || this.toolIds.has(id)) return
    const ids = tools.map((_, i) => `${id}#${i}`)
    this.toolIds.set(id, ids)
    tools.forEach((t, i) => this.op({ op: 'append', item: { kind: 'tool', id: ids[i], ts: Date.now(), name: t.name, toolKind: t.toolKind, input: t.input, status: 'running' } }))
    // The team guard's verdict (deny or ask), kept per item so an approval request waits for it.
    const verdicts = tools.map((t) => this.lifecycle?.({ type: 'tool-start', toolKind: t.toolKind, name: t.name, input: t.input, sessionId: this.threadId }).then((r) => r?.deny))
    const verdict = Promise.all(verdicts).then((all) => all.find((d) => d?.decision === 'deny') ?? all.find((d) => d?.decision === 'ask'))
    this.guards.set(id, verdict)
    void verdict.then((d) => {
      if (d?.decision === 'deny') this.denials.set(id, d.reason)
    })
  }

  private itemCompleted(item: Json | undefined): void {
    if (!item) return
    const id = String(item.id)
    if (item.type === 'agentMessage') {
      const text = String(item.text ?? '')
      this.lastText = text || this.lastText
      this.flushDeltas()
      if (this.items.some((x) => x.id === `t-${id}`)) this.op({ op: 'patch', id: `t-${id}`, patch: text ? { text, streaming: false } : { streaming: false } })
      else if (text) this.op({ op: 'append', item: { kind: 'text', id: `t-${id}`, ts: Date.now(), text, streaming: false } })
      return
    }
    if (item.type === 'plan') {
      this.plans.delete(id)
      return this.showPlan(id, String(item.text ?? ''), false)
    }
    if (item.type === 'reasoning') {
      const summary = Array.isArray(item.summary) ? (item.summary as unknown[]).map(String).join('\n\n') : ''
      this.flushDeltas()
      if (this.items.some((x) => x.id === `k-${id}`)) this.op({ op: 'patch', id: `k-${id}`, patch: summary ? { text: summary, streaming: false } : { streaming: false } })
      else if (summary) this.op({ op: 'append', item: { kind: 'thinking', id: `k-${id}`, ts: Date.now(), text: summary, streaming: false } })
      return
    }
    if (!this.toolIds.has(id)) this.itemStarted(item)
    const ids = this.toolIds.get(id) ?? []
    if (!ids.length) return
    const st = String(item.status ?? 'completed')
    const exit = item.exitCode as number | undefined
    const status: ToolItem['status'] = st === 'declined' ? 'denied' : st === 'failed' || (typeof exit === 'number' && exit !== 0) ? 'error' : 'done'
    let result: string | undefined
    if (item.type === 'commandExecution') result = String(item.aggregatedOutput ?? this.outputs.get(id) ?? '')
    else if (item.type === 'mcpToolCall') result = item.error ? String((item.error as Json).message ?? 'Error') : resultText(item.result)
    this.outputs.delete(id)
    ids.forEach((tid, i) => this.patchTool(tid, { status, endedAt: Date.now(), ...(i === 0 && result !== undefined ? { result: result.slice(0, 60_000) } : {}) }))
    for (const tid of ids) {
      const t = this.findTool(tid)
      if (t)
        void this.lifecycle?.({ type: 'tool-end', toolKind: t.toolKind ?? 'other', name: t.name, input: t.input, sessionId: this.threadId }).then((r) => {
          if (r.context) this.pendingContext.push(r.context)
        })
    }
  }

  private async handleRequest(rpcId: number | string, method: string, p: Json): Promise<void> {
    if (method === 'item/tool/requestUserInput') return this.askUser(rpcId, p)
    const legacy = method === 'execCommandApproval' || method === 'applyPatchApproval'
    if (!legacy && method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      this.server.respondError(rpcId, `Unsupported request ${method}`)
      return
    }
    const itemId = String(p.itemId ?? p.callId ?? p.call_id ?? `perm-${rpcId}`)
    const isCommand = method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval'
    if (!this.toolIds.has(itemId)) {
      const t = isCommand ? shellTool(p.command, p.cwd as string | undefined) : { name: 'apply_patch', toolKind: 'edit' as const, input: { reason: p.reason ?? '' } }
      this.toolIds.set(itemId, [`${itemId}#0`])
      this.op({ op: 'append', item: { kind: 'tool', id: `${itemId}#0`, ts: Date.now(), name: t.name, toolKind: t.toolKind, input: t.input, status: 'running' } })
    }
    // The team guard decides first (Claude's PreToolUse): wait for its verdict on this item, which may
    // still be on its way (the request can arrive right behind item/started).
    const verdict = await Promise.race([this.guards.get(itemId) ?? Promise.resolve(undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), 5000))])
    const denied = this.denials.get(itemId) ?? (verdict?.decision === 'deny' ? verdict.reason : undefined)
    if (denied) {
      this.server.respond(rpcId, { decision: legacy ? 'denied' : 'decline' })
      this.decide(itemId, { status: 'denied' })
      this.notice(denied, 'mesh')
      // Tell the agent why, as Claude's hook does.
      this.steer(`That edit was refused: ${denied}`)
      return
    }
    // Answered for the user where the chosen mode wouldn't ask (unless the guard wants a person to look).
    if (this.autoApproves(isCommand) && verdict?.decision !== 'ask') {
      this.server.respond(rpcId, { decision: legacy ? 'approved' : 'accept' })
      return
    }
    const first = this.findTool(this.toolIds.get(itemId)![0])!
    const requestId = String(rpcId)
    const permission: PermissionRequest = { requestId, toolName: first.name, input: first.input, description: (p.reason as string | undefined) ?? undefined, sessionApproval: true, status: 'pending' }
    this.pendingPerms.set(requestId, { rpcId, itemId, legacy, isCommand, amendment: p.proposedExecpolicyAmendment ?? undefined })
    this.patchTool(first.id, { permission })
    // The session service notifies from this status (as for Claude's can_use_tool).
    this.emit('status', 'needs-input', permission)
  }

/**
   * Codex asks the user questions (plan mode): shown as a question card, like Claude's
   * AskUserQuestion; the answers go back as { answers: { [questionId]: { answers: [label] } } }.
   */
/** Codex's plan (plan mode), as a plan card the user can approve to start implementing it. */
  private showPlan(itemId: string, plan: string, streaming: boolean): void {
    const id = `plan-${itemId}`
    if (this.findTool(id)) this.patchTool(id, { input: { plan }, status: streaming ? 'running' : 'done' })
    else this.op({ op: 'append', item: { kind: 'tool', id, ts: Date.now(), name: 'CodexPlan', toolKind: 'other', input: { plan }, status: streaming ? 'running' : 'done' } })
  }

  private askUser(rpcId: number | string, p: Json): void {
    const qs = Array.isArray(p.questions) ? (p.questions as Json[]) : []
    const questions = qs.map((q) => ({
      id: String(q.id ?? ''),
      header: q.header ? String(q.header) : undefined,
      question: String(q.question ?? ''),
      options: ((q.options as Json[] | null) ?? []).map((o) => ({ label: String(o.label ?? ''), description: o.description ? String(o.description) : undefined })),
      multiSelect: false
    }))
    const itemId = `q-${String(p.itemId ?? rpcId)}`
    const toolId = `${itemId}#0`
    this.toolIds.set(itemId, [toolId])
    const requestId = String(rpcId)
    const permission: PermissionRequest = { requestId, toolName: 'AskUserQuestion', input: { questions }, status: 'pending' }
    this.op({ op: 'append', item: { kind: 'tool', id: toolId, ts: Date.now(), name: 'AskUserQuestion', toolKind: 'other', input: { questions }, status: 'running', permission } })
    this.pendingPerms.set(requestId, { rpcId, itemId, legacy: false, isCommand: false, questions: questions.map((q) => ({ id: q.id, question: q.question })) })
    this.emit('status', 'needs-input', permission)
  }

  private async finishTurn(turn: Json): Promise<void> {
    this.flushDeltas()
    for (const it of this.items) if ((it.kind === 'text' || it.kind === 'thinking') && it.streaming) this.op({ op: 'patch', id: it.id, patch: { streaming: false } })
    for (const it of this.items) if (it.kind === 'tool' && (it.status === 'running' || it.status === 'streaming')) this.op({ op: 'patch', id: it.id, patch: { status: 'done' } })
    const status = String(turn.status ?? 'completed')
    const error = status === 'failed' ? String((turn.error as Json | undefined)?.message ?? 'Error') : status === 'interrupted' ? 'Interrupted' : undefined
    this.op({
      op: 'append',
      item: { kind: 'turn', id: this.nid('r'), ts: Date.now(), durationMs: Date.now() - this.turnStart, inputTokens: this.usage.input, outputTokens: this.usage.output, error }
    })
    this.turnId = undefined
    // Older app-servers don't report the rollout path; it's needed for context usage.
    if (!this.transcriptPath && this.threadId) this.transcriptPath = codexHistory.find(this.threadId)
    const r = await this.lifecycle?.({ type: 'turn-end', lastAssistantMessage: this.lastText, continued: this.continued, sessionId: this.threadId, transcriptPath: this.transcriptPath, permissionMode: this.mode })
    // The app asked the agent to keep going (goal mode, unread team messages).
    if (r?.continueWith && status === 'completed' && this.alive) {
      const userItemId = this.nid('u')
      this.op({ op: 'append', item: { kind: 'user', id: userItemId, ts: Date.now(), text: r.continueWith, injected: true } })
      return this.startTurn({ text: r.continueWith, userItemId, continued: true })
    }
    const next = this.queue.shift()
    if (next) {
      this.meta.queued = Math.max(0, this.meta.queued - 1)
      this.op({ op: 'patch', id: next.userItemId, patch: { queued: false } })
      this.emit('turn')
      return this.startTurn(next)
    }
    this.meta.busy = false
    this.emitMeta()
    this.emit('turn')
    this.emit('status', 'idle')
  }
}
