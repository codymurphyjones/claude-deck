import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { formatDiagEntry, type DiagEntry, type DiagLevel } from '@shared/diagnostics'

/**
 * Diagnostics log: errors that would otherwise vanish (failed IPC handlers, unhandled
 * rejections in either process) land in `<userData>/logs/claude-deck.log` and in a small
 * in-memory ring shown in Settings → Diagnostics.
 */

const MAX_BYTES = 2 * 1024 * 1024
const KEEP = 300

const recent: DiagEntry[] = []
let size = -1

export function diagLogDir(): string {
  return path.join(app.getPath('userData'), 'logs')
}

export function diagLogFile(): string {
  return path.join(diagLogDir(), 'claude-deck.log')
}

function errorParts(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message || err.name, stack: err.stack?.split('\n').slice(1).join('\n') || undefined }
  if (typeof err === 'string') return { message: err }
  try {
    return { message: JSON.stringify(err) }
  } catch {
    return { message: String(err) }
  }
}

function append(line: string): void {
  try {
    const file = diagLogFile()
    if (size < 0) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      size = fs.existsSync(file) ? fs.statSync(file).size : 0
    }
    // Simple rotation: one previous file, so the log never grows past ~2× MAX_BYTES.
    if (size > 0 && size + Buffer.byteLength(line) > MAX_BYTES) {
      fs.rmSync(file + '.old', { force: true })
      if (fs.existsSync(file)) fs.renameSync(file, file + '.old')
      size = 0
    }
    fs.appendFileSync(file, line)
    size += Buffer.byteLength(line)
  } catch {
    /* logging must never throw; the in-memory ring still has the entry */
  }
}

/** Record a diagnostics entry. `detail` may be an Error (its stack is kept) or any value. */
export function logDiag(level: DiagLevel, source: string, detail: unknown, stack?: string): DiagEntry {
  const parts = errorParts(detail)
  const entry: DiagEntry = { at: Date.now(), level, source, message: parts.message, stack: stack || parts.stack }
  recent.push(entry)
  if (recent.length > KEEP) recent.splice(0, recent.length - KEEP)
  append(formatDiagEntry(entry) + '\n')
  // Keep the console output a listener-less unhandledRejection would have printed.
  if (level === 'error') console.error(`[${source}]`, detail)
  return entry
}

/** Recent entries, oldest first. */
export function recentDiag(): DiagEntry[] {
  return recent.slice()
}

/** Log main-process crashes-in-waiting. Electron's default handlers still run (no behavior change beyond logging). */
export function installProcessDiagnostics(): void {
  process.on('uncaughtExceptionMonitor', (err) => logDiag('error', 'main:uncaughtException', err))
  process.on('unhandledRejection', (reason) => logDiag('error', 'main:unhandledRejection', reason))
  app.on('render-process-gone', (_e, wc, details) => logDiag('error', 'main:render-process-gone', `${wc.getURL()} — ${details.reason} (exit ${details.exitCode})`))
  app.on('child-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') logDiag('warn', 'main:child-process-gone', `${details.type} — ${details.reason} (exit ${details.exitCode})`)
  })
  logDiag('info', 'main', `Started v${app.getVersion()} (${process.platform}, electron ${process.versions.electron})`)
}
