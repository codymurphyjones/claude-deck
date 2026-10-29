import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { TokenUsage } from '@shared/agent'
import type { UsageRecord } from '@shared/pricing'
import { encodeProjectDir } from '@shared/paths'
import type { AgentHistory, TranscriptDigest, TranscriptFile } from '../types'
import { readNewLines } from '../../util'
import { loadConversation } from './history'

/** `$CLAUDE_CONFIG_DIR`, else ~/.claude. */
export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

const projectsDir = (): string => path.join(claudeHome(), 'projects')

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((c) => (c && typeof c === 'object' && (c as { type?: string }).type === 'text' ? (c as { text: string }).text : ''))
      .join(' ')
  return ''
}

function isHumanPrompt(j: Record<string, unknown>, text: string): boolean {
  if (!text || text.startsWith('<') || text.startsWith('[Request interrupted')) return false
  return j.isMeta !== true && (j as { origin?: { kind?: string } }).origin?.kind !== 'tool'
}

export function summarize(file: string): TranscriptDigest {
  const id = path.basename(file, '.jsonl')
  const e: TranscriptDigest = {
    agentSessionId: id,
    provider: 'claude',
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
  let aiTitle = ''
  let agentName = ''
  const data = fs.readFileSync(file, 'utf8')
  for (const line of data.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request')) continue
    let j: Record<string, unknown>
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    const t = j.type
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : 0
    if (ts) {
      if (!e.firstTs) e.firstTs = ts
      e.lastTs = Math.max(e.lastTs, ts)
    }
    if (typeof j.cwd === 'string' && !e.cwd) e.cwd = j.cwd
    if (typeof j.gitBranch === 'string' && j.gitBranch) e.branch = j.gitBranch
    if (t === 'ai-title' && typeof j.aiTitle === 'string') aiTitle = j.aiTitle
    else if (t === 'agent-name' && typeof j.agentName === 'string') agentName = j.agentName
    else if (t === 'user') {
      const msg = j.message as { content?: unknown } | undefined
      const text = textOf(msg?.content).trim()
      if (isHumanPrompt(j, text)) {
        e.messages++
        if (!firstPrompt) firstPrompt = text
      }
    } else if (t === 'assistant') {
      const u = (j.message as { usage?: Record<string, number> } | undefined)?.usage
      if (u) {
        const tokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0)
        e.inputTokens += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
        e.outputTokens += u.output_tokens || 0
        if (ts) {
          const day = new Date(ts).toISOString().slice(0, 10)
          e.byDay[day] = (e.byDay[day] || 0) + tokens
        }
      }
    } else if (t === 'system' && j.subtype === 'turn_duration') {
      e.longestTurnMs = Math.max(e.longestTurnMs, Number(j.durationMs) || 0)
    }
  }
  e.title = (aiTitle || agentName || firstPrompt.replace(/\s+/g, ' ').slice(0, 80) || id.slice(0, 8)).trim()
  return e
}

function files(): TranscriptFile[] {
  const out: TranscriptFile[] = []
  let dirs: string[] = []
  try {
    dirs = fs.readdirSync(projectsDir())
  } catch {
    return out
  }
  for (const d of dirs) {
    const full = path.join(projectsDir(), d)
    let names: string[] = []
    try {
      names = fs.readdirSync(full).filter((n) => n.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const n of names) {
      try {
        const f = path.join(full, n)
        const st = fs.statSync(f)
        out.push({ file: f, mtimeMs: st.mtimeMs, size: st.size })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

function snippet(data: string, q: string): string | undefined {
  for (const line of data.split('\n')) {
    if (!line.startsWith('{"parentUuid') && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
    try {
      const j = JSON.parse(line)
      if (j.type !== 'user' && j.type !== 'assistant') continue
      const text = textOf(j.message?.content)
      const i = text.toLowerCase().indexOf(q)
      if (i >= 0) return text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' ')
    } catch {
      /* skip */
    }
  }
  return undefined
}

function find(sessionId: string): string | undefined {
  for (const { file } of files()) if (path.basename(file, '.jsonl') === sessionId) return file
  return undefined
}

/** Make a session resumable from another folder (handoff between local and worktree). */
function prepareResume(sessionId: string, cwd: string): void {
  const src = find(sessionId)
  if (!src) return
  const destDir = path.join(projectsDir(), encodeProjectDir(cwd))
  const dest = path.join(destDir, sessionId + '.jsonl')
  if (path.normalize(src).toLowerCase() === path.normalize(dest).toLowerCase()) return
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(src, dest)
}

/** Context usage for a live session: tokens in the latest request + totals. */
function usage(transcriptPath: string | undefined): TokenUsage | undefined {
  if (!transcriptPath) return undefined
  try {
    const st = fs.statSync(transcriptPath)
    const fd = fs.openSync(transcriptPath, 'r')
    const len = Math.min(st.size, 512 * 1024)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, st.size - len)
    fs.closeSync(fd)
    const lines = buf.toString('utf8').split('\n').reverse()
    for (const line of lines) {
      if (!line.includes('"usage"')) continue
      try {
        const j = JSON.parse(line)
        const u = j.message?.usage
        if (u) return { context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0 }
      } catch {
        /* partial line */
      }
    }
  } catch {
    /* not there yet */
  }
  return undefined
}

/** Per-request usage from transcript lines (assistant messages; one line per content block, same usage). */
export function parseUsage(lines: string[]): UsageRecord[] {
  const out: UsageRecord[] = []
  for (const line of lines) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
    try {
      const j = JSON.parse(line)
      const m = j.type === 'assistant' ? j.message : undefined
      const u = m?.usage
      if (!u) continue
      const id = typeof m.id === 'string' ? m.id : undefined
      if (id && out.length && out[out.length - 1].id === id) continue
      const input = u.input_tokens || 0
      const cacheWrite = u.cache_creation_input_tokens || 0
      const cacheRead = u.cache_read_input_tokens || 0
      out.push({ id, model: m.model, input, cacheWrite, cacheRead, output: u.output_tokens || 0, context: input + cacheWrite + cacheRead })
    } catch {
      /* partial or foreign line */
    }
  }
  return out
}

function usageSince(transcriptPath: string, offset: number | undefined): { records: UsageRecord[]; offset: number } | undefined {
  const r = readNewLines(transcriptPath, offset)
  return r && { records: parseUsage(r.lines), offset: r.offset }
}

export const claudeHistory: AgentHistory = {
  files,
  idOf: (file) => path.basename(file, '.jsonl'),
  summarize,
  snippet,
  find,
  load: (sessionId) => loadConversation(find(sessionId)),
  usage,
  usageSince,
  prepareResume
}
