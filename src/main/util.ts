import { execFile, spawn } from 'child_process'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

export const uuid = (): string => randomUUID()
export const shortId = (): string => randomUUID().replace(/-/g, '').slice(0, 8)

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** Run a command without a shell. Never rejects; inspect `code`. */
export function run(
  file: string,
  args: string[],
  opts: { cwd?: string; input?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const useShell = /\.(cmd|bat)$/i.test(file)
    const child = execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 60_000,
        maxBuffer: 64 * 1024 * 1024,
        env: opts.env ?? process.env,
        windowsHide: true,
        shell: useShell
      },
      (err, stdout, stderr) => {
        const code: unknown = err ? (err as { code?: unknown }).code ?? 1 : 0
        resolve({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr || (err && !stderr ? err.message : '')) })
      }
    )
    // Always close stdin so CLIs that probe it (e.g. `claude -p`) don't wait.
    child.stdin?.end(opts.input ?? '')
  })
}

/**
 * Splits streamed text into lines. Only the new chunk is scanned and a partial line is kept as
 * pieces, so a multi-megabyte line (big tool results, images) costs linear time, not quadratic.
 */
export class LineBuffer {
  private parts: string[] = []

  push(chunk: string, onLine: (line: string) => void): void {
    let start = 0
    let i: number
    while ((i = chunk.indexOf('\n', start)) >= 0) {
      let line = chunk.slice(start, i)
      if (this.parts.length) {
        this.parts.push(line)
        line = this.parts.join('')
        this.parts = []
      }
      start = i + 1
      onLine(line)
    }
    if (start < chunk.length) this.parts.push(chunk.slice(start))
  }

  /** The unterminated tail (cleared). */
  rest(): string {
    const r = this.parts.join('')
    this.parts = []
    return r
  }
}

/** Spawn a long-running process and stream stdout lines. */
export function spawnLines(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine: (line: string) => void; input?: string }
): { done: Promise<number>; kill: () => void } {
  const child = spawn(file, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    windowsHide: true,
    shell: /\.(cmd|bat)$/i.test(file)
  })
  const buf = new LineBuffer()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d: string) =>
    buf.push(d, (l) => {
      const line = l.replace(/\r$/, '')
      if (line) opts.onLine(line)
    })
  )
  child.stderr.on('data', () => {})
  if (opts.input !== undefined) child.stdin.end(opts.input)
  else child.stdin.end()
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      const rest = buf.rest().trim()
      if (rest) opts.onLine(rest)
      resolve(code ?? 1)
    })
    child.on('error', () => resolve(1))
  })
  return { done, kill: () => child.kill() }
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function debounce<T extends (...a: never[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | undefined
  return ((...a: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }) as T
}

/** Find an executable on PATH (Windows aware). */
export function which(name: string): string | undefined {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of [...(process.platform === 'win32' && path.extname(name) ? [''] : []), ...exts]) {
      const full = path.join(dir, name + ext.toLowerCase())
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined
}

export const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g, '')

export const truncate = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

export const toPosix = (p: string): string => p.replace(/\\/g, '/')
