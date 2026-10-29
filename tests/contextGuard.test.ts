import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { costOf, ratesFor, type UsageRecord } from '@shared/pricing'
import type { GuardSettings } from '@shared/types'
import { ContextGuard } from '../src/main/guard/contextGuard'
import { parseUsage as parseClaude } from '../src/main/agents/claude/transcripts'
import { parseUsage as parseCodex } from '../src/main/agents/codex/history'
import { readNewLines } from '../src/main/util'

// The context & spend guard: thresholds, the request-rate signal, budgets, and the transcript
// usage it reads (Claude repeats a message's usage on every content-block line).

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))

const rec = (context: number, extra: Partial<UsageRecord> = {}): UsageRecord => ({ input: 0, cacheWrite: 0, cacheRead: context, output: 0, context, model: 'claude-sonnet-4-6', ...extra })

function setup(cfg: Partial<GuardSettings> = {}) {
  let now = 1_000_000
  let queue: UsageRecord[] = []
  let offset = 0
  const settings = { ...DEFAULT_SETTINGS.guard, ...cfg }
  const g = new ContextGuard({
    settings: () => settings,
    now: () => now,
    read: (_p, _f, off) => {
      if (off === undefined) return { records: [], offset: (offset = 1) }
      const records = queue
      queue = []
      return { records, offset: ++offset }
    }
  })
  const push = (...r: UsageRecord[]) => {
    queue.push(...r)
    g.sample('s', 'claude', 'transcript.jsonl')
  }
  g.sample('s', 'claude', 'transcript.jsonl') // first look starts at the end of the file
  return { g, push, settings, tick: (ms: number) => (now += ms) }
}

describe('pricing', () => {
  it('matches the most specific model family and prices cache tiers', () => {
    expect(ratesFor('claude-opus-5-5').input).toBe(4)
    expect(ratesFor('claude-opus-4-8').input).toBe(5)
    expect(ratesFor('claude-sonnet-5-5').cacheRead).toBe(0.2)
    expect(ratesFor('claude-haiku-4-5').output).toBe(5)
    expect(ratesFor('gpt-something').input).toBe(5) // unknown: priced high
    // 1M cache-read tokens of Sonnet 4.6 + 1k output
    expect(costOf('claude-sonnet-4-6', { input: 0, cacheWrite: 0, cacheRead: 1_000_000, output: 1000 })).toBeCloseTo(0.3 + 0.015)
  })
})

describe('context thresholds', () => {
  it('warns, compacts, then rotates as a 200k-window session grows', () => {
    const { g, push } = setup()
    g.setContextWindow('s', 200_000)
    push(rec(70_000))
    expect(g.level('s')).toBe('ok')
    push(rec(85_000))
    expect(g.level('s')).toBe('warn')
    expect(g.evaluate('s')).toBe('none')
    push(rec(105_000))
    expect(g.evaluate('s')).toBe('compact')
    // Asked once: no second request while it's underway.
    expect(g.evaluate('s')).toBe('none')
    g.compacted('s')
    expect(g.level('s')).toBe('ok')
    push(rec(150_000))
    expect(g.evaluate('s')).toBe('rotate')
  })

  it('caps compaction by tokens on a 1M-token window', () => {
    const { g, push } = setup()
    g.setContextWindow('s', 1_000_000)
    push(rec(160_000))
    expect(g.evaluate('s')).toBe('compact')
  })

  it('rotates instead of compacting again after repeated compactions', () => {
    const { g, push } = setup({ rotateAfterCompactions: 2 })
    g.setContextWindow('s', 200_000)
    g.compacted('s')
    g.compacted('s')
    push(rec(105_000))
    expect(g.evaluate('s')).toBe('rotate')
  })

  it('compacts earlier while a large session makes requests quickly', () => {
    const { g, push } = setup()
    g.setContextWindow('s', 200_000)
    push(rec(85_000))
    expect(g.evaluate('s')).toBe('none')
    for (let i = 0; i < 6; i++) g.step('s')
    expect(g.evaluate('s')).toBe('compact')
  })

  it('respects the auto switches and the master switch', () => {
    const a = setup({ autoCompact: false, autoRotate: false })
    a.g.setContextWindow('s', 200_000)
    a.push(rec(190_000))
    expect(a.g.evaluate('s')).toBe('none')
    const b = setup({ enabled: false })
    b.push(rec(190_000))
    expect(b.g.evaluate('s')).toBe('none')
  })
})

