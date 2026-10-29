import * as fs from 'fs'
import * as path from 'path'
import type { ProviderId, TokenUsage } from '@shared/agent'
import type { ChatItem } from '@shared/chat'
import type { Insights, TranscriptSummary } from '@shared/types'
import { adapter, allAdapters } from '../agents/registry'
import type { AgentAdapter, TranscriptDigest } from '../agents/types'
import { runtime } from '../runtime'
import { JsonStore } from '../store'

// History across every agent: each adapter knows its own transcript format; this module
// caches the normalized summaries and answers listing, search and insights over all of them.

interface CacheEntry extends TranscriptDigest {
  mtime: number
  size: number
}

let cache: JsonStore<{ entries: Record<string, CacheEntry> }> | undefined
const getCache = () =>
  (cache ??= new JsonStore(path.join(runtime.userData, 'transcript-cache-v2.json'), { entries: {} as Record<string, CacheEntry> }))

function allFiles(): { a: AgentAdapter; file: string; mtimeMs: number; size: number }[] {
  return allAdapters().flatMap((a) => a.history.files().map((f) => ({ a, ...f })))
}

/** Summaries of every transcript on disk (all providers), cached by mtime/size. */
export async function listTranscripts(limit = 400): Promise<TranscriptSummary[]> {
  const c = getCache()
  const files = allFiles().sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, limit)
  const out: CacheEntry[] = []
  let dirty = false
  for (const { a, file, mtimeMs, size } of files) {
    let e = c.data.entries[file]
    if (!e || e.mtime !== mtimeMs || e.size !== size) {
      try {
        e = { ...a.history.summarize(file), mtime: mtimeMs, size }
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
export async function searchTranscripts(query: string, limit = 40): Promise<{ agentSessionId: string; provider: ProviderId; snippet: string }[]> {
  const q = query.toLowerCase().trim()
  if (q.length < 2) return []
  const results: { agentSessionId: string; provider: ProviderId; snippet: string }[] = []
  const files = allFiles().sort((x, y) => y.mtimeMs - x.mtimeMs).slice(0, 500)
  for (const { a, file } of files) {
    let data: string
    try {
      data = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!data.toLowerCase().includes(q)) continue
    const snippet = a.history.snippet(data, q)
    if (snippet) results.push({ agentSessionId: a.history.idOf(file), provider: a.id, snippet })
    if (results.length >= limit) break
    await new Promise((r) => setImmediate(r))
  }
  return results
}

/** Which agent wrote a session id's transcript. */
export const ownerOf = (id: string): ProviderId | undefined => allAdapters().find((a) => a.history.find(id))?.id

export const findTranscript =(provider: ProviderId | undefined, id: string): string | undefined => adapter(provider ?? 'claude').history.find(id)

export const loadConversation = (provider: ProviderId | undefined, id: string): ChatItem[] => adapter(provider ?? 'claude').history.load(id)

/** Make a session resumable from another folder (handoff between local and worktree). */
export const prepareResume = (provider: ProviderId | undefined, id: string, cwd: string): void => adapter(provider ?? 'claude').history.prepareResume(id, cwd)

/** Context usage for a live session. */
export const sessionUsage = (provider: ProviderId | undefined, transcriptPath: string | undefined): TokenUsage | undefined =>
  adapter(provider ?? 'claude').history.usage(transcriptPath)

/** API requests recorded in a live session's transcript since `offset`. */
export const sessionUsageSince = (provider: ProviderId | undefined, transcriptPath: string, offset: number | undefined) =>
  adapter(provider ?? 'claude').history.usageSince(transcriptPath, offset)
