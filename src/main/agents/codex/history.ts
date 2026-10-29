import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TokenUsage } from '@shared/agent'
import type { UsageRecord } from '@shared/pricing'
import type { ChatItem } from '@shared/chat'
import type { AgentHistory, TranscriptDigest, TranscriptFile } from '../types'
import { readNewLines } from '../../util'
import { isContextBlock, mcpTool, parseApplyPatch, patchTool, shellTool, webSearchTool, type NormalizedTool } from './tools'

// Codex stores one "rollout" per thread: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl,
// each line `{ timestamp, type, payload }` with type session_meta | turn_context | response_item | event_msg.

type Json = Record<string, unknown>
type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function idOf(file: string): string {
  return UUID.exec(file)?.[1] ?? path.basename(file, '.jsonl')
}

function walk(dir: string, out: TranscriptFile[], depth: number): void {
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of names) {
    const full = path.join(dir, d.name)
    if (d.isDirectory() && depth < 4) walk(full, out, depth + 1)
    else if (d.isFile() && d.name.startsWith('rollout-') && d.name.endsWith('.jsonl'))
      try {
        const st = fs.statSync(full)
        out.push({ file: full, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        /* skip */
      }
  }
}

function files(): TranscriptFile[] {
  const out: TranscriptFile[] = []
  walk(path.join(codexHome(), 'sessions'), out, 0)
  return out
}

function* records(file: string): Generator<{ ts: number; type: string; payload: Json }> {
  const data = fs.readFileSync(file, 'utf8')
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    try {
      const j = JSON.parse(line) as Json
      const payload = (j.payload as Json) ?? {}
      yield { ts: typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : 0, type: String(j.type ?? ''), payload }
    } catch {
      continue
    }
  }
}

const usageTotal = (u: Json | undefined): number => (Number(u?.input_tokens) || 0) + (Number(u?.output_tokens) || 0)

function summarize(file: string): TranscriptDigest {
  const id = idOf(file)
  const e: TranscriptDigest = {
    agentSessionId: id,
    provider: 'codex',
    cwd: '',
    title: '',
    firstTs: 0,
    lastTs: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    path: file,
    longestTurnMs: 0,
    byDay: {}
  }
  let firstPrompt = ''
  let turnStart = 0
  let prevTotal = 0
  for (const r of records(file)) {
    if (r.ts) {
      if (!e.firstTs) e.firstTs = r.ts
      e.lastTs = Math.max(e.lastTs, r.ts)
    }
    const p = r.payload
    if (r.type === 'session_meta') {
      if (typeof p.cwd === 'string') e.cwd = p.cwd
      const branch = (p.git as Json | undefined)?.branch
      if (typeof branch === 'string' && branch) e.branch = branch
    } else if (r.type === 'turn_context' && typeof p.cwd === 'string' && !e.cwd) e.cwd = p.cwd
    else if (r.type === 'event_msg') {
      if (p.type === 'user_message' && typeof p.message === 'string' && !isContextBlock(p.message)) {
        e.messages++
        if (!firstPrompt) firstPrompt = p.message
        turnStart = r.ts
      } else if (p.type === 'task_complete' && turnStart && r.ts) e.longestTurnMs = Math.max(e.longestTurnMs, r.ts - turnStart)
      else if (p.type === 'token_count') {
        // Cumulative totals: count each increase once.
        const total = (p.info as Json | undefined)?.total_token_usage as Json | undefined
        if (!total) continue
        e.inputTokens = Number(total.input_tokens) || 0
        e.outputTokens = Number(total.output_tokens) || 0
        const now = usageTotal(total)
        if (r.ts && now > prevTotal) {
          const day = new Date(r.ts).toISOString().slice(0, 10)
          e.byDay[day] = (e.byDay[day] || 0) + (now - prevTotal)
        }
        prevTotal = Math.max(prevTotal, now)
      }
    }
  }
  e.title = (firstPrompt.replace(/\s+/g, ' ').slice(0, 80) || id.slice(0, 8)).trim()
  return e
}