describe('spend limits', () => {
  it('trips the session limit from estimated usage and lets the user allow more', () => {
    const { g, push } = setup({ sessionUsdLimit: 1, hourlyUsdLimit: 0 })
    push(rec(1_000_000)) // $0.30 of cache reads
    expect(g.paused('s')).toBeUndefined()
    push(rec(1_000_000), rec(1_000_000), rec(1_000_000))
    expect(g.paused('s')).toMatch(/limit \$1/)
    g.allowMore('s')
    expect(g.paused('s')).toBeUndefined()
  })

  it('trips the hourly limit across sessions and external runs, and clears as the hour rolls', () => {
    const { g, tick } = setup({ sessionUsdLimit: 0, hourlyUsdLimit: 5 })
    g.addExternalSpend(3)
    expect(g.paused()).toBeUndefined()
    g.addExternalSpend(2.5)
    expect(g.paused()).toMatch(/last hour/)
    expect(g.paused('other-session')).toMatch(/last hour/)
    tick(61 * 60_000)
    g.addExternalSpend(0.01)
    expect(g.paused()).toBeUndefined()
  })

  it('corrects the estimate upward with the CLI cost report without double counting', () => {
    const { g, push } = setup({ sessionUsdLimit: 0, hourlyUsdLimit: 0 })
    push(rec(1_000_000)) // estimate $0.30
    g.reportCost('s', 0.5) // the CLI saw $0.50 (e.g. subagents)
    expect(g.state('s')!.spendUsd).toBeCloseTo(0.5)
    push(rec(1_000_000))
    g.reportCost('s', 0.7) // cumulative: this turn cost $0.20, below the $0.30 estimate
    expect(g.state('s')!.spendUsd).toBeCloseTo(0.8)
    g.processRestarted('s')
    g.reportCost('s', 0.1)
    expect(g.state('s')!.spendUsd).toBeCloseTo(0.9)
  })

  it('reports a trip only once', () => {
    const { g, push, tick } = setup({ sessionUsdLimit: 0.5, hourlyUsdLimit: 0 })
    const t0 = 1_000_000
    tick(10)
    push(rec(2_000_000))
    expect(g.trippedSince(t0)).toBe(true)
    tick(10)
    const t1 = t0 + 20
    push(rec(2_000_000))
    expect(g.trippedSince(t1)).toBe(false)
  })
})

describe('transcript usage', () => {
  it('counts a Claude message once though each content block repeats its usage', () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 40 }
    const line = (id: string) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage } })
    const out = parseClaude([line('m1'), line('m1'), JSON.stringify({ type: 'user', message: { content: 'hi' } }), line('m2'), '{"partial'])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ id: 'm1', model: 'claude-opus-5-5', input: 10, cacheWrite: 200, cacheRead: 5000, output: 40, context: 5210 })
  })

  it('reads Codex token_count events with cached input split out', () => {
    const tc = (total: number) =>
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } } } })
    const out = parseCodex([JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-x' } }), tc(1050), tc(1050), tc(2100)])
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ model: 'gpt-x', input: 200, cacheRead: 800, output: 50, context: 1000 })
  })

  it('reads only complete lines appended since the last offset', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), 't.jsonl')
    fs.writeFileSync(f, 'old\n')
    const start = readNewLines(f, undefined)!
    expect(start.lines).toEqual([])
    fs.appendFileSync(f, 'a\nb\npart')
    const r1 = readNewLines(f, start.offset)!
    expect(r1.lines).toEqual(['a', 'b'])
    fs.appendFileSync(f, 'ial\n')
    expect(readNewLines(f, r1.offset)!.lines).toEqual(['partial'])
  })
})
