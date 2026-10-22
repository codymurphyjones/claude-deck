import { exec } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildRetryPrompt,
  buildStepPrompt,
  extractJson,
  JOBS_DIR,
  jobAssistPrompt,
  jobRunBranchName,
  manifestOf,
  normalizeJob,
  parseStepReport,
  resolveRunOptions,
  slugify,
  stepPivots,
  stepsToRun,
  type JobCheckResult,
  type JobDef,
  type JobRun,
  type JobRunOptions,
  type JobSource
} from '@shared/jobs'
import { broadcast, settings } from '../context'
import { currentBranch, mustGit, rawGit as git, toplevel } from '../git/gitService'
import { notify } from '../notify/notifyService'
import { runtime } from '../runtime'
import { plainEnv } from '../sessions/launch'
import { JsonStore } from '../store'
import { debounce, shortId, truncate } from '../util'
import { createWorktree, touchWorktree } from '../worktrees/worktreeService'
import { runHeadless, type HeadlessResult } from '../automations/headless'

const README = `# repo_jobs

Multi-step task orders for Claude, managed by Claude Deck (Jobs view).

Each folder is one job:

- \`job.json\`: name, description, defaults, pivots, and the ordered steps with their expectations
- \`context.md\`: shared brief given to Claude at the start of a run
- \`steps/<id>.md\`: the prompt for each step

Steps run in order in one continuing Claude conversation. After each step, every
\`command\` expectation is run (it must exit 0); failures are fed back for another
attempt, up to \`maxAttempts\`. Pivots tell Claude what to do instead when a known
obstacle comes up.
`

/** App-level routines library: reusable jobs that run against any repo. */
export const ROUTINES_DIR = path.join(os.homedir(), '.claude-deck', 'routines')

const ROUTINES_README = `# Claude Deck routines

Reusable, repo-agnostic jobs managed by Claude Deck (Routines view). A routine
runs against whichever repository you pick, with optional run-specific context
(e.g. "only the settings screen") added at launch.

Each folder is one routine, in the same layout as a repo's \`repo_jobs\` folder:

- \`job.json\`: name, description, defaults, pivots, and the ordered steps with their expectations
- \`context.md\`: shared brief given to Claude at the start of a run
- \`steps/<id>.md\`: the prompt for each step
`

/** Run a shell command; never rejects. */
function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: plainEnv(), windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0
      const output = `${stdout}${stderr ? (stdout ? '\n' : '') + stderr : ''}`.trim() || (err && !stdout && !stderr ? err.message : '')
      resolve({ code, output })
    })
  })
}

const tail = (s: string, n: number): string => (s.length > n ? '…' + s.slice(-n) : s)

/** Repo jobs: definitions live in <repo>/repo_jobs, run history in userData. */
export class JobService {
  private store = new JsonStore<{ runs: JobRun[] }>(path.join(runtime.userData, 'job-runs.json'), { runs: [] })
  private running = new Map<string, { stopped: boolean; kill?: () => void }>()
  private watchers = new Map<string, fs.FSWatcher>()

  constructor() {
    for (const r of this.store.data.runs)
      if (r.status === 'running') {
        r.status = 'error'
        r.error = 'Interrupted (app closed)'
        for (const s of r.steps) if (s.status === 'running' || s.status === 'pending') s.status = 'skipped'
      }
  }

  /** Whether any run is in progress (keeps the app alive in the tray). */
  busy(): boolean {
    return this.running.size > 0
  }

  stop(): void {
    for (const r of this.running.values()) {
      r.stopped = true
      r.kill?.()
    }
    for (const w of this.watchers.values()) w.close()
    this.store.saveNow()
  }

  // ------------------------------------------------------------------ definitions
  // Repo jobs live in <root>/repo_jobs; routines (app-level jobs) in ~/.claude-deck/routines.
  // Both use the same folder layout, so the I/O below works on a base directory.
  private dir(root: string): string {
    return path.join(root, JOBS_DIR)
  }