function snippet(data: string, q: string): string | undefined {
  for (const line of data.split('\n')) {
    if (!line.includes('"user_message"') && !line.includes('"agent_message"')) continue
    try {
      const p = (JSON.parse(line) as Json).payload as Json
      const text = String(p?.message ?? '')
      const i = text.toLowerCase().indexOf(q)
      if (i >= 0) return text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' ')
    } catch {
      /* skip */
    }
  }
  return undefined
}

function find(sessionId: string): string | undefined {
  return files().find((f) => idOf(f.file) === sessionId)?.file
}

const outputText = (o: unknown): string => {
  if (typeof o === 'string') {
    // shell outputs are JSON `{ output, metadata }` in some versions.
    try {
      const j = JSON.parse(o) as Json
      if (typeof j.output === 'string') return j.output
    } catch {
      /* plain text */
    }
    return o
  }
  if (o && typeof o === 'object' && typeof (o as Json).content === 'string') return (o as Json).content as string
  return o == null ? '' : JSON.stringify(o)
}

function parseArgs(a: unknown): Json {
  if (a && typeof a === 'object') return a as Json
  try {
    return JSON.parse(String(a ?? '{}')) as Json
  } catch {
    return {}
  }
}

function toolsForCall(p: Json): NormalizedTool[] {
  const name = String(p.name ?? '')
  if (p.type === 'local_shell_call') return [shellTool((p.action as Json | undefined)?.command)]
  if (p.type === 'web_search_call') return [webSearchTool((p.action as Json | undefined)?.query)]
  if (name === 'apply_patch') {
    const text = typeof p.input === 'string' ? p.input : String(parseArgs(p.arguments).input ?? '')
    const patches = parseApplyPatch(text)
    return patches.length ? patches.map(patchTool) : [{ name: 'apply_patch', toolKind: 'edit', input: { patch: text } }]
  }
  if (name === 'shell' || name === 'shell_command' || name === 'exec_command' || name === 'container.exec') {
    const a = parseArgs(p.arguments)
    return [shellTool(a.command ?? a.cmd, a.workdir as string | undefined)]
  }
  if (name.includes('__') || name.includes('/')) {
    const [server, tool] = name.includes('__') ? name.split('__') : name.split('/')
    return [mcpTool(server, tool, parseArgs(p.arguments))]
  }
  return [{ name: name || 'tool', toolKind: 'other', input: parseArgs(p.arguments ?? p.input) }]
}

