// Map Codex tool activity onto the app's normalized tool items (the card vocabulary the
// renderer already knows: Bash/PowerShell, Write, Edit/MultiEdit, WebSearch, mcp__*).

import type { ToolKind } from '@shared/agent'

export interface NormalizedTool {
  name: string
  toolKind: ToolKind
  input: Record<string, unknown>
}

const SHELLS = /^(bash|sh|zsh|cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?)$/i

/** `["bash","-lc","ls -la"]` → `ls -la`; strings pass through. */
export function shellText(command: unknown): string {
  if (typeof command === 'string') return command
  if (!Array.isArray(command)) return ''
  const parts = command.map(String)
  const exe = (parts[0] ?? '').split(/[\\/]/).pop() ?? ''
  if (SHELLS.test(exe) && parts.length >= 3 && /^(-lc|-c|\/c|-Command|-NoProfile)$/i.test(parts[parts.length - 2])) return parts[parts.length - 1]
  return parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

export function shellTool(command: unknown, cwd?: string): NormalizedTool {
  const text = shellText(command)
  const ps = Array.isArray(command) && /powershell|pwsh/i.test(String(command[0] ?? ''))
  return { name: ps ? 'PowerShell' : 'Bash', toolKind: 'shell', input: { command: text, ...(cwd ? { cwd } : {}) } }
}

export interface FilePatch {
  path: string
  kind: 'add' | 'delete' | 'update'
  movePath?: string
  /** Hunks as old/new text (context lines appear in both). */
  hunks: { old: string; new: string }[]
}

function hunksFromLines(lines: string[]): { old: string; new: string }[] {
  const hunks: { old: string; new: string }[] = []
  let o: string[] = []
  let n: string[] = []
  const flush = (): void => {
    if (o.length || n.length) hunks.push({ old: o.join('\n'), new: n.join('\n') })
    o = []
    n = []
  }
  for (const l of lines) {
    if (l.startsWith('@@')) flush()
    else if (l.startsWith('-')) o.push(l.slice(1))
    else if (l.startsWith('+')) n.push(l.slice(1))
    else if (l.startsWith(' ')) {
      o.push(l.slice(1))
      n.push(l.slice(1))
    } else if (l === '') {
      o.push('')
      n.push('')
    }
  }
  flush()
  return hunks
}

/** Codex's apply_patch envelope (`*** Begin Patch` … `*** End Patch`). */
export function parseApplyPatch(text: string): FilePatch[] {
  const out: FilePatch[] = []
  let cur: { patch: FilePatch; lines: string[] } | undefined
  const close = (): void => {
    if (!cur) return
    cur.patch.hunks = cur.patch.kind === 'add' ? [{ old: '', new: cur.lines.map((l) => l.replace(/^\+/, '')).join('\n') }] : hunksFromLines(cur.lines)
    out.push(cur.patch)
    cur = undefined
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (m) {
      close()
      cur = { patch: { path: m[2].trim(), kind: m[1].toLowerCase() as FilePatch['kind'], hunks: [] }, lines: [] }
      continue
    }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line)
    if (mv && cur) {
      cur.patch.movePath = mv[1].trim()
      continue
    }
    if (line.startsWith('*** ')) continue
    cur?.lines.push(line)
  }
  close()
  return out
}

/** A unified diff for one file (app-server fileChange). */
export function parseUnifiedDiff(path: string, kind: FilePatch['kind'], diff: string): FilePatch {
  const lines = diff.split(/\r?\n/).filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('diff ') && !l.startsWith('index '))
  if (kind === 'add' && !lines.some((l) => l.startsWith('@@'))) return { path, kind, hunks: [{ old: '', new: diff }] }
  return { path, kind, hunks: hunksFromLines(lines) }
}

/** One card per file: Write for new files, Edit/MultiEdit (rendered as diffs) otherwise. */
export function patchTool(p: FilePatch): NormalizedTool {
  const file_path = p.movePath ?? p.path
  if (p.kind === 'add') return { name: 'Write', toolKind: 'write', input: { file_path, content: p.hunks.map((h) => h.new).join('\n') } }
  if (p.hunks.length <= 1) return { name: 'Edit', toolKind: 'edit', input: { file_path, old_string: p.hunks[0]?.old ?? '', new_string: p.hunks[0]?.new ?? '' } }
  return { name: 'MultiEdit', toolKind: 'edit', input: { file_path, edits: p.hunks.map((h) => ({ old_string: h.old, new_string: h.new })) } }
}

export function mcpTool(server: string, tool: string, args: unknown): NormalizedTool {
  return { name: `mcp__${server}__${tool}`, toolKind: 'mcp', input: args && typeof args === 'object' ? (args as Record<string, unknown>) : {} }
}

export const webSearchTool = (query: unknown): NormalizedTool => ({ name: 'WebSearch', toolKind: 'web', input: { query: String(query ?? '') } })

/** Text out of an MCP result (`{ content: [{ type: 'text', text }] }`) or plain value. */
export function resultText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  const content = (v as { content?: unknown }).content
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
  return JSON.stringify(v, null, 2)
}

/** Codex wraps human prompts with context blocks; those aren't the user's words. */
export const isContextBlock = (t: string): boolean => {
  const s = t.trim()
  return !s || s.startsWith('<environment_context>') || s.startsWith('<user_instructions>') || s.startsWith('# AGENTS.md') || s.startsWith('<turn_aborted>')
}
