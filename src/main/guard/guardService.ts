import * as path from 'path'
import { broadcast, settings } from '../context'
import { runtime } from '../runtime'
import { JsonStore } from '../store'
import { sessionUsageSince } from '../transcripts/transcriptService'
import { debounce } from '../util'
import { ContextGuard, type HourSample } from './contextGuard'

let instance: ContextGuard | undefined

/** The app-wide context & spend guard (created on first use, after the stores are ready). */
export function guard(): ContextGuard {
  if (instance) return instance
  const store = new JsonStore<{ hour: HourSample[] }>(path.join(runtime.userData, 'guard.json'), { hour: [] })
  const emit = debounce(() => broadcast('guard:changed', instance?.snapshot()), 250)
  instance = new ContextGuard(
    {
      settings: () => settings().guard,
      read: sessionUsageSince,
      persist: (hour) => store.update((d) => (d.hour = hour)),
      changed: emit
    },
    store.data.hour
  )
  return instance
}
