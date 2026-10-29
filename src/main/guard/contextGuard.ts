import type { ProviderId } from '@shared/agent'
import { costOf, type UsageRecord } from '@shared/pricing'
import type { GuardLevel, GuardSettings, GuardSnapshot, SessionGuardState } from '@shared/types'

// The agent CLIs re-send a conversation's whole history on every turn and every tool step, so cost
// grows with context size × request rate. The guard watches both per session (from the transcript's
// usage records) and spend across all sessions, and decides when to compact, rotate to a fresh
// session, or stop automatic continuations (goal mode, mesh wakes, automations).

export interface HourSample {
  ts: number
  usd: number
}

export interface GuardDeps {
  settings: () => GuardSettings
  read: (provider: ProviderId | undefined, transcriptPath: string, offset: number | undefined) => { records: UsageRecord[]; offset: number } | undefined
  now?: () => number
  /** The rolling-hour samples changed (persist them). */
  persist?: (hour: HourSample[]) => void
  /** Something the UI shows changed. */
  changed?: () => void
}

export type GuardAction = 'none' | 'compact' | 'rotate'

interface Track {
  provider?: ProviderId
  offset?: number
  lastId?: string
  contextTokens: number
  contextWindow: number
  spendUsd: number
  /** Estimated spend since the CLI last reported its own cost. */
  estSinceReport: number
  /** The CLI's last reported (cumulative per process) cost. */
  lastReported: number
  compactions: number
  /** Set by a compaction until the next real request shows the new context size. */
  afterCompact: boolean
  /** A compaction or rotation is underway: don't ask for another. */
  busyUntil: number
  steps: number[]
  /** Extra spend allowed past the session limit (the user chose Continue). */
  allowance: number
  tripped?: string
}

const DEFAULT_WINDOW = 200_000
const HOUR = 60 * 60_000
/** Tool steps per minute that count as "fast". */
const FAST_STEPS = 6

export class ContextGuard {
  private tracks = new Map<string, Track>()
  private hour: HourSample[]
  private hourAllowance = 0
  private hourTripped?: string
  private lastTrip = 0

