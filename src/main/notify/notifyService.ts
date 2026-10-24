import { BrowserWindow, Notification, powerSaveBlocker, webContents } from 'electron'
import type { SessionInfo } from '@shared/types'
import { broadcast, settings } from '../context'
import { truncate } from '../util'

let blockerId: number | undefined

export function updateSleepBlocker(anyWorking: boolean): void {
  const want = anyWorking && settings().preventSleep
  if (want && blockerId === undefined) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  else if (!want && blockerId !== undefined) {
    powerSaveBlocker.stop(blockerId)
    blockerId = undefined
  }
}

function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && (w as BrowserWindow & { deckMain?: boolean }).deckMain)
}

/** Bring the session's window (its popout, else the main window) forward and show the session. */
export function focusSession(id: string, hostWindow?: number): void {
  const host = hostWindow !== undefined ? webContents.fromId(hostWindow) : undefined
  const w = (host && !host.isDestroyed() && BrowserWindow.fromWebContents(host)) || mainWindow()
  if (w) {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
  broadcast('ui:focusSession', id)
}

/** `agent`: a session's own notify tool ("tell me when the tests pass"). */
export type NotifyKind = 'turn' | 'permission' | 'question' | 'goal' | 'automation' | 'job' | 'process' | 'mesh' | 'agent'

export interface NotifyAction {
  label: string
  run: () => void
}

export interface NotifyOptions {
  /** Buttons on the toast; clicking the body still opens the session. */
  actions?: NotifyAction[]
  /** Lets dismissNotification() withdraw the toast once it no longer applies. */
  tag?: string
}

// Shown notifications are held until they finish: a garbage-collected Notification no longer
// delivers its click/action events.
const live = new Set<Notification>()
const tagged = new Map<string, Notification>()

/** Withdraw a toast that's been answered elsewhere (e.g. a permission decided in the app). */
export function dismissNotification(tag: string): void {
  const n = tagged.get(tag)
  if (!n) return
  tagged.delete(tag)
  live.delete(n)
  n.close()
}

export function notify(kind: NotifyKind, s: Pick<SessionInfo, 'id' | 'name'> & { hostWindow?: number } | undefined, title: string, body: string, opts: NotifyOptions = {}): void {
  const cfg = settings().notifications
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (kind === 'turn' && (cfg.turnComplete === 'never' || (cfg.turnComplete === 'background' && focused))) return
  if (kind === 'permission' && !cfg.permission) return
  if (kind === 'question' && !cfg.question) return
  // Failed processes already raise a sticky in-app alert.
  if (kind === 'process' && focused) return
  if ((kind === 'goal' || kind === 'automation' || kind === 'job' || kind === 'mesh' || kind === 'agent') && focused) {
    broadcast('toast', { id: String(Date.now()), kind: 'info', text: `${title}: ${truncate(body, 140)}` })
    return
  }
  if (!focused) mainWindow()?.flashFrame(true)
  if (!Notification.isSupported()) return
  const actions = opts.actions ?? []
  const n = new Notification({ title, body: truncate(body, 240), silent: !cfg.sound, actions: actions.map((a) => ({ type: 'button', text: a.label })) })
  const done = (): void => {
    live.delete(n)
    if (opts.tag && tagged.get(opts.tag) === n) tagged.delete(opts.tag)
  }
  n.on('click', () => {
    done()
    if (s) focusSession(s.id, s.hostWindow)
  })
  n.on('action', (e) => {
    done()
    actions[e.actionIndex]?.run()
  })
  // A timed-out toast moves to Action Center, where its buttons still work; keep it until then.
  n.on('close', (e) => e.reason !== 'timedOut' && done())
  n.on('failed', done)
  if (opts.tag) {
    dismissNotification(opts.tag)
    tagged.set(opts.tag, n)
  }
  live.add(n)
  // Toasts sitting unanswered in Action Center shouldn't pile up forever.
  if (live.size > 50) live.delete(live.values().next().value!)
  n.show()
}
