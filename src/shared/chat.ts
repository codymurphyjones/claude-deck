// Structured conversation model for the native chat UI (replaces the terminal).

import type { ToolKind } from './agent'

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  description?: string
  /** Rules the CLI suggests for "always allow" (passed back as updatedPermissions). */
  suggestions?: unknown[]
  /** The agent can approve this for the rest of the session (no rule suggestions needed). */
  sessionApproval?: boolean
  status: 'pending' | 'allowed' | 'denied'
  decidedAt?: number
}

export type ChatItem =
  | { kind: 'user'; id: string; ts: number; text: string; images?: string[]; queued?: boolean; injected?: boolean }
  | { kind: 'text'; id: string; ts: number; text: string; streaming: boolean; parent?: string }
  | { kind: 'thinking'; id: string; ts: number; text: string; streaming: boolean; parent?: string }
  | {
      kind: 'tool'
      id: string
      ts: number
      /** Display name in the agent's own vocabulary. */
      name: string
      /** Normalized category (set by the adapter; derived from name when absent). */
      toolKind?: ToolKind
      input: Record<string, unknown>
      partialInput?: string
      status: 'streaming' | 'running' | 'done' | 'error' | 'denied'
      result?: string
      resultImages?: string[]
      endedAt?: number
      parent?: string
      permission?: PermissionRequest
    }
  | { kind: 'notice'; id: string; ts: number; text: string; level: 'info' | 'warn' | 'error' | 'mesh' | 'goal' }
  | {
      kind: 'turn'
      id: string
      ts: number
      durationMs?: number
      costUsd?: number
      inputTokens?: number
      outputTokens?: number
      error?: string
    }

export type ChatOp =
  | { op: 'reset'; items: ChatItem[] }
  | { op: 'append'; item: ChatItem }
  | { op: 'patch'; id: string; patch: Partial<ChatItem> }
  | { op: 'delta'; id: string; field: 'text' | 'partialInput'; text: string }
  | { op: 'remove'; id: string }

export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint?: string
}

export interface ChatMeta {
  commands: SlashCommandInfo[]
  model?: string
  tools: string[]
  busy: boolean
  queued: number
}

/** Apply an op to an item list (shared by main's log and the renderer store). */
export function applyChatOp(items: ChatItem[], op: ChatOp): ChatItem[] {
  switch (op.op) {
    case 'reset':
      return op.items
    case 'append':
      return [...items, op.item]
    case 'remove':
      return items.filter((i) => i.id !== op.id)
    case 'patch': {
      const idx = findIdx(items, op.id)
      if (idx < 0) return items
      const next = items.slice()
      next[idx] = { ...next[idx], ...op.patch } as ChatItem
      return next
    }
    case 'delta': {
      const idx = findIdx(items, op.id)
      if (idx < 0) return items
      const next = items.slice()
      const it = next[idx] as ChatItem & { text?: string; partialInput?: string }
      next[idx] = { ...it, [op.field]: (it[op.field] ?? '') + op.text } as ChatItem
      return next
    }
  }
}

function findIdx(items: ChatItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].id === id) return i
  return -1
}

/** Plain-text rendering of a conversation tail (for read_terminal / peers). */
export function chatToText(items: ChatItem[], maxItems = 40): string {
  return items
    .slice(-maxItems)
    .map((i) => {
      if (i.kind === 'user') return `> USER: ${i.text}`
      if (i.kind === 'text') return i.text
      if (i.kind === 'tool') return `[tool ${i.name}${i.status !== 'done' ? ` (${i.status})` : ''}] ${summarizeInput(i.name, i.input)}${i.result ? `\n${i.result.slice(0, 600)}` : ''}`
      if (i.kind === 'notice') return `(${i.text})`
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export function summarizeInput(name: string, input: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return s(input.file_path)
    case 'NotebookEdit':
      return s(input.notebook_path)
    case 'Bash':
    case 'PowerShell':
      return s(input.description) || s(input.command)
    case 'Grep':
      return `${s(input.pattern)}${input.path ? ` in ${s(input.path)}` : ''}`
    case 'Glob':
      return s(input.pattern)
    case 'WebFetch':
      return s(input.url)
    case 'WebSearch':
      return s(input.query)
    case 'Task':
      return s(input.description) || s(input.prompt).slice(0, 80)
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined
      return first ? first.slice(0, 120) : ''
    }
  }
}
