import { execFileSync } from 'child_process'
import { failureReason, plainLines, scriptCommand, type ProcessInfo, type ScriptPackage } from '@shared/processes'
import { broadcast, state } from '../context'
import { notify } from '../notify/notifyService'
import type { PtyService } from '../pty/ptyService'
import { plainEnv } from '../sessions/launch'
import { run, shortId, truncate } from '../util'
import { scanScripts } from './scan'

/** Finished runs kept (newest per script) so their output can still be reviewed. */
const MAX_FINISHED = 40

/** Background processes owned by projects (package.json scripts). Not chat sessions: no tabs, no transcripts. */
export class ProcessService {
  private procs = new Map<string, ProcessInfo>()
  private stopping = new Set<string>()
  private scans = new Map<string, ScriptPackage[]>()

  constructor(private pty: PtyService) {
    pty.on('exit', (id: string, code: number) => this.onExit(id, code))
  }

  list(): ProcessInfo[] {
    return [...this.procs.values()]
  }

  busy(): boolean {
    return this.list().some((p) => p.status === 'running')
  }

  private emit(): void {
    broadcast('processes:changed', this.list())
  }

  private project(projectId: string): { id: string; name: string; folders: string[] } {
    const p = state().projects.find((x) => x.id === projectId)
    if (!p) throw new Error('Project not found')
    return p
  }

  /** Scripts across all of the project's folders; cached until `refresh`. */
  async scan(projectId: string, refresh = false): Promise<ScriptPackage[]> {
    const cached = this.scans.get(projectId)
    if (cached && !refresh) return cached
    const p = this.project(projectId)
    const multi = p.folders.length > 1
    const all: ScriptPackage[] = []
    for (const f of p.folders) {
      const base = f.split(/[\\/]/).pop() ?? f
      for (const pkg of await scanScripts(f)) all.push(multi ? { ...pkg, rel: pkg.rel ? `${base}/${pkg.rel}` : base } : pkg)
    }
    this.scans.set(projectId, all)
    return all
  }

  start(projectId: string, cwd: string, script: string): ProcessInfo {
    const pkg = this.scans.get(projectId)?.find((x) => x.dir === cwd)
    if (!pkg || !(script in pkg.scripts)) throw new Error(`Script "${script}" not found — reload the project's actions`)
    const command = scriptCommand(pkg.pm, script)
    const id = 'proc:' + shortId()
    const isWin = process.platform === 'win32'
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
    // Only the latest run of a script is kept for review; drop earlier finished ones.
    for (const old of this.list()) if (old.cwd === cwd && old.script === script && old.status !== 'running') this.forget(old.id, false)
    const pid = this.pty.spawn(id, file, args, { cwd, env: { ...plainEnv(), FORCE_COLOR: '1' } })
    const p: ProcessInfo = { id, projectId, cwd, rel: pkg.rel, script, command, status: 'running', pid, startedAt: Date.now() }
    this.procs.set(id, p)
    this.prune()
    this.emit()
    return p
  }

  /** Bound memory: each kept run holds its terminal scrollback. */
  private prune(): void {
    const finished = this.list()
      .filter((p) => p.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    for (const p of finished.slice(MAX_FINISHED)) this.forget(p.id, false)
  }

  private onExit(id: string, code: number): void {
    const p = this.procs.get(id)
    if (!p) return
    p.finishedAt = Date.now()
    p.exitCode = code
    // Finished runs stay as the script's "last run" (output reviewable) but leave the active list.
    if (this.stopping.delete(id)) p.status = 'stopped'
    else if (code === 0) p.status = 'success'
    else {
      const lines = plainLines(this.pty.buffer(id))
      p.status = 'failed'
      p.tail = lines.slice(-40).join('\n')
      p.reason = failureReason(lines, code)
      const where = p.rel ? ` in ${p.rel}` : ''
      notify('process', undefined, `${p.command} failed${where}`, `Exit code ${code}: ${truncate(p.reason, 200)}`)
    }
    this.emit()
  }

  private forget(id: string, emit = true): void {
    this.procs.delete(id)
    this.pty.dispose(id)
    if (emit) this.emit()
  }

  /** The run's terminal output as plain text lines (ANSI stripped), the last `lines` of them. */
  output(id: string, lines = 80): string {
    return plainLines(this.pty.buffer(id)).slice(-lines).join('\n')
  }

  async stop(id: string): Promise<void> {
    const p = this.procs.get(id)
    if (!p || p.status !== 'running') return
    this.stopping.add(id)
    // Kill the whole tree so dev servers spawned by the script die too.
    if (process.platform === 'win32' && p.pid) await run('taskkill', ['/pid', String(p.pid), '/T', '/F'], { timeout: 10_000 })
    this.pty.kill(id)
  }

  async restart(id: string): Promise<ProcessInfo> {
    const p = this.procs.get(id)
    if (!p) throw new Error('Process not found')
    await this.stopAndWait(id)
    return this.start(p.projectId, p.cwd, p.script)
  }

  private async stopAndWait(id: string): Promise<void> {
    if (this.procs.get(id)?.status !== 'running') return
    await this.stop(id)
    await new Promise<void>((resolve) => {
      const check = (): void => (this.procs.get(id)?.status === 'running' ? void setTimeout(check, 100) : resolve())
      check()
    })
  }

  /** Close the run's terminal (stopping it first if needed): the script goes back to idle. */
  async close(id: string): Promise<void> {
    if (!this.procs.has(id)) return
    await this.stopAndWait(id)
    this.forget(id)
  }

  /** Acknowledge a failure: hides its alert; the run stays reviewable as the script's last run. */
  dismiss(id: string): void {
    const p = this.procs.get(id)
    if (!p) return
    if (p.status === 'running') throw new Error('Stop the process before dismissing it')
    p.dismissed = true
    this.emit()
  }

  /** On quit: synchronous, so the trees are gone before the app exits. */
  stopAll(): void {
    for (const p of this.procs.values()) {
      if (p.status !== 'running') continue
      this.stopping.add(p.id)
      if (process.platform === 'win32' && p.pid)
        try {
          execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 })
        } catch {
          /* already gone */
        }
      this.pty.kill(p.id)
    }
  }
}
