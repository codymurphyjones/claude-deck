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
  let buf = ''
  child.stdout.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '')
      buf = buf.slice(i + 1)
      if (line) opts.onLine(line)
    }
  })
  child.stderr.on('data', () => {})
  if (opts.input !== undefined) child.stdin.end(opts.input)
  else child.stdin.end()
  const done = new Promise<number>((resolve) => {
    child.on('close', (code) => {
      if (buf.trim()) opts.onLine(buf.trim())
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
