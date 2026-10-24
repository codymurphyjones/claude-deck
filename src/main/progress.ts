import * as path from 'path'
import type { ProgressEvent } from '@shared/types'
import { broadcast } from './context'
import { runtime } from './runtime'
import { JsonStore } from './store'
import { shortId } from './util'

// Long operations (making worktrees: checking out files, copying, linking) report progress for a
// toast with a ring that fills toward an ETA. The ETA is learned: how long the same operation took
// in the same repo the last few times.

const KEEP = 5
let store: JsonStore<{ took: Record<string, number[]> }> | undefined
const timings = (): JsonStore<{ took: Record<string, number[]> }> => (store ??= new JsonStore(path.join(runtime.userData, 'timings.json'), { took: {} }))

/** The expected duration of `key`: the median of its recent runs, else `fallbackMs`. */
export function expectedMs(key: string, fallbackMs: number): number {
  const runs = [...(timings().data.took[key] ?? [])].sort((a, b) => a - b)
  return runs.length ? runs[Math.floor(runs.length / 2)] : fallbackMs
}

export interface Progress {
  /** What's happening now ("Checking out files…"). */
  step(detail: string): void
  done(): void
  fail(): void
}

/**
 * Report a long operation. `key` identifies the kind of work and where (e.g. "worktree:<repo>"), so
 * its duration predicts the next run's; `fallbackMs` is the guess before there's any history.
 */
export function startProgress(key: string, label: string, fallbackMs = 5000): Progress {
  const ev: ProgressEvent = { id: shortId(), label, startedAt: Date.now(), expectedMs: expectedMs(key, fallbackMs), state: 'running' }
  const send = (patch: Partial<ProgressEvent>): void => {
    Object.assign(ev, patch)
    broadcast('progress', { ...ev })
  }
  send({})
  let finished = false
  return {
    step: (detail) => !finished && send({ detail }),
    done: () => {
      if (finished) return
      finished = true
      const took = Date.now() - ev.startedAt
      timings().update((d) => {
        d.took[key] = [...(d.took[key] ?? []), took].slice(-KEEP)
      })
      send({ state: 'done', detail: undefined })
    },
    fail: () => {
      if (finished) return
      finished = true
      send({ state: 'error' })
    }
  }
}

/** Run `fn` with progress reported; failures mark it failed and are rethrown. */
export async function withProgress<T>(key: string, label: string, fn: (p: Progress) => Promise<T>, fallbackMs?: number): Promise<T> {
  const p = startProgress(key, label, fallbackMs)
  try {
    const r = await fn(p)
    p.done()
    return r
  } catch (e) {
    p.fail()
    throw e
  }
}
