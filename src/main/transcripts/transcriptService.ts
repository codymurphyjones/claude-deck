import * as fs from 'fs'
import * as path from 'path'
import { encodeProjectDir } from '@shared/paths'
import type { Insights, TranscriptSummary } from '@shared/types'
import { claudeHome, runtime } from '../runtime'
import { JsonStore } from '../store'

interface CacheEntry extends TranscriptSummary {
  mtime: number
  size: number
  longestTurnMs: number
  byDay: Record<string, number>
}

const projectsDir = (): string => path.join(claudeHome(), 'projects')

let cache: JsonStore<{ entries: Record<string, CacheEntry> }> | undefined
const getCache = () =>
  (cache ??= new JsonStore(path.join(runtime.userData, 'transcript-cache.json'), { entries: {} as Record<string, CacheEntry> }))

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

function summarize(file: string, st: fs.Stats): CacheEntry {
  const id = path.basename(file, '.jsonl')
  const e: CacheEntry = {
    claudeSessionId: id,
    cwd: '',
    title: '',
    firstTs: 0,
    lastTs: 0,
    messages: 0,
    inputTokens: 0,
    outputTokens: 0,
    path: file,
    mtime: st.mtimeMs,
    size: st.size,
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

function allFiles(): { file: string; st: fs.Stats }[] {
  const out: { file: string; st: fs.Stats }[] = []
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
        out.push({ file: f, st: fs.statSync(f) })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

/** Summaries of every Claude transcript on disk, cached by mtime/size. */
export async function listTranscripts(limit = 400): Promise<TranscriptSummary[]> {
  const c = getCache()
  const files = allFiles().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, limit)
  const out: CacheEntry[] = []
  let dirty = false
  for (const { file, st } of files) {
    let e = c.data.entries[file]
    if (!e || e.mtime !== st.mtimeMs || e.size !== st.size) {
      try {
        e = summarize(file, st)
      } catch {
        continue
      }
      c.data.entries[file] = e
      dirty = true
      await new Promise((r) => setImmediate(r))
    }
    out.push(e)
  }
  if (dirty) c.scheduleSave()
  return out.map(({ mtime: _m, size: _s, byDay: _b, longestTurnMs: _l, ...rest }) => rest)
}

export async function insights(): Promise<Insights> {
  await listTranscripts(5000)
  const entries = Object.values(getCache().data.entries)
  const byDay: Record<string, number> = {}
  let longest = 0
  let lifetime = 0
  for (const e of entries) {
    for (const [d, n] of Object.entries(e.byDay)) byDay[d] = (byDay[d] || 0) + n
    longest = Math.max(longest, e.longestTurnMs)
    lifetime += e.inputTokens + e.outputTokens
  }
  const days = Object.keys(byDay).sort()
  let peakDay: string | undefined
  let peak = 0
  for (const d of days)
    if (byDay[d] > peak) {
      peak = byDay[d]
      peakDay = d
    }
  // Streaks over consecutive calendar days.
  let longestStreak = 0
  let run = 0
  let prev: number | undefined
  for (const d of days) {
    const t = Date.parse(d)
    run = prev !== undefined && t - prev === 86_400_000 ? run + 1 : 1
    longestStreak = Math.max(longestStreak, run)
    prev = t
  }
  let currentStreak = 0
  const set = new Set(days)
  for (let t = Date.parse(new Date().toISOString().slice(0, 10)); set.has(new Date(t).toISOString().slice(0, 10)); t -= 86_400_000) currentStreak++
  return {
    lifetimeTokens: lifetime,
    peakDayTokens: peak,
    peakDay,
    currentStreak,
    longestStreak,
    longestSessionMs: longest,
    sessions: entries.length,
    byDay: days.slice(-120).map((day) => ({ day, tokens: byDay[day] }))
  }
}

/** Full-text search over prompts and replies. */
export async function searchTranscripts(query: string, limit = 40): Promise<{ claudeSessionId: string; snippet: string }[]> {
  const q = query.toLowerCase().trim()
  if (q.length < 2) return []
  const results: { claudeSessionId: string; snippet: string }[] = []
  const files = allFiles().sort((a, b) => b.st.mtimeMs - a.st.mtimeMs).slice(0, 500)
  for (const { file } of files) {
    let data: string
    try {
      data = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!data.toLowerCase().includes(q)) continue
    for (const line of data.split('\n')) {
      if (!line.startsWith('{"parentUuid') && !line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue
      try {
        const j = JSON.parse(line)
        if (j.type !== 'user' && j.type !== 'assistant') continue
        const text = textOf(j.message?.content)
        const i = text.toLowerCase().indexOf(q)
        if (i >= 0) {
          results.push({ claudeSessionId: path.basename(file, '.jsonl'), snippet: text.slice(Math.max(0, i - 60), i + 100).replace(/\s+/g, ' ') })
          break
        }
      } catch {
        /* skip */
      }
    }
    if (results.length >= limit) break
    await new Promise((r) => setImmediate(r))
  }
  return results
}

export function findTranscript(claudeSessionId: string): string | undefined {
  for (const { file } of allFiles()) if (path.basename(file, '.jsonl') === claudeSessionId) return file
  return undefined
}

/** Make a session resumable from another folder (handoff between local and worktree). */
export function copyTranscriptTo(claudeSessionId: string, cwd: string): void {
  const src = findTranscript(claudeSessionId)
  if (!src) return
  const destDir = path.join(projectsDir(), encodeProjectDir(cwd))
  const dest = path.join(destDir, claudeSessionId + '.jsonl')
  if (path.normalize(src).toLowerCase() === path.normalize(dest).toLowerCase()) return
  fs.mkdirSync(destDir, { recursive: true })
  fs.copyFileSync(src, dest)
}

/** Context usage for a live session: tokens in the latest request + totals. */
export function sessionUsage(transcriptPath: string | undefined): { context: number; output: number } | undefined {
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
