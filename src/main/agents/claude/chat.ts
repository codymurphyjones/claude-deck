import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { PermissionRequest, SlashCommandInfo } from '@shared/chat'
import type { SessionInfo } from '@shared/types'
import { LineBuffer } from '../../util'
import { ChatBase } from '../chatBase'
import type { AgentChat, PermissionDecision } from '../types'
import { buildClaudeArgs, claudeEnv } from './launch'

type Json = Record<string, unknown>

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools that ask the user something rather than for permission — never auto-answered. */
const INTERACTIVE_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

function modeAllows(mode: string, tool: string | undefined): boolean {
  if (!tool || INTERACTIVE_TOOLS.has(tool)) return false
  return mode === 'bypassPermissions' || (mode === 'acceptEdits' && EDIT_TOOLS.has(tool))
}

/**
 * One Claude Code process in headless streaming mode (`-p --input-format stream-json
 * --output-format stream-json --permission-prompt-tool stdio`), normalized into ChatItems.
 * Lifecycle events reach the app through the injected hooks, not this stream.
 */
export class ClaudeChat extends ChatBase implements AgentChat {
  private proc: ChildProcessWithoutNullStreams | undefined
  private buf = new LineBuffer()
  private stderr = ''
  private reqSeq = 0
  private pendingControl = new Map<string, (res: Json) => void>()
  private pendingPerms = new Map<string, { toolUseId: string; input: Json; suggestions?: unknown[] }>()
  private blockMap = new Map<string, string>() // `${msgId}:${index}` -> item id
  private msgItems = new Map<string, string[]>() // msgId -> item ids (text/thinking) in order
  private finalized = new Set<string>()
  private currentMsg: { id: string; parent?: string } | undefined