  constructor(
    private deps: GuardDeps,
    hour: HourSample[] = []
  ) {
    this.hour = hour.filter((h) => this.now() - h.ts < HOUR)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private track(id: string): Track {
    let t = this.tracks.get(id)
    if (!t) {
      t = { contextTokens: 0, contextWindow: 0, spendUsd: 0, estSinceReport: 0, lastReported: 0, compactions: 0, afterCompact: false, busyUntil: 0, steps: [], allowance: 0 }
      this.tracks.set(id, t)
    }
    return t
  }

  /** Read the usage written to a session's transcript since the last sample. */
  sample(id: string, provider: ProviderId | undefined, transcriptPath: string | undefined): void {
    if (!transcriptPath) return
    const t = this.track(id)
    t.provider = provider
    const r = this.deps.read(provider, transcriptPath, t.offset)
    if (!r) return
    // The first look at a transcript starts at its end: history from before isn't new spend.
    const first = t.offset === undefined
    t.offset = r.offset
    let usd = 0
    for (const rec of r.records) {
      if (rec.id && rec.id === t.lastId) continue
      t.lastId = rec.id
      usd += costOf(rec.model, rec)
      t.contextTokens = rec.context
      t.afterCompact = false
    }
    if (first && !r.records.length) return
    if (usd > 0) this.addSpend(t, usd, true)
    this.check(id)
  }

  /** The CLI's own cost report (Claude's `total_cost_usd`): corrects the estimate upward. */
  reportCost(id: string, reported: number | undefined): void {
    if (reported === undefined || !Number.isFinite(reported)) return
    const t = this.track(id)
    // Cumulative per CLI process; a smaller value means the process restarted.
    const delta = reported >= t.lastReported ? reported - t.lastReported : reported
    t.lastReported = reported
    const extra = delta - t.estSinceReport
    t.estSinceReport = 0
    if (extra > 0.0001) this.addSpend(t, extra, false)
    this.check(id)
  }

  /** Spend that isn't tied to a live session (headless jobs, automations). */
  addExternalSpend(usd: number | undefined): void {
    if (!usd || usd <= 0) return
    this.pushHour(usd)
    this.check()
  }

  private addSpend(t: Track, usd: number, estimate: boolean): void {
    t.spendUsd += usd
    if (estimate) t.estSinceReport += usd
    this.pushHour(usd)
  }

  private pushHour(usd: number): void {
    const now = this.now()
    this.hour.push({ ts: now, usd })
    this.hour = this.hour.filter((h) => now - h.ts < HOUR)
    this.deps.persist?.(this.hour)
  }

  setContextWindow(id: string, win: number | undefined): void {
    if (win && win > 0) this.track(id).contextWindow = win
  }

  /** A tool step or turn: feeds the request-rate signal. */
  step(id: string): void {
    const t = this.track(id)
    const now = this.now()
    t.steps = [...t.steps.filter((x) => now - x < 60_000), now]
  }

  hourUsd(): number {
    const now = this.now()
    return this.hour.filter((h) => now - h.ts < HOUR).reduce((a, h) => a + h.usd, 0)
  }

  /** Update the breakers; returns true when one newly tripped. */
  private check(id?: string): boolean {
    const cfg = this.deps.settings()
    let fresh = false
    const hour = this.hourUsd()
    if (hour < cfg.hourlyUsdLimit) this.hourAllowance = 0
    const hourWas = this.hourTripped
    this.hourTripped =
      cfg.enabled && cfg.hourlyUsdLimit > 0 && hour >= cfg.hourlyUsdLimit + this.hourAllowance ? `Spent ~$${hour.toFixed(2)} in the last hour (limit $${(cfg.hourlyUsdLimit + this.hourAllowance).toFixed(0)})` : undefined
    if (this.hourTripped && !hourWas) fresh = true
    if (id) {
      const t = this.track(id)
      const was = t.tripped
      const limit = cfg.sessionUsdLimit + t.allowance
      t.tripped = cfg.enabled && cfg.sessionUsdLimit > 0 && t.spendUsd >= limit ? `This session has spent ~$${t.spendUsd.toFixed(2)} (limit $${limit.toFixed(0)})` : undefined
      if (t.tripped && !was) fresh = true
    }
    this.deps.changed?.()
    if (fresh) this.lastTrip = this.now()
    return fresh
  }

  /** Whether a breaker tripped since `since` (to interrupt a runaway turn once). */
  trippedSince(since: number): boolean {
    return this.lastTrip > since
  }

  /** Why automatic continuations are stopped for this session, if they are. */
  paused(id?: string): string | undefined {
    if (!this.deps.settings().enabled) return undefined
    return (id ? this.tracks.get(id)?.tripped : undefined) ?? this.hourTripped
  }

  /** The user chose to keep going: allow another limit's worth of spend. */
  allowMore(id?: string): void {
    // The new limit is what's been spent plus one more limit's worth.
    if (id) {
      const t = this.track(id)
      if (t.tripped) t.allowance = t.spendUsd
    }
    if (this.hourTripped) this.hourAllowance = this.hourUsd()
    this.check(id)
  }

  private thresholds(t: Track): { warn: number; compact: number; rotate: number } {
    const cfg = this.deps.settings()
    const win = t.contextWindow || DEFAULT_WINDOW
    const cap = cfg.compactAtTokens > 0 ? cfg.compactAtTokens : Infinity
    const scale = cap / Math.max(0.01, cfg.compactPct)
    const fast = t.steps.filter((x) => this.now() - x < 60_000).length >= FAST_STEPS
    const warn = Math.min(cfg.warnPct * win, cfg.warnPct * scale)
    // Large and fast: every step re-sends a big history, so compact at the warning size.
    const compact = fast ? warn : Math.min(cfg.compactPct * win, cap)
    return { warn, compact, rotate: Math.min(cfg.rotatePct * win, cfg.rotatePct * scale) }
  }

  level(id: string): GuardLevel {
    const t = this.tracks.get(id)
    const cfg = this.deps.settings()
    if (!t || !cfg.enabled || t.afterCompact) return 'ok'
    const th = this.thresholds(t)
    const ctx = t.contextTokens
    if (ctx >= th.rotate) return 'rotate'
    if (ctx >= th.compact) return t.compactions >= cfg.rotateAfterCompactions ? 'rotate' : 'compact'
    if (ctx >= th.warn) return 'warn'
    return 'ok'
  }

  /** What to do about the session's size now (call when its turn ends). */
  evaluate(id: string): GuardAction {
    const t = this.tracks.get(id)
    const cfg = this.deps.settings()
    if (!t || !cfg.enabled || t.busyUntil > this.now()) return 'none'
    let lv = this.level(id)
    // Compacting can't shrink this conversation enough: start fresh instead.
    if (lv === 'compact' && !cfg.autoCompact) lv = cfg.autoRotate ? 'rotate' : 'warn'
    if (lv === 'rotate' && !cfg.autoRotate) lv = cfg.autoCompact && t.compactions < cfg.rotateAfterCompactions ? 'compact' : 'warn'
    if (lv !== 'compact' && lv !== 'rotate') return 'none'
    t.busyUntil = this.now() + 3 * 60_000
    return lv
  }

  /** The agent compacted its conversation (asked for by us or on its own). */
  compacted(id: string): void {
    const t = this.track(id)
    t.compactions++
    t.afterCompact = true
    t.contextTokens = 0
    t.busyUntil = 0
    this.deps.changed?.()
  }

  /** The session continues in a fresh conversation (new transcript). */
  rotated(id: string): void {
    const t = this.track(id)
    Object.assign(t, { offset: undefined, lastId: undefined, contextTokens: 0, compactions: 0, afterCompact: false, busyUntil: 0, estSinceReport: 0, lastReported: 0 })
    this.deps.changed?.()
  }

  /** A compaction or rotation didn't happen; allow asking again. */
  actionFailed(id: string): void {
    this.track(id).busyUntil = 0
  }

  /** The CLI process restarted: its cumulative cost starts over. */
  processRestarted(id: string): void {
    const t = this.tracks.get(id)
    if (t) {
      t.lastReported = 0
      t.estSinceReport = 0
    }
  }

  forget(id: string): void {
    this.tracks.delete(id)
    this.deps.changed?.()
  }

  state(id: string): SessionGuardState | undefined {
    const t = this.tracks.get(id)
    if (!t) return undefined
    return { contextTokens: t.contextTokens, contextWindow: t.contextWindow, level: this.level(id), spendUsd: t.spendUsd, compactions: t.compactions, tripped: this.paused(id) }
  }

  snapshot(): GuardSnapshot {
    const sessions: Record<string, SessionGuardState> = {}
    for (const id of this.tracks.keys()) sessions[id] = this.state(id)!
    return { sessions, hourUsd: this.hourUsd(), tripped: this.paused() }
  }
}
