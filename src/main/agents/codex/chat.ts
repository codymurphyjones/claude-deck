import { app } from 'electron'
import type { PermissionRequest } from '@shared/chat'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { agentEnv, meshServer, sessionBrief, sessionDirs } from '../../sessions/launch'
import { ChatBase, type ToolItem } from '../chatBase'
import type { AgentChat, PermissionDecision } from '../types'
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
  private pendingPerms = new Map<string, { rpcId: number | string; itemId: string; legacy: boolean; isCommand: boolean }>()
  private denials = new Map<string, string>()
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
    this.server.on('request', (id: number | string, method: string, params: Json) => this.handleRequest(id, method, params))
    this.server.on('exit', (code: number, stderr: string) => {
      this.flushDeltas()
      for (const p of this.pendingPerms.values()) this.decide(p.itemId, { status: 'denied' })
      this.pendingPerms.clear()
      this.meta.busy = false
      this.emit('exit', code, stderr)
    })
    this.server.start(this.command, [], { cwd: s.cwd, env: agentEnv(s) })
    this.ready = this.open().catch((e: Error) => {
      this.notice(`Could not start Codex: ${e.message}`, 'error')
      this.server.kill()
    })
  }

  private async open(): Promise<void> {
    const s = this.session
    await this.server.request('initialize', { clientInfo: { name: 'claude_deck', title: 'Claude Deck', version: app.getVersion() } })
    this.server.notify('initialized')
    const config: Json = {}
    if (settings().mesh.enabled) config['mcp_servers.deck-mesh'] = meshServer(s)
    const dirs = sessionDirs(s)
    if (dirs.length) config['sandbox_workspace_write.writable_roots'] = dirs
    if (this.effort) config.model_reasoning_effort = this.effort
    const { approvalPolicy, sandbox } = modePolicy(this.mode)
    const brief = sessionBrief(s)
    const params: Json = {
      cwd: s.cwd,
      ...(this.model ? { model: this.model } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(brief ? { developerInstructions: brief } : {}),
      ...(Object.keys(config).length ? { config } : {})
    }
    const rid = s.launch.resumeId
    const res = await this.server.request<Json>(rid ? 'thread/resume' : 'thread/start', rid ? { threadId: rid, ...params } : params)
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
      if (this.modeDirty) {
        const p = modePolicy(this.mode)
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

  async setModel(model: string): Promise<void> {
    this.model = model || undefined
    this.meta.model = this.model ?? this.meta.model
    this.emitMeta()
  }

  respondPermission(requestId: string, d: PermissionDecision): void {
    const p = this.pendingPerms.get(requestId)
    if (!p) return
    this.pendingPerms.delete(requestId)
    const decision = p.legacy ? (d.allow ? (d.always ? 'approved_for_session' : 'approved') : 'denied') : d.allow ? (d.always ? 'acceptForSession' : 'accept') : 'decline'
    this.server.respond(p.rpcId, { decision })
    this.decide(p.itemId, { status: d.allow ? 'allowed' : 'denied' })
    if (!this.pendingPerms.size && this.meta.busy) this.emit('status', 'working')
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
        const last = ((p.tokenUsage as Json | undefined)?.last as Json | undefined) ?? {}
        this.usage = { input: Number(last.inputTokens) || undefined, output: Number(last.outputTokens) || undefined }
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
    for (const t of tools)
      void this.lifecycle?.({ type: 'tool-start', toolKind: t.toolKind, name: t.name, input: t.input, sessionId: this.threadId }).then((r) => {
        if (r.deny?.decision === 'deny') this.denials.set(id, r.deny.reason)
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

  private handleRequest(rpcId: number | string, method: string, p: Json): void {
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
    const denied = this.denials.get(itemId)
    if (denied) {
      this.server.respond(rpcId, { decision: legacy ? 'denied' : 'decline' })
      this.decide(itemId, { status: 'denied' })
      this.notice(denied, 'mesh')
      return
    }
    const first = this.findTool(this.toolIds.get(itemId)![0])!
    const requestId = String(rpcId)
    const permission: PermissionRequest = { requestId, toolName: first.name, input: first.input, description: (p.reason as string | undefined) ?? undefined, sessionApproval: true, status: 'pending' }
    this.pendingPerms.set(requestId, { rpcId, itemId, legacy, isCommand })
    this.patchTool(first.id, { permission })
    // The session service notifies from this status (as for Claude's can_use_tool).
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
