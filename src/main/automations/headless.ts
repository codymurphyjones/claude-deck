import type { ProviderId } from '@shared/agent'
import { adapter } from '../agents/registry'
import type { HeadlessOptions, HeadlessResult } from '../agents/types'

export type { HeadlessResult }

/** Run an agent unattended (the default provider unless one is given). */
export function runHeadless(opts: HeadlessOptions & { provider?: ProviderId }): { done: Promise<HeadlessResult>; kill: () => void } {
  return adapter(opts.provider).headless(opts)
}
