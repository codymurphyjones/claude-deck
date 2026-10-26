import { useEffect } from 'react'
import { providerOf, type ProviderId } from '@shared/agent'
import { api } from './api'
import { useStore } from './store'
import { create } from 'zustand'

// A provider's models and efforts as its CLI offers them now (Codex: model/list), falling back to
// the built-in lists (shared/agent.ts PROVIDERS) until known, or when the CLI doesn't say.

type Lists = { models: [string, string][]; efforts: string[] }
const useLists = create<Partial<Record<ProviderId, Lists | null>>>(() => ({}))
const asked = new Set<ProviderId>()

function load(p: ProviderId): void {
  if (asked.has(p)) return
  asked.add(p)
  void api.auth.models(p).then(
    (l) => useLists.setState({ [p]: l ?? null }),
    () => useLists.setState({ [p]: null })
  )
}

/** Models and efforts for `p` (default: the default provider), fetched once per app run. */
export function useProviderLists(p?: ProviderId): Lists {
  const fallback = useStore((s) => s.settings.defaultProvider)
  const id = providerOf(p ?? fallback).id
  const got = useLists((s) => s[id])
  useEffect(() => load(id), [id])
  const d = providerOf(id)
  return got ? got : { models: d.models, efforts: d.efforts }
}

/** The same, outside React (e.g. building a menu): whatever is known now. */
export function providerLists(p?: ProviderId): Lists {
  const id = providerOf(p ?? useStore.getState().settings.defaultProvider).id
  load(id)
  const got = useLists.getState()[id]
  const d = providerOf(id)
  return got ? got : { models: d.models, efforts: d.efforts }
}
