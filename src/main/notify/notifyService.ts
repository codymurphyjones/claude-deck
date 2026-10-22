import { BrowserWindow, Notification, powerSaveBlocker } from 'electron'
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

export function focusSession(id: string): void {
  const w = mainWindow()
  if (w) {
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  }
  broadcast('ui:focusSession', id)
}

export type NotifyKind = 'turn' | 'permission' | 'question' | 'goal' | 'automation' | 'job' | 'process' | 'mesh'

export function notify(kind: NotifyKind, s: Pick<SessionInfo, 'id' | 'name'> | undefined, title: string, body: string): void {
  const cfg = settings().notifications
  const focused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (kind === 'turn' && (cfg.turnComplete === 'never' || (cfg.turnComplete === 'background' && focused))) return
  if (kind === 'permission' && !cfg.permission) return
  if (kind === 'question' && !cfg.question) return
  // Failed processes already raise a sticky in-app alert.
  if (kind === 'process' && focused) return
  if ((kind === 'goal' || kind === 'automation' || kind === 'job' || kind === 'mesh') && focused) {
    broadcast('toast', { id: String(Date.now()), kind: 'info', text: `${title}: ${truncate(body, 140)}` })
    return
  }
  if (!focused) mainWindow()?.flashFrame(true)
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body: truncate(body, 240), silent: !cfg.sound })
  n.on('click', () => s && focusSession(s.id))
  n.show()
}
