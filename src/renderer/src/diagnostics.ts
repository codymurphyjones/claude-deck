import { api, errMsg } from './api'
import { toast } from './store'

/** Errors that are noise, not failures worth a toast. */
const IGNORED = [/ResizeObserver loop/i, /AbortError/, /The operation was aborted/i, /Canceled: Canceled/]

const lastShown = new Map<string, number>()

function report(source: string, err: unknown): void {
  const message = errMsg(err) || 'Unknown error'
  if (IGNORED.some((r) => r.test(message))) return
  const now = Date.now()
  // The same failure often fires in bursts (a retried call, a re-render loop): toast it once.
  if (now - (lastShown.get(message) ?? 0) > 2500) toast(message, 'error')
  lastShown.set(message, now)
  if (lastShown.size > 50) for (const [k, at] of lastShown) if (now - at > 2500) lastShown.delete(k)
  // Failed IPC calls are already logged (with the channel) by the main process.
  if (err instanceof Error && /^Error invoking remote method/.test(err.message)) return
  const stack = err instanceof Error ? err.stack : undefined
  api.diag.log('error', source, message, stack).catch(() => undefined)
}

/**
 * Surface errors nobody caught. Many call sites fire-and-forget (`void api.x()`), so without this
 * a failing call is silent. Callers using `attempt()` catch their own errors and never reach here.
 */
export function installErrorReporting(): void {
  window.addEventListener('unhandledrejection', (e) => report('renderer:unhandledrejection', e.reason))
  window.addEventListener('error', (e) => {
    // Resource load errors (img/script) have no `error` and aren't app failures.
    if (!e.error && !e.message) return
    report('renderer:error', e.error ?? e.message)
  })
}