/** Rebuild chat items from a rollout (best-effort; the format is internal to Codex). */
export function loadRollout(file: string | undefined, maxItems = 1500): ChatItem[] {
  if (!file) return []
  const items: ChatItem[] = []
  const calls = new Map<string, ToolItem[]>()
  let n = 0
  try {
    for (const r of records(file)) {
      const p = r.payload
      const ts = r.ts || Date.now()
      if (r.type === 'event_msg') {
        if (p.type === 'user_message' && typeof p.message === 'string' && !isContextBlock(p.message)) {
          const images = Array.isArray(p.images) ? (p.images as unknown[]).filter((x): x is string => typeof x === 'string') : []
          items.push({ kind: 'user', id: `h${n++}`, ts, text: p.message, images: images.length ? images : undefined })
        } else if (p.type === 'task_complete') items.push({ kind: 'turn', id: `h${n++}`, ts })
        else if (p.type === 'turn_aborted') items.push({ kind: 'turn', id: `h${n++}`, ts, error: 'Interrupted' })
        continue
      }
      if (r.type !== 'response_item') continue
      if (p.type === 'message' && p.role === 'assistant') {
        const text = ((p.content as Json[]) ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join('')
        if (text.trim()) items.push({ kind: 'text', id: `h${n++}`, ts, text, streaming: false })
      } else if (p.type === 'reasoning') {
        const text = ((p.summary as Json[]) ?? []).map((c) => String(c.text ?? '')).join('\n\n')
        if (text.trim()) items.push({ kind: 'thinking', id: `h${n++}`, ts, text, streaming: false })
      } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call' || p.type === 'web_search_call') {
        const callId = String(p.call_id ?? p.id ?? `c${n}`)
        const list = toolsForCall(p).map((t, i): ToolItem => ({ kind: 'tool', id: `${callId}#${i}`, ts, name: t.name, toolKind: t.toolKind, input: t.input, status: 'done' }))
        calls.set(callId, list)
        items.push(...list)
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const list = calls.get(String(p.call_id ?? ''))
        if (!list?.length) continue
        const text = outputText(p.output)
        const failed = /^(Exit code: [1-9]|error|execution error|patch rejected)/im.test(text.slice(0, 200)) && !/Exit code: 0/.test(text.slice(0, 200))
        list[0].result = text.slice(0, 20_000)
        for (const t of list) {
          t.status = /declined|rejected by user/i.test(text.slice(0, 200)) ? 'denied' : failed ? 'error' : 'done'
          t.endedAt = ts
        }
      }
    }
  } catch {
    return items.slice(-maxItems)
  }
  return items.slice(-maxItems)
}

/** Context usage from the newest token_count event. */
function usage(rolloutPath: string | undefined): TokenUsage | undefined {
  if (!rolloutPath) return undefined
  try {
    const st = fs.statSync(rolloutPath)
    const fd = fs.openSync(rolloutPath, 'r')
    const len = Math.min(st.size, 512 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    for (const line of buf.toString('utf8').split('\n').reverse()) {
      if (!line.includes('"token_count"')) continue
      try {
        const info = ((JSON.parse(line) as Json).payload as Json)?.info as Json | undefined
        const last = info?.last_token_usage as Json | undefined
        if (last) return { context: Number(last.input_tokens) || 0, output: Number(last.output_tokens) || 0 }
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* not there yet */
  }
  return undefined
}

/** Per-request usage from rollout lines: token_count events (input includes cached input). */
export function parseUsage(lines: string[]): UsageRecord[] {
  const out: UsageRecord[] = []
  let model: string | undefined
  for (const line of lines) {
    const tc = line.includes('"turn_context"')
    if (!tc && !line.includes('"token_count"')) continue
    try {
      const j = JSON.parse(line) as Json
      const p = j.payload as Json | undefined
      if (j.type === 'turn_context') {
        if (typeof p?.model === 'string') model = p.model
        continue
      }
      const info = p?.info as Json | undefined
      const last = info?.last_token_usage as Json | undefined
      if (!last) continue
      // The same totals are re-reported (e.g. on rate-limit updates); count each request once.
      const id = String((info?.total_token_usage as Json | undefined)?.total_tokens ?? '') || undefined
      if (id && out.length && out[out.length - 1].id === id) continue
      const all = Number(last.input_tokens) || 0
      const cacheRead = Math.min(all, Number(last.cached_input_tokens) || 0)
      out.push({ id, model, input: all - cacheRead, cacheWrite: 0, cacheRead, output: Number(last.output_tokens) || 0, context: all })
    } catch {
      /* partial line */
    }
  }
  return out
}

function usageSince(rolloutPath: string, offset: number | undefined): { records: UsageRecord[]; offset: number } | undefined {
  const r = readNewLines(rolloutPath, offset)
  return r && { records: parseUsage(r.lines), offset: r.offset }
}

export const codexHistory: AgentHistory = {
  files,
  idOf,
  summarize,
  snippet,
  find,
  load: (sessionId) => loadRollout(find(sessionId)),
  usage,
  usageSince,
  // Rollouts aren't stored per folder: a thread resumes from anywhere.
  prepareResume: () => {}
}
