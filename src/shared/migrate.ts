// One-way upgrades for data written before the app became provider-agnostic.

import type { Settings } from './types'

type Loose = Record<string, unknown>

/** `claudeSessionId` → `agentSessionId`, and stamp pre-provider records as Claude. */
export function migrateSessionRef<T extends object>(rec: T): T {
  const r = rec as Loose
  if ('claudeSessionId' in r) {
    if (r.agentSessionId === undefined) r.agentSessionId = r.claudeSessionId
    delete r.claudeSessionId
  }
  if (r.agentSessionId !== undefined && r.provider === undefined) r.provider = 'claude'
  return rec
}

export function migrateSessionRefs<T extends object>(list: T[] | undefined): T[] {
  for (const r of list ?? []) migrateSessionRef(r)
  return list ?? []
}

/** Move the old top-level Claude settings into `providers.claude`. */
export function migrateSettings(s: Settings): Settings {
  const legacy = s as unknown as Loose
  const claude = s.providers.claude
  const moves: [string, keyof typeof claude][] = [
    ['claudePath', 'path'],
    ['defaultModel', 'defaultModel'],
    ['defaultEffort', 'defaultEffort'],
    ['defaultPermissionMode', 'defaultPermissionMode']
  ]
  for (const [from, to] of moves) {
    if (!(from in legacy)) continue
    if (typeof legacy[from] === 'string' && legacy[from] && !claude[to]) claude[to] = legacy[from] as string
    delete legacy[from]
  }
  if (s.defaultProvider !== 'claude' && s.defaultProvider !== 'codex') s.defaultProvider = 'claude'
  return s
}