  constructor(
    private command: string,
    private session: SessionInfo
  ) {
    super()
  }

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed
  }

  start(): void {
    const command = this.command
    const useShell = /\.(cmd|bat)$/i.test(command)
    const args = buildClaudeArgs(this.session)
    this.proc = spawn(command, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', ...args], {
      cwd: this.session.cwd,
      env: claudeEnv(this.session),
      windowsHide: true,
      shell: useShell
    }) as ChildProcessWithoutNullStreams
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (d: string) => this.onData(d))
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-8000)
    })
    this.proc.on('exit', (code) => {
      this.flushDeltas()
      for (const p of this.pendingPerms.values()) this.patchTool(p.toolUseId, { permission: { ...(this.findTool(p.toolUseId)?.permission as PermissionRequest), status: 'denied' } })
      this.pendingPerms.clear()
      this.meta.busy = false
      this.emit('exit', code ?? 0, this.stderr.trim())
    })
    this.proc.on('error', (e) => {
      this.notice(`Could not start Claude: ${e.message}`, 'error')
      this.emit('exit', -1, e.message)
    })
    void this.control({ subtype: 'initialize' }).then((res) => {
      const cmds = (res.commands as SlashCommandInfo[] | undefined) ?? []
      this.meta.commands = cmds.map((c) => ({ name: c.name, description: c.description, argumentHint: c.argumentHint }))
      this.emitMeta()
    })
  }

  kill(): void {
    try {
      this.proc?.stdin.end()
    } catch {
      /* ignore */
    }
    const p = this.proc
    setTimeout(() => {
      if (p && p.exitCode === null) p.kill()
    }, 1500)
  }

  // ------------------------------------------------------------------ outgoing
  private write(obj: Json): void {
    if (!this.alive) return
    this.proc!.stdin.write(JSON.stringify(obj) + '\n')
  }

  private control(request: Json): Promise<Json> {
    const id = `deck-${++this.reqSeq}`
    return new Promise((resolve) => {
      this.pendingControl.set(id, resolve)
      this.write({ type: 'control_request', request_id: id, request })
      setTimeout(() => {
        if (this.pendingControl.delete(id)) resolve({})
      }, 30_000)
    })
  }

  /** Send a user message. While a turn is running the CLI queues it. */
  send(text: string, opts: { images?: { mediaType: string; data: string }[]; injected?: boolean } = {}): boolean {
    if (!this.alive) return false
    const queued = this.meta.busy
    this.op({
      op: 'append',
      item: { kind: 'user', id: this.nid('u'), ts: Date.now(), text, images: opts.images?.map((i) => `data:${i.mediaType};base64,${i.data}`), queued, injected: opts.injected }
    })
    const content = opts.images?.length
      ? [...opts.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mediaType, data: i.data } })), { type: 'text', text }]
      : text
    this.write({ type: 'user', message: { role: 'user', content } })
    if (!this.meta.busy) {
      this.meta.busy = true
      this.turnStart = Date.now()
      this.emit('status', 'working')
    } else this.meta.queued++
    this.emitMeta()
    return true
  }

  interrupt(): void {
    void this.control({ subtype: 'interrupt' })
  }

  /** Summarize the conversation in place (the CLI's /compact; queued if a turn is running). */
  compact(): boolean {
    return this.send('/compact', { injected: true })
  }

  /** Switch modes live; prompts already waiting that the new mode would allow are approved on the spot. */
  async setPermissionMode(mode: string): Promise<Json> {
    const res = await this.control({ subtype: 'set_permission_mode', mode })
    if (res.error) throw new Error(String(res.error))
    for (const [requestId, p] of [...this.pendingPerms]) if (modeAllows(mode, this.findTool(p.toolUseId)?.name)) this.respondPermission(requestId, { allow: true })
    return res
  }

  setModel(model: string): Promise<Json> {
    return this.control({ subtype: 'set_model', model: model || undefined })
  }

  respondPermission(requestId: string, d: PermissionDecision): void {
    const p = this.pendingPerms.get(requestId)
    if (!p) return
    this.pendingPerms.delete(requestId)
    const response = d.allow
      ? { behavior: 'allow', updatedInput: d.updatedInput ?? p.input, ...(d.always && p.suggestions?.length ? { updatedPermissions: p.suggestions } : {}) }
      : { behavior: 'deny', message: d.message || 'The user denied this action.' }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    const tool = this.findTool(p.toolUseId)
    if (tool?.permission) this.patchTool(p.toolUseId, { permission: { ...tool.permission, status: d.allow ? 'allowed' : 'denied', decidedAt: Date.now() }, ...(d.allow ? {} : { status: 'denied' as const }) })
    if (!this.pendingPerms.size && this.meta.busy) this.emit('status', 'working')
  }

  hasPendingPermission(): boolean {
    return this.pendingPerms.size > 0
  }

  // ------------------------------------------------------------------ incoming
  private onData(d: string): void {
    this.buf.push(d, (raw) => {
      const line = raw.trim()
      if (!line) return
      let j: Json
      try {
        j = JSON.parse(line)
      } catch {
        return
      }
      try {
        this.handle(j)
      } catch (e) {
        this.notice(`Display error: ${(e as Error).message}`, 'warn')
      }
    })
  }

  private handle(j: Json): void {
    const parent = (j.parent_tool_use_id as string | null) ?? undefined
    switch (j.type) {
      case 'system':
        return this.handleSystem(j)
      case 'stream_event':
        return this.handleStream(j.event as Json, parent)
      case 'assistant':
        return this.handleAssistant(j.message as Json, parent)
      case 'user':
        return this.handleUserEcho(j.message as Json)
      case 'control_request':
        return this.handleControlRequest(j.request_id as string, j.request as Json)
      case 'control_response': {
        const r = j.response as Json
        const cb = this.pendingControl.get(r.request_id as string)
        if (cb) {
          this.pendingControl.delete(r.request_id as string)
          cb(r.subtype === 'error' ? { error: r.error ?? 'Request failed' } : ((r.response as Json) ?? {}))
        }
        return
      }
      case 'result':
        return this.handleResult(j)
    }
  }

  private handleSystem(j: Json): void {
    switch (j.subtype) {
      case 'init':
        this.meta.model = j.model as string
        this.meta.tools = (j.tools as string[]) ?? []
        if (j.session_id) this.emit('session', j.session_id)
        this.emitMeta()
        return
      case 'compact_boundary':
        this.notice('Conversation compacted to free up context.')
        this.emit('compacted')
        return
      case 'api_retry':
        this.notice(`Retrying the API request${j.attempt ? ` (attempt ${j.attempt})` : ''}…`, 'warn')
        return
      case 'permission_denied': {
        const id = j.tool_use_id as string
        if (id) this.patchTool(id, { status: 'denied', result: (j.message as string) ?? 'Permission denied' })
        return
      }
    }
  }

  private handleStream(ev: Json, parent?: string): void {
    switch (ev.type) {
      case 'message_start': {
        const msg = ev.message as Json
        this.currentMsg = { id: msg.id as string, parent }
        // Anything queued has now been picked up.
        if (this.meta.queued) {
          for (const it of this.items) if (it.kind === 'user' && it.queued) this.op({ op: 'patch', id: it.id, patch: { queued: false } })
          this.meta.queued = 0
          this.emitMeta()
        }
        return
      }
      case 'content_block_start': {
        if (!this.currentMsg) return
        const cb = ev.content_block as Json
        const key = `${this.currentMsg.id}:${ev.index}`
        const p = this.currentMsg.parent
        if (cb.type === 'text') {
          const id = this.nid('t')
          this.blockMap.set(key, id)
          this.trackMsg(this.currentMsg.id, id)
          this.op({ op: 'append', item: { kind: 'text', id, ts: Date.now(), text: (cb.text as string) ?? '', streaming: true, parent: p } })
        } else if (cb.type === 'thinking') {
          const id = this.nid('k')
          this.blockMap.set(key, id)
          this.trackMsg(this.currentMsg.id, id)
          this.op({ op: 'append', item: { kind: 'thinking', id, ts: Date.now(), text: (cb.thinking as string) ?? '', streaming: true, parent: p } })
        } else if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          const id = cb.id as string
          this.blockMap.set(key, id)
          if (!this.findTool(id))
            this.op({ op: 'append', item: { kind: 'tool', id, ts: Date.now(), name: cb.name as string, input: {}, partialInput: '', status: 'streaming', parent: p } })
        }
        return
      }
      case 'content_block_delta': {
        if (!this.currentMsg) return
        const id = this.blockMap.get(`${this.currentMsg.id}:${ev.index}`)
        if (!id) return
        const dl = ev.delta as Json
        if (dl.type === 'text_delta') this.delta(id, 'text', dl.text as string)
        else if (dl.type === 'thinking_delta') this.delta(id, 'text', dl.thinking as string)
        else if (dl.type === 'input_json_delta') this.delta(id, 'partialInput', dl.partial_json as string)
        return
      }
      case 'content_block_stop': {
        if (!this.currentMsg) return
        const id = this.blockMap.get(`${this.currentMsg.id}:${ev.index}`)
        if (!id) return
        this.flushDeltas()
        const it = this.items.find((x) => x.id === id)
        if (it && (it.kind === 'text' || it.kind === 'thinking')) this.op({ op: 'patch', id, patch: { streaming: false } })
        else if (it && it.kind === 'tool' && it.status === 'streaming') {
          let input: Json = it.input
          try {
            if (it.partialInput) input = JSON.parse(it.partialInput)
          } catch {
            /* final assistant message will carry the input */
          }
          this.op({ op: 'patch', id, patch: { status: 'running', input, partialInput: undefined } })
        }
        return
      }
    }
  }

  private trackMsg(msgId: string, itemId: string): void {
    const list = this.msgItems.get(msgId) ?? []
    list.push(itemId)
    this.msgItems.set(msgId, list)
  }

  /** Complete assistant messages: authoritative content (and the only source when not streamed, e.g. subagents). */
  private handleAssistant(msg: Json, parent?: string): void {
    const msgId = msg.id as string
    const content = (msg.content as Json[]) ?? []
    for (const c of content) {
      if (c.type === 'tool_use' || c.type === 'server_tool_use') {
        const id = c.id as string
        const existing = this.findTool(id)
        if (existing) this.op({ op: 'patch', id, patch: { input: (c.input as Json) ?? {}, partialInput: undefined, status: existing.status === 'streaming' ? 'running' : existing.status } })
        else this.op({ op: 'append', item: { kind: 'tool', id, ts: Date.now(), name: c.name as string, input: (c.input as Json) ?? {}, status: 'running', parent } })
        continue
      }
      if (c.type !== 'text' && c.type !== 'thinking') continue
      const kind = c.type === 'text' ? 'text' : 'thinking'
      const text = (kind === 'text' ? c.text : c.thinking) as string
      const candidates = (this.msgItems.get(msgId) ?? []).filter((id) => !this.finalized.has(id))
      const match = candidates.find((id) => this.items.find((x) => x.id === id)?.kind === kind)
      if (match) {
        this.finalized.add(match)
        this.flushDeltas()
        if (text) this.op({ op: 'patch', id: match, patch: { text, streaming: false } })
        else this.op({ op: 'patch', id: match, patch: { streaming: false } })
      } else if (text) {
        const id = this.nid(kind === 'text' ? 't' : 'k')
        this.finalized.add(id)
        this.trackMsg(msgId, id)
        this.op({ op: 'append', item: { kind, id, ts: Date.now(), text, streaming: false, parent } })
      }
    }
  }

  private handleUserEcho(msg: Json): void {
    const content = msg?.content
    if (!Array.isArray(content)) return
    for (const c of content as Json[]) {
      if (c.type !== 'tool_result') continue
      const id = c.tool_use_id as string
      const tool = this.findTool(id)
      if (!tool) continue
      let text = ''
      const images: string[] = []
      if (typeof c.content === 'string') text = c.content
      else if (Array.isArray(c.content))
        for (const part of c.content as Json[]) {
          if (part.type === 'text') text += (text ? '\n' : '') + (part.text as string)
          else if (part.type === 'image') {
            const src = part.source as Json
            if (src?.data) images.push(`data:${src.media_type};base64,${src.data}`)
          }
        }
      const denied = tool.status === 'denied'
      this.patchTool(id, {
        status: denied ? 'denied' : c.is_error ? 'error' : 'done',
        result: text.length > 60_000 ? text.slice(0, 60_000) + '\n… (truncated)' : text,
        resultImages: images.length ? images : undefined,
        endedAt: Date.now()
      })
    }
  }

  private handleControlRequest(requestId: string, req: Json): void {
    if (req.subtype !== 'can_use_tool') {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported request ${req.subtype}` } })
      return
    }
    const toolUseId = (req.tool_use_id as string) ?? `perm-${requestId}`
    const input = (req.input as Json) ?? {}
    const permission: PermissionRequest = {
      requestId,
      toolName: req.tool_name as string,
      input,
      description: req.description as string | undefined,
      suggestions: req.permission_suggestions as unknown[] | undefined,
      status: 'pending'
    }
    this.pendingPerms.set(requestId, { toolUseId, input, suggestions: permission.suggestions })
    if (this.findTool(toolUseId)) this.patchTool(toolUseId, { permission, input })
    else this.op({ op: 'append', item: { kind: 'tool', id: toolUseId, ts: Date.now(), name: req.tool_name as string, input, status: 'running', permission } })
    this.emit('status', 'needs-input', permission)
  }

  private handleResult(j: Json): void {
    this.flushDeltas()
    const usage = (j.usage as Json) ?? {}
    for (const it of this.items) if (it.kind === 'text' && it.streaming) this.op({ op: 'patch', id: it.id, patch: { streaming: false } })
    for (const it of this.items) if (it.kind === 'tool' && (it.status === 'running' || it.status === 'streaming') && !it.parent) this.op({ op: 'patch', id: it.id, patch: { status: 'done' } })
    const error = j.is_error ? String(j.result ?? j.subtype ?? 'Error') : j.subtype === 'error_during_execution' ? 'Interrupted' : undefined
    this.op({
      op: 'append',
      item: {
        kind: 'turn',
        id: this.nid('r'),
        ts: Date.now(),
        durationMs: (j.duration_ms as number) ?? Date.now() - this.turnStart,
        costUsd: j.total_cost_usd as number | undefined,
        inputTokens: ((usage.input_tokens as number) ?? 0) + ((usage.cache_creation_input_tokens as number) ?? 0) + ((usage.cache_read_input_tokens as number) ?? 0),
        outputTokens: usage.output_tokens as number | undefined,
        error
      }
    })
    // The model's context window (the composer's context meter), from the result's per-model usage.
    const win = Math.max(0, ...Object.values((j.modelUsage as Record<string, { contextWindow?: number }> | undefined) ?? {}).map((m) => Number(m.contextWindow) || 0))
    if (win > 0 && win !== this.meta.contextWindow) this.meta.contextWindow = win
    if (j.session_id) this.emit('session', j.session_id)
    if (typeof j.total_cost_usd === 'number') this.emit('cost', j.total_cost_usd)
    // A queued message starts the next turn immediately.
    if (this.meta.queued > 0) {
      this.turnStart = Date.now()
      this.emitMeta()
      this.emit('turn', j)
      return
    }
    this.meta.busy = false
    this.emitMeta()
    this.emit('turn', j)
    this.emit('status', 'idle')
  }
}
