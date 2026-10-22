import { EventEmitter } from 'events'
import type { AuthStatus } from '@shared/types'
import { broadcast, settings } from '../context'
import { locateClaude } from '../runtime'
import { run } from '../util'

/** Tracks Claude CLI sign-in state via `claude auth status --json`. */
export class AuthService extends EventEmitter {
  status: AuthStatus = { checked: false, loggedIn: false }
  private poll: NodeJS.Timeout | undefined
  private inflight: Promise<AuthStatus> | undefined

  async refresh(): Promise<AuthStatus> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const r = await run(locateClaude(settings().claudePath), ['auth', 'status', '--json'], { timeout: 30_000 })
      let next: AuthStatus
      try {
        const j = JSON.parse(r.stdout)
        next = {
          checked: true,
          loggedIn: !!j.loggedIn,
          email: j.email,
          authMethod: j.authMethod,
          subscriptionType: j.subscriptionType,
          orgName: j.orgName
        }
      } catch {
        // Older CLIs or API-key setups: treat an API key as signed in.
        next = process.env.ANTHROPIC_API_KEY
          ? { checked: true, loggedIn: true, authMethod: 'api-key' }
          : { checked: true, loggedIn: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || undefined }
      }
      const changed = next.loggedIn !== this.status.loggedIn || !this.status.checked
      this.status = next
      broadcast('auth:changed', next)
      if (changed) this.emit('changed', next)
      this.schedulePoll()
      return next
    })().finally(() => (this.inflight = undefined))
    return this.inflight
  }

  private schedulePoll(): void {
    if (this.poll) clearTimeout(this.poll)
    // Poll quickly while signed out (to notice a login), slowly otherwise.
    this.poll = setTimeout(() => void this.refresh(), this.status.loggedIn ? 5 * 60_000 : 5_000)
  }

  loginArgs(opts: { console?: boolean; sso?: boolean; email?: string } = {}): string[] {
    const args = ['auth', 'login']
    if (opts.console) args.push('--console')
    if (opts.sso) args.push('--sso')
    if (opts.email) args.push('--email', opts.email)
    return args
  }

  async logout(): Promise<void> {
    await run(locateClaude(settings().claudePath), ['auth', 'logout'], { timeout: 30_000 })
    await this.refresh()
  }
}
