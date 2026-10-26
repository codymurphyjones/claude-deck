import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { LineBuffer } from '../../util'

type Json = Record<string, unknown>

/**
 * JSON-RPC over the stdio of `codex app-server` (newline-delimited, no "jsonrpc" field).
 *
 * Events: 'notification' (method, params), 'request' (id, method, params) for server→client
 * requests such as approvals (answer with respond()), 'exit' (code, stderr).
 */
export class AppServer extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | undefined
  private buf = new LineBuffer()
  private stderr = ''
  private seq = 0
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>()

  get alive(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed
  }

  /** `args`: codex's global options (e.g. `-c key=value`, `--profile x`), placed before `app-server`. */
  start(command: string, args: string[], opts: { cwd: string; env: Record<string, string> }): void {
    this.proc = spawn(command, [...args, 'app-server'], {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      shell: /\.(cmd|bat)$/i.test(command)
    }) as ChildProcessWithoutNullStreams
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (d: string) => this.onData(d))
    this.proc.stderr.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString('utf8')).slice(-8000)
    })
    this.proc.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error('Codex exited'))
      this.pending.clear()
      this.emit('exit', code ?? 0, this.stderr.trim())
    })
    this.proc.on('error', (e) => this.emit('exit', -1, e.message))
  }

  kill(): void {
    try {
      this.proc?.stdin.end()
    } catch {
      /* ignore */
    }
    const p = this.proc
    setTimeout(() => {
      if (p && p.exitCode === null) p.kill()
    }, 1500)
  }

  request<T = Json>(method: string, params: Json = {}, timeoutMs = 60_000): Promise<T> {
    if (!this.alive) return Promise.reject(new Error('Codex is not running'))
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t)
          resolve(v as T)
        },
        reject: (e) => {
          clearTimeout(t)
          reject(e)
        }
      })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: Json): void {
    this.write(params ? { method, params } : { method })
  }

  respond(id: number | string, result: Json): void {
    this.write({ id, result })
  }

  respondError(id: number | string, message: string): void {
    this.write({ id, error: { code: -32601, message } })
  }

  private write(obj: Json): void {
    if (this.alive) this.proc!.stdin.write(JSON.stringify(obj) + '\n')
  }

  private onData(d: string): void {
    this.buf.push(d, (raw) => {
      const line = raw.trim()
      if (!line) return
      let j: Json
      try {
        j = JSON.parse(line)
      } catch {
        return
      }
      const hasId = j.id !== undefined && j.id !== null
      if (hasId && typeof j.method === 'string') this.emit('request', j.id, j.method, (j.params as Json) ?? {})
      else if (hasId) {
        const p = this.pending.get(Number(j.id))
        if (!p) return
        this.pending.delete(Number(j.id))
        if (j.error) p.reject(new Error(String((j.error as Json).message ?? 'Codex error')))
        else p.resolve((j.result as Json) ?? {})
      } else if (typeof j.method === 'string') this.emit('notification', j.method, (j.params as Json) ?? {})
    })
  }
}
