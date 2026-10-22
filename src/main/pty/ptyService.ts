import { EventEmitter } from 'events'
import * as pty from '@lydell/node-pty'

const FLUSH_MS = 5
const FLUSH_BYTES = 64 * 1024
const RING_LIMIT = 2 * 1024 * 1024

interface Entry {
  proc: pty.IPty
  pending: string
  timer: NodeJS.Timeout | undefined
  ring: string[]
  ringSize: number
  cols: number
  rows: number
  lastOutput: number
  alive: boolean
}

/**
 * Owns all pseudo-terminals. Output is coalesced into small batches before it
 * crosses IPC, which keeps rendering smooth under heavy output.
 */
export class PtyService extends EventEmitter {
  private entries = new Map<string, Entry>()

  spawn(
    id: string,
    file: string,
    args: string[],
    opts: { cwd: string; env: Record<string, string>; cols?: number; rows?: number }
  ): number {
    const cols = opts.cols ?? 120
    const rows = opts.rows ?? 32
    let command = file
    let argv = args
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) {
      command = process.env.ComSpec || 'cmd.exe'
      argv = ['/d', '/s', '/c', file, ...args]
    }
    const proc = pty.spawn(command, argv, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env,
      useConpty: true
    } as pty.IPtyForkOptions)
    const entry: Entry = { proc, pending: '', timer: undefined, ring: [], ringSize: 0, cols, rows, lastOutput: Date.now(), alive: true }
    this.entries.set(id, entry)
    proc.onData((data) => this.onData(id, entry, data))
    proc.onExit(({ exitCode }) => {
      this.flush(id, entry)
      entry.alive = false
      this.emit('exit', id, exitCode)
    })
    return proc.pid
  }

  private onData(id: string, e: Entry, data: string): void {
    e.lastOutput = Date.now()
    e.pending += data
    e.ring.push(data)
    e.ringSize += data.length
    while (e.ringSize > RING_LIMIT && e.ring.length > 1) e.ringSize -= e.ring.shift()!.length
    if (e.pending.length >= FLUSH_BYTES) this.flush(id, e)
    else if (!e.timer) e.timer = setTimeout(() => this.flush(id, e), FLUSH_MS)
  }

  private flush(id: string, e: Entry): void {
    if (e.timer) clearTimeout(e.timer)
    e.timer = undefined
    if (!e.pending) return
    const chunk = e.pending
    e.pending = ''
    this.emit('data', id, chunk)
  }

  has(id: string): boolean {
    return !!this.entries.get(id)?.alive
  }

  /** Forget a terminal entirely (after its tab closes). */
  dispose(id: string): void {
    this.kill(id)
    this.entries.delete(id)
  }

  write(id: string, data: string): void {
    const e = this.entries.get(id)
    if (e?.alive) e.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const e = this.entries.get(id)
    if (!e || !e.alive || cols < 2 || rows < 1) return
    if (e.cols === cols && e.rows === rows) return
    e.cols = cols
    e.rows = rows
    try {
      e.proc.resize(cols, rows)
    } catch {
      /* process may be exiting */
    }
  }

  size(id: string): { cols: number; rows: number } | undefined {
    const e = this.entries.get(id)
    return e && { cols: e.cols, rows: e.rows }
  }

  /** Nudge a TUI to repaint (used after re-attaching a view). */
  repaint(id: string): void {
    const e = this.entries.get(id)
    if (!e?.alive) return
    try {
      e.proc.resize(Math.max(2, e.cols - 1), e.rows)
      setTimeout(() => {
        try {
          e.proc.resize(e.cols, e.rows)
        } catch {
          /* ignore */
        }
      }, 30)
    } catch {
      /* ignore */
    }
  }

  /**
   * Scrollback for (re)hydrating a view. Pending output is flushed first so every
   * byte in the snapshot was already sent as a live event *before* this reply;
   * the renderer can then drop live events it queued while waiting.
   */
  buffer(id: string): string {
    const e = this.entries.get(id)
    if (!e) return ''
    this.flush(id, e)
    return e.ring.join('')
  }

  kill(id: string): void {
    const e = this.entries.get(id)
    if (!e?.alive) return
    try {
      e.proc.kill()
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }
}
