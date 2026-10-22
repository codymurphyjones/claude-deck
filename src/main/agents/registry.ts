import { PROVIDER_IDS, type ProviderId } from '@shared/agent'
import { settings } from '../context'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import type { AgentAdapter } from './types'

const adapters: Record<ProviderId, AgentAdapter> = { claude: claudeAdapter, codex: codexAdapter }

/** The adapter for a provider (the user's default when unspecified). */
export function adapter(p?: ProviderId): AgentAdapter {
  return adapters[p ?? settings().defaultProvider] ?? claudeAdapter
}

export const allAdapters = (): AgentAdapter[] => PROVIDER_IDS.map((p) => adapters[p])

/** Which provider owns a stored session id (records written before providers default to Claude). */
export const providerOf = (rec: { provider?: ProviderId } | undefined): ProviderId => rec?.provider ?? 'claude'