  async list(root: string): Promise<JobDef[]> {
    this.watch(this.dir(root), () => this.changed(root))
    return this.listIn(this.dir(root))
  }

  async listRoutines(): Promise<JobDef[]> {
    this.watch(ROUTINES_DIR, () => this.routinesChanged())
    return this.listIn(ROUTINES_DIR)
  }

  private async listIn(base: string): Promise<JobDef[]> {
    let names: string[] = []
    try {
      names = (await fs.promises.readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      return []
    }
    const jobs: JobDef[] = []
    for (const n of names.sort()) {
      const j = await this.read(base, n)
      if (j) jobs.push(j)
    }
    return jobs
  }

  private async read(base: string, slug: string): Promise<JobDef | undefined> {
    const dir = path.join(base, slug)
    let raw: Record<string, unknown>
    try {
      raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'job.json'), 'utf8'))
    } catch {
      return undefined
    }
    const readMd = (f: string): Promise<string> => fs.promises.readFile(path.join(dir, f), 'utf8').catch(() => '')
    const steps = Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : []
    for (const s of steps) if (typeof s.prompt !== 'string' && typeof s.id === 'string') s.prompt = await readMd(path.join('steps', `${s.id}.md`))
    if (typeof raw.context !== 'string') raw.context = await readMd('context.md')
    return normalizeJob(raw, slug)
  }

  async get(root: string, slug: string): Promise<JobDef> {
    const j = await this.read(this.dir(root), slug)
    if (!j) throw new Error(`Job "${slug}" not found in ${JOBS_DIR}`)
    return j
  }

  async getRoutine(slug: string): Promise<JobDef> {
    const j = await this.read(ROUTINES_DIR, slug)
    if (!j) throw new Error(`Routine "${slug}" not found in ${ROUTINES_DIR}`)
    return j
  }

  async save(root: string, input: JobDef, prevSlug?: string): Promise<JobDef> {
    const job = await this.saveIn(this.dir(root), README, input, prevSlug)
    this.watch(this.dir(root), () => this.changed(root))
    this.changed(root)
    return job
  }

  async saveRoutine(input: JobDef, prevSlug?: string): Promise<JobDef> {
    const job = await this.saveIn(ROUTINES_DIR, ROUTINES_README, input, prevSlug)
    this.watch(ROUTINES_DIR, () => this.routinesChanged())
    this.routinesChanged()
    return job
  }

  private async saveIn(base: string, readmeText: string, input: JobDef, prevSlug?: string): Promise<JobDef> {
    const job = normalizeJob(input, slugify(input.slug || input.name))
    await fs.promises.mkdir(base, { recursive: true })
    const readme = path.join(base, 'README.md')
    if (!fs.existsSync(readme)) await fs.promises.writeFile(readme, readmeText, 'utf8')
    const dir = path.join(base, job.slug)
    if (prevSlug && prevSlug !== job.slug) {
      if (fs.existsSync(dir)) throw new Error(`"${job.slug}" already exists`)
      const prev = path.join(base, prevSlug)
      if (fs.existsSync(prev)) await fs.promises.rename(prev, dir)
    }
    const stepsDir = path.join(dir, 'steps')
    await fs.promises.mkdir(stepsDir, { recursive: true })
    await fs.promises.writeFile(path.join(dir, 'job.json'), JSON.stringify(manifestOf(job), null, 2) + '\n', 'utf8')
    const ctx = path.join(dir, 'context.md')
    if (job.context.trim()) await fs.promises.writeFile(ctx, job.context.trimEnd() + '\n', 'utf8')
    else await fs.promises.rm(ctx, { force: true })
    const keep = new Set(job.steps.map((s) => `${s.id}.md`))
    for (const s of job.steps) await fs.promises.writeFile(path.join(stepsDir, `${s.id}.md`), s.prompt.trimEnd() + '\n', 'utf8')
    for (const f of await fs.promises.readdir(stepsDir)) if (f.endsWith('.md') && !keep.has(f)) await fs.promises.rm(path.join(stepsDir, f), { force: true })
    return job
  }

  async remove(root: string, slug: string): Promise<void> {
    await fs.promises.rm(path.join(this.dir(root), slugify(slug)), { recursive: true, force: true })
    this.changed(root)
  }

  async removeRoutine(slug: string): Promise<void> {
    await fs.promises.rm(path.join(ROUTINES_DIR, slugify(slug)), { recursive: true, force: true })
    this.routinesChanged()
  }

  private changed(root: string): void {
    broadcast('jobs:changed', root)
  }

  private routinesChanged(): void {
    broadcast('routines:changed')
  }

  /** Pick up edits made outside the designer (e.g. by Claude in a chat). */
  private watch(dir: string, onChange: () => void): void {
    if (this.watchers.has(dir) || !fs.existsSync(dir)) return
    try {
      const fire = debounce(onChange, 400)
      const w = fs.watch(dir, { recursive: true }, fire)
      w.on('error', () => {
        w.close()
        this.watchers.delete(dir)
      })
      this.watchers.set(dir, w)
    } catch {
      /* watching is best-effort */
    }
  }

  /** Draft or revise a job (or a routine) with Claude (read-only exploration of `cwd`). */
  async assist(root: string, instruction: string, current?: JobDef, opts: { routine?: boolean } = {}): Promise<JobDef> {
    const r = await runHeadless({ prompt: jobAssistPrompt(instruction, current, opts), cwd: root, permissionMode: 'plan', model: settings().defaultModel }).done
    if (r.isError || !r.text) throw new Error(truncate(r.text || `Claude exited with code ${r.code}`, 400))
    let raw: unknown
    try {
      raw = extractJson(r.text)
    } catch {
      throw new Error('Claude did not return a job definition: ' + truncate(r.text, 300))
    }
    const job = normalizeJob(raw, current?.slug)
    if (!job.steps.length) throw new Error('The drafted job has no steps')
    return job
  }

  // ------------------------------------------------------------------ runs
  runs(): JobRun[] {
    return this.store.data.runs
  }

  private emit(): void {
    this.store.scheduleSave()
    broadcast('jobs:runs', this.store.data.runs)
  }

  updateRun(id: string, patch: Partial<JobRun>): void {
    const r = this.store.data.runs.find((x) => x.id === id)
    if (r) Object.assign(r, patch)
    this.emit()
  }

  markAllRead(): void {
    for (const r of this.store.data.runs) if (r.status !== 'running') r.unread = false
    this.emit()
  }

  removeRun(id: string): void {
    if (this.running.has(id)) throw new Error('Stop the run before removing it')
    this.store.data.runs = this.store.data.runs.filter((r) => r.id !== id)
    this.emit()
  }

  stopRun(id: string): void {
    const r = this.running.get(id)
    if (!r) return
    r.stopped = true
    r.kill?.()
  }

  /** Start a run; resolves once it is set up, `done` resolves when it finishes. */
  async start(
    root: string,
    slug: string,
    override: Partial<JobRunOptions> = {},
    trigger: JobRun['trigger'] = 'manual',
    extra?: string,
    source: JobSource = 'repo'
  ): Promise<{ run: JobRun; done: Promise<JobRun> }> {
    const job = source === 'routine' ? await this.getRoutine(slug) : await this.get(root, slug)
    const options = resolveRunOptions(job, override)
    const order = stepsToRun(job, options)
    if (!order.length) throw new Error('No steps to run')
    const run: JobRun = {
      id: 'j' + shortId(),
      root,
      slug: job.slug,
      jobName: job.name,
      ...(source === 'routine' ? { source } : {}),
      trigger,
      options,
      status: 'running',
      startedAt: Date.now(),
      cwd: root,
      steps: job.steps.map((s, i) => ({ stepId: s.id, title: s.title, status: order.includes(i) ? 'pending' : 'skipped', attempts: 0, summary: '', checks: [] })),
      costUsd: 0,
      unread: true
    }
    this.store.data.runs.unshift(run)
    if (this.store.data.runs.length > 200) this.store.data.runs.length = 200
    this.running.set(run.id, { stopped: false })
    this.emit()
    const done = this.execute(run, job, order, extra).then(() => run)
    return { run, done }
  }

  private async prepareWorkspace(run: JobRun): Promise<void> {
    const o = run.options
    const repo = await toplevel(run.root)
    if (o.workspace === 'worktree') {
      if (!repo) throw new Error('Worktree runs need a Git repository. Choose "Working copy" instead.')
      const wt = await createWorktree({ repoCwd: repo, baseRef: o.branch || undefined, name: `${run.source === 'routine' ? 'routine' : 'job'}-${run.slug}` })
      touchWorktree(wt.id)
      run.cwd = run.worktreePath = wt.path
      if (o.branchMode === 'direct') {
        const target = o.branch || (await currentBranch(repo))
        if (!target) throw new Error('No branch to commit onto (the repository is on a detached HEAD)')
        try {
          await mustGit(wt.path, ['switch', target])
        } catch (e) {
          throw new Error(`Could not check out "${target}" in the job's worktree: ${(e as Error).message}\nA branch can only be checked out in one place; pick "New branch" or run in the working copy.`)
        }
        run.branch = target
      } else {
        run.branch = jobRunBranchName(run.slug, run.id)
        await mustGit(wt.path, ['switch', '-c', run.branch])
      }
      return
    }
    run.cwd = run.root
    if (repo && o.branch) {
      const cur = await currentBranch(repo)
      if (cur !== o.branch) {
        const st = await git(repo, ['status', '--porcelain'])
        if (st.stdout.trim()) throw new Error(`The working copy has uncommitted changes; can't switch to "${o.branch}". Commit or stash them, or run in a worktree.`)
        await mustGit(repo, ['switch', o.branch])
      }
    }
    if (repo) run.branch = await currentBranch(repo)
  }

  private async commitStep(cwd: string, message: string): Promise<void> {
    const st = await git(cwd, ['status', '--porcelain'])
    if (!st.stdout.trim()) return
    await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-q', '-m', message])
  }

  private async claude(runId: string, prompt: string, cwd: string, resumeId: string | undefined, o: JobRunOptions, onSession: (id: string) => void): Promise<HeadlessResult> {
    const h = runHeadless({ prompt, cwd, resumeId, model: o.model, effort: o.effort, permissionMode: o.permissionMode, onSession })
    const ctl = this.running.get(runId)
    if (ctl) ctl.kill = h.kill
    const r = await h.done
    if (ctl) ctl.kill = undefined
    return r
  }

  private async execute(run: JobRun, job: JobDef, order: number[], extra?: string): Promise<void> {
    const ctl = this.running.get(run.id)!
    try {
      await this.prepareWorkspace(run)
      this.emit()
      let sessionId: string | undefined
      let first = true
      for (const i of order) {
        if (ctl.stopped) break
        const step = job.steps[i]
        const sr = run.steps[i]
        Object.assign(sr, { status: 'running', startedAt: Date.now(), costUsd: 0 })
        if (step.freshSession) sessionId = undefined
        let prompt = buildStepPrompt(job, i, { withContext: !sessionId, extra: first ? extra : undefined, source: run.source })
        first = false
        let passed = false
        for (let attempt = 1; attempt <= step.maxAttempts && !ctl.stopped; attempt++) {
          sr.attempts = attempt
          this.emit()
          const res = await this.claude(run.id, prompt, run.cwd, sessionId, run.options, (id) => {
            run.claudeSessionId = id
            this.emit()
          })
          if (ctl.stopped) break
          sessionId = res.sessionId ?? sessionId
          run.claudeSessionId = sessionId ?? run.claudeSessionId
          sr.costUsd = (sr.costUsd ?? 0) + (res.costUsd ?? 0)
          run.costUsd += res.costUsd ?? 0
          const failures: string[] = []
          if (res.isError || (!res.finished && res.code !== 0)) {
            failures.push(`Claude stopped with an error: ${truncate(res.text || `exit code ${res.code}`, 400)}`)
            sr.summary = truncate(res.text || `Claude exited with code ${res.code}`, 300)
          } else {
            const rep = parseStepReport(res.text)
            sr.summary = rep.summary || truncate(res.text.trim().split(/\n\s*\n/).pop() ?? '', 300)
            const pv = rep.pivot ? stepPivots(job, step)[rep.pivot - 1] : undefined
            sr.pivot = pv ? `${pv.when} → ${pv.then}` : undefined
            if (rep.status === 'blocked') {
              sr.checks = [{ kind: 'text', text: 'Claude reported the step as blocked', ok: false }]
              break
            }
            const checks: JobCheckResult[] = []
            for (const c of step.expectations) {
              if (c.kind === 'text') {
                checks.push({ kind: 'text', text: c.text, ok: rep.status !== 'partial' })
                continue
              }
              if (ctl.stopped) break
              sr.checks = [...checks, { kind: 'command', text: c.text, ok: false, output: 'Running…' }]
              this.emit()
              const r = await runShell(c.text, run.cwd, (c.timeoutSec ?? 600) * 1000)
              checks.push({ kind: 'command', text: c.text, ok: r.code === 0, output: tail(r.output, 4000) })
              if (r.code !== 0) failures.push(`\`${c.text}\` exited with code ${r.code}:\n\`\`\`\n${tail(r.output, 3000)}\n\`\`\``)
            }
            sr.checks = checks
            if (rep.status === 'partial') failures.push(`You reported the step as partial. Unmet expectations must be completed.`)
          }
          if (!failures.length) {
            passed = true
            break
          }
          prompt = sessionId ? buildRetryPrompt(job, i, attempt + 1, failures) : buildStepPrompt(job, i, { withContext: true, extra, source: run.source })
        }
        sr.finishedAt = Date.now()
        if (ctl.stopped) {
          sr.status = 'failed'
          sr.summary ||= 'Stopped'
          break
        }
        sr.status = passed ? 'passed' : 'failed'
        if (passed && run.options.workspace === 'worktree') await this.commitStep(run.cwd, `job(${job.slug}): ${step.title}`)
        this.emit()
        if (!passed && step.onFail === 'stop') break
      }
      for (const s of run.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped'
      run.status = ctl.stopped ? 'stopped' : run.steps.some((s) => s.status === 'failed') ? 'failed' : 'success'
    } catch (e) {
      run.status = 'error'
      run.error = (e as Error).message
      for (const s of run.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped'
    }
    run.finishedAt = Date.now()
    this.running.delete(run.id)
    this.emit()
    const passed = run.steps.filter((s) => s.status === 'passed').length
    const ran = run.steps.filter((s) => s.status !== 'skipped').length
    notify('job', undefined, `${run.source === 'routine' ? 'Routine' : 'Job'} ${run.status} · ${run.jobName}`, run.error ?? `${passed}/${ran} step(s) passed${run.branch ? ` on ${run.branch}` : ''}`)
  }
}

/** One-line result for the Scheduled inbox. */
export function describeRun(r: JobRun): string {
  if (r.error) return `Error: ${r.error}`
  const lines = r.steps.filter((s) => s.status !== 'skipped').map((s) => `${s.status === 'passed' ? '✓' : '✗'} ${s.title}${s.summary ? ` — ${s.summary}` : ''}`)
  return [`Job ${r.status}${r.branch ? ` on ${r.branch}` : ''}`, ...lines].join('\n')
}
