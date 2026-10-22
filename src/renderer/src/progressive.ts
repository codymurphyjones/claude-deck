import type { LoadResult } from '@shared/progressive'
import { bridge } from './api'

let seq = 0

export interface ProgressiveLoad {
  /** Resolves when the last batch has been delivered. */
  done: Promise<LoadResult>
  cancel: () => void
}

/**
 * Start a progressive load. `start` receives the load id to pass to a `load.*` call;
 * `onBatch` gets each batch of records as it arrives (`first` marks the first one, so a
 * refresh can swap in new data without blanking the view in between).
 */
export function loadProgressive<T>(start: (loadId: string) => Promise<LoadResult>, onBatch: (records: T[], first: boolean) => void): ProgressiveLoad {
  const loadId = `load-${Date.now().toString(36)}-${++seq}`
  let first = true
  let cancelled = false
  // Subscribe before starting so no batch can be missed.
  const off = bridge.on('load:batch', ((id: string, records: T[]) => {
    if (id !== loadId || cancelled) return
    onBatch(records, first)
    first = false
  }) as (...args: never[]) => void)
  const done = start(loadId).finally(off)
  return {
    done,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      off()
      void bridge.call('load.cancel', loadId)
    }
  }
}
