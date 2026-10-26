import { EventEmitter } from 'events'
import { PROVIDER_IDS, type ProviderId } from '@shared/agent'
import type { AuthStatus } from '@shared/types'
import { adapter } from '../agents/registry'
import { broadcast } from '../context'

const empty = (provider: ProviderId): AuthStatus => ({ provider, checked: false, loggedIn: false })

/** Tracks each agent CLI's sign-in state. */
export class AuthService extends EventEmitter {
  statuses: Record<ProviderId, AuthStatus> = { claude: empty('claude'), codex: empty('codex') }
  private polls = new Map<ProviderId, NodeJS.Timeout>()
  private inflight = new Map<ProviderId, Promise<AuthStatus>>()

  statusOf(p: ProviderId): AuthStatus {
    return this.statuses[p]
  }

  all(): AuthStatus[] {
    return PROVIDER_IDS.map((p) => this.statuses[p])
  }

  refreshAll(): Promise<AuthStatus[]> {
    return Promise.all(PROVIDER_IDS.map((p) => this.refresh(p)))
  }

  refresh(p: ProviderId = 'claude'): Promise<AuthStatus> {
    const running = this.inflight.get(p)
    if (running) return running
    const job = (async () => {
      let next: AuthStatus
      try {
        next = { provider: p, ...(await adapter(p).auth.status()) }
      } catch (e) {
        next = { provider: p, checked: true, loggedIn: false, error: (e as Error).message }
      }
      const prev = this.statuses[p]
      const changed = next.loggedIn !== prev.loggedIn || !prev.checked
      this.statuses[p] = next
      broadcast('auth:changed', next)
      if (changed) this.emit('changed', next)
      this.schedulePoll(p)
      return next
    })().finally(() => this.inflight.delete(p))
    this.inflight.set(p, job)
    return job
  }

  private schedulePoll(p: ProviderId): void {
    const t = this.polls.get(p)
    if (t) clearTimeout(t)
    // Poll quickly while signed out (to notice a login), slowly otherwise. A provider
    // whose CLI isn't installed is checked rarely.
    const st = this.statuses[p]
    const ms = st.loggedIn ? 5 * 60_000 : st.error && /ENOENT|not recognized|not found/i.test(st.error) ? 10 * 60_000 : 5_000
    this.polls.set(p, setTimeout(() => void this.refresh(p), ms))
  }

  loginArgs(p: ProviderId, opts: { console?: boolean; sso?: boolean; email?: string; device?: boolean } = {}): string[] {
    return adapter(p).auth.loginArgs(opts)
  }

  /** Sign in with an API key (Codex), then re-check. */
  async loginWithApiKey(p: ProviderId, key: string): Promise<void> {
    const a = adapter(p).auth
    if (!a.loginWithApiKey) throw new Error(`${adapter(p).descriptor.label} doesn't support API-key sign-in here`)
    await a.loginWithApiKey(key)
    await this.refresh(p)
  }

  async logout(p: ProviderId = 'claude'): Promise<void> {
    await adapter(p).auth.logout()
    await this.refresh(p)
  }
}
