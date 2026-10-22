// Project actions: package.json scripts a project runs as background processes.

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

export interface ScriptPackage {
  /** Absolute folder holding the package.json. */
  dir: string
  /** Path relative to the project folder ('' for the folder itself). */
  rel: string
  name: string
  pm: PackageManager
  scripts: Record<string, string>
}

export type ProcessStatus = 'running' | 'success' | 'failed' | 'stopped'

export interface ProcessInfo {
  id: string
  projectId: string
  cwd: string
  rel: string
  script: string
  command: string
  status: ProcessStatus
  pid?: number
  exitCode?: number
  startedAt: number
  finishedAt?: number
  /** Failed runs: the line that best explains the failure. */
  reason?: string
  /** Failed runs: the last lines of output, ANSI-stripped. */
  tail?: string
  /** Failure acknowledged: no alert, but still the script's last run. */
  dismissed?: boolean
}

/** Failures that still need attention (alerts, the active list). */
export const isOpenFailure = (p: ProcessInfo): boolean => p.status === 'failed' && !p.dismissed

/** How a script last went: running wins, then its most recent finished run. */
export function scriptState(runs: ProcessInfo[]): { state: '' | 'running' | 'success' | 'failed'; latest?: ProcessInfo; live: number } {
  const live = runs.filter((p) => p.status === 'running').length
  const latest = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0]
  if (live) return { state: 'running', latest, live }
  const st = latest?.status
  return { state: st === 'success' || st === 'failed' ? st : '', latest, live }
}

export const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm']
]

/** `packageManager` field (e.g. "pnpm@9.1.0") wins, then the first lockfile found. */
export function pickPm(packageManagerField: unknown, lockfiles: string[]): PackageManager {
  const f = typeof packageManagerField === 'string' ? packageManagerField.split('@')[0] : ''
  if (f === 'npm' || f === 'pnpm' || f === 'yarn' || f === 'bun') return f
  for (const [file, pm] of LOCKFILES) if (lockfiles.includes(file)) return pm
  return 'npm'
}

export function scriptCommand(pm: PackageManager, script: string): string {
  const s = /^[\w:.@/-]+$/.test(script) ? script : JSON.stringify(script)
  return pm === 'yarn' ? `yarn ${s}` : `${pm} run ${s}`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}

/** Clean terminal output into plain lines (handles \r redraws). */
export function plainLines(raw: string): string[] {
  // ConPTY starts new lines by positioning the cursor (ESC[row;colH) rather than with \n.
  // eslint-disable-next-line no-control-regex
  return stripAnsi(raw.replace(/\x1b\[\d*(;\d*)?[Hf]/g, '\n'))
    .split(/\r?\n/)
    .map((l) => l.split('\r').pop()!.trimEnd())
    .filter((l) => l.trim())
}

const ERROR_LINE = /error|ERR!|failed|failure|exception|cannot|can't|not found|ELIFECYCLE|denied|refused|missing/i
// Package-manager boilerplate that says *that* it failed, not why: `> script` banners
// (which echo the command text), npm's error footer, yarn's exit line and stack frames.
const NOISE = /^(> |npm ERR! (A complete log|code|path|command|errno|syscall|signal)|npm error (code|path|command|A complete log)|ELIFECYCLE|error Command failed with exit code|\s*at )/i

/** The line that best explains a failure. */
export function failureReason(lines: string[], code: number | undefined): string {
  const explanatory = lines.filter((l) => ERROR_LINE.test(l) && !NOISE.test(l.trim()))
  if (explanatory.length) return explanatory[0].trim()
  const last = lines.filter((l) => !NOISE.test(l.trim())).pop()
  return last?.trim() || `Exited with code ${code ?? '?'}`
}
