import { EventEmitter } from 'events'
import { toolKindOf } from '@shared/agent'
import { applyChatOp, type ChatItem, type ChatMeta, type ChatOp } from '@shared/chat'
import type { LifecycleHandler } from './types'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const DELTA_FLUSH_MS = 24

/** Item log, op emission and delta batching shared by every provider's chat. */
export abstract class ChatBase extends EventEmitter {
  items: ChatItem[] = []
  meta: ChatMeta = { commands: [], tools: [], busy: false, queued: 0 }
  lifecycle?: LifecycleHandler
  protected seq = 0
  protected turnStart = 0
  private pendingDeltas = new Map<string, { field: 'text' | 'partialInput'; text: string }>()
  private deltaTimer: NodeJS.Timeout | undefined

  protected nid(prefix: string): string {
    return `${prefix}${++this.seq}`
  }

  op(o: ChatOp): void {
    if (o.op !== 'delta') this.flushDeltas()
    if (o.op === 'append' && o.item.kind === 'tool' && !o.item.toolKind) o = { ...o, item: { ...o.item, toolKind: toolKindOf(o.item.name) } }
    this.items = applyChatOp(this.items, o)
    if (this.items.length > 4000) this.items = this.items.slice(-3000)
    this.emit('op', o)
  }

  protected delta(id: string, field: 'text' | 'partialInput', text: string): void {
    const cur = this.pendingDeltas.get(id)
    if (cur && cur.field === field) cur.text += text
    else {
      if (cur) this.flushDeltas()
      this.pendingDeltas.set(id, { field, text })
    }
    if (!this.deltaTimer) this.deltaTimer = setTimeout(() => this.flushDeltas(), DELTA_FLUSH_MS)
  }

  protected flushDeltas(): void {
    if (this.deltaTimer) clearTimeout(this.deltaTimer)
    this.deltaTimer = undefined
    if (!this.pendingDeltas.size) return
    const all = [...this.pendingDeltas.entries()]
    this.pendingDeltas.clear()
    for (const [id, d] of all) {
      const o: ChatOp = { op: 'delta', id, field: d.field, text: d.text }
      this.items = applyChatOp(this.items, o)
      this.emit('op', o)
    }
  }

  notice(text: string, level: Extract<ChatItem, { kind: 'notice' }>['level'] = 'info'): void {
    this.op({ op: 'append', item: { kind: 'notice', id: this.nid('n'), ts: Date.now(), text, level } })
  }

  protected findTool(id: string): ToolItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.kind === 'tool' && it.id === id) return it
    }
    return undefined
  }

  protected patchTool(id: string, patch: Partial<ToolItem>): void {
    if (this.findTool(id)) this.op({ op: 'patch', id, patch })
  }

  protected emitMeta(): void {
    this.emit('meta', { ...this.meta })
  }
}
