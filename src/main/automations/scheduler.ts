import * as path from 'path'
import { nextRunAfter } from '@shared/schedule'
import type { Automation, AutomationRun, SessionInfo } from '@shared/types'
import { broadcast, settings } from '../context'
import { ghPath } from '../git/gitService'
import { getChat } from '../library'
import { notify } from '../notify/notifyService'
import { runtime } from '../runtime'
import type { SessionService } from '../sessions/sessionService'
import { JsonStore } from '../store'
import { run, shortId, truncate } from '../util'
import { createWorktree, touchWorktree } from '../worktrees/worktreeService'
import { describeRun, type JobService } from '../jobs/jobService'
import { runHeadless } from './headless'
import { migrateSessionRefs } from '@shared/migrate'

interface AutomationData {
  automations: Automation[]
  runs: AutomationRun[]
}

/** Scheduled tasks: standalone headless runs and in-chat follow-ups, plus a run inbox. */
export class Scheduler {
  private store = new JsonStore<AutomationData>(path.join(runtime.userData, 'automations.json'), { automations: [], runs: [] })
  private timer: NodeJS.Timeout | undefined
  private running = new Map<string, () => void>()

  constructor(
    private sessions: SessionService,
    private jobs: JobService
  ) {
    sessions.on('idle', (s: SessionInfo) => this.onIdle(s))
    migrateSessionRefs(this.store.data.runs)
    // Runs left "running" by a previous app instance never finished.
    for (const r of this.store.data.runs) if (r.status === 'running') Object.assign(r, { status: 'error', output: r.output || 'Interrupted (app closed)' })
  }

  start(): void {
    this.recompute()
    this.timer = setInterval(() => void this.tick(), 20_000)
    setTimeout(() => void this.tick(), 5_000)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    for (const k of this.running.values()) k()
  }

  data(): AutomationData {
    return this.store.data
  }

  private emit(): void {
    this.store.scheduleSave()
    broadcast('automations:changed', this.store.data)
  }

  private recompute(): void {
    const now = Date.now()
    for (const a of this.store.data.automations) a.nextRun = nextRunAfter(a, now)
    this.emit()
  }

  upsert(a: Partial<Automation> & { id?: string }): Automation {
    let existing = a.id ? this.store.data.automations.find((x) => x.id === a.id) : undefined
    if (existing) Object.assign(existing, a)
    else {
      existing = {
        id: 'a' + shortId(),
        name: a.name || 'Scheduled task',
        prompt: a.prompt || '',
        kind: a.kind || 'standalone',
        schedule: a.schedule || { type: 'interval', minutes: 60 },
        cwd: a.cwd || '',
        useWorktree: !!a.useWorktree,
        status: 'active',
        createdAt: Date.now(),
        ...a
      } as Automation
      this.store.data.automations.push(existing)
    }
    existing.nextRun = nextRunAfter(existing, Date.now())
    this.emit()
    return existing
  }

  remove(id: string): void {
    this.store.data.automations = this.store.data.automations.filter((a) => a.id !== id)
    this.emit()
  }

  updateRun(id: string, patch: Partial<AutomationRun>): void {
    const r = this.store.data.runs.find((x) => x.id === id)
    if (r) Object.assign(r, patch)
    this.emit()
  }

  markAllRead(): void {
    for (const r of this.store.data.runs) r.unread = false
    this.emit()
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    for (const a of this.store.data.automations) {
      if (a.status !== 'active') continue
      if (a.schedule.type === 'github') {
        if (!a.nextRun || a.nextRun <= now) {
          a.nextRun = now + 5 * 60_000
          void this.pollGithub(a)
        }
        continue
      }
      if (a.nextRun && a.nextRun <= now && !this.running.has(a.id)) void this.runNow(a.id)
    }
  }

  async runNow(id: string, extra?: string): Promise<void> {
    const a = this.store.data.automations.find((x) => x.id === id)
    if (!a) return
    a.lastRun = Date.now()
    a.nextRun = nextRunAfter(a, Date.now() + 1000)
    if (a.schedule.type === 'rrule' && a.nextRun === undefined) a.status = 'completed'
    this.emit()
    if (a.kind === 'inchat') return this.runInChat(a, extra)
    if (a.kind === 'job') return this.runJob(a, extra)
    return this.runStandalone(a, extra)
  }

  private async runInChat(a: Automation, extra?: string): Promise<void> {
    const prompt = extra ? `${a.prompt}\n\n${extra}` : a.prompt
    let s = [...this.sessions.sessions.values()].find((x) => x.agentSessionId === a.targetChatId && x.status !== 'exited')
    if (!s) {
      const chat = getChat(a.targetChatId)
      if (!chat) {
        a.status = 'paused'
        this.emit()
        return
      }
      await this.sessions.create('agent', { cwd: chat.cwd, provider: chat.provider, resumeId: chat.agentSessionId }, 0)
      a.pending = true
      ;(a as Automation & { pendingPrompt?: string }).pendingPrompt = prompt
      this.emit()
      return
    }
    if (s!.status === 'idle') this.sessions.sendPrompt(s!.id, `[Scheduled: ${a.name}] ${prompt}`, 'steer')
    else {
      a.pending = true
      ;(a as Automation & { pendingPrompt?: string }).pendingPrompt = prompt
      this.emit()
    }
  }

  private onIdle(s: SessionInfo): void {
    for (const a of this.store.data.automations) {
      if (a.kind !== 'inchat' || !a.pending || a.targetChatId !== s.agentSessionId) continue
      a.pending = false
      const p = (a as Automation & { pendingPrompt?: string }).pendingPrompt ?? a.prompt
      this.sessions.sendPrompt(s.id, `[Scheduled: ${a.name}] ${p}`, 'steer')
      this.emit()
      return
    }
  }

  private newRun(a: Automation): AutomationRun {
    const runRec: AutomationRun = {
      id: 'r' + shortId(),
      automationId: a.id,
      automationName: a.name,
      startedAt: Date.now(),
      status: 'running',
      output: '',
      unread: true,
      archived: false,
      pinned: false,
      cwd: a.cwd
    }
    this.store.data.runs.unshift(runRec)
    if (this.store.data.runs.length > 300) this.store.data.runs.length = 300
    this.emit()
    return runRec
  }

  /** Run a repo job; its step-by-step progress lives in the Jobs view, the summary lands in the inbox. */
  private async runJob(a: Automation, extra?: string): Promise<void> {
    const runRec = this.newRun(a)
    try {
      if (!a.job?.slug) throw new Error('No job selected')
      const context = [a.prompt, extra].filter((x) => x?.trim()).join('\n\n') || undefined
      const { run: jr, done } = await this.jobs.start(a.cwd, a.job.slug, a.job.options, 'schedule', context, a.job.routine ? 'routine' : 'repo')
      runRec.cwd = jr.cwd
      this.running.set(a.id, () => this.jobs.stopRun(jr.id))
      const r = await done
      this.running.delete(a.id)
      runRec.cwd = r.cwd
      runRec.worktreePath = r.worktreePath
      runRec.agentSessionId = r.agentSessionId
      runRec.costUsd = r.costUsd
      runRec.status = r.status === 'success' ? 'success' : 'error'
      runRec.output = describeRun(r)
    } catch (e) {
      this.running.delete(a.id)
      runRec.status = 'error'
      runRec.output = (e as Error).message
    }
    runRec.finishedAt = Date.now()
    this.emit()
  }

  private async runStandalone(a: Automation, extra?: string): Promise<void> {
    const runRec = this.newRun(a)
    try {
      let cwd = a.cwd
      if (a.useWorktree) {
        const wt = await createWorktree({ repoCwd: a.cwd, name: 'task' })
        touchWorktree(wt.id)
        cwd = wt.path
        runRec.worktreePath = wt.path
      }
      runRec.cwd = cwd
      runRec.provider = a.provider ?? settings().defaultProvider
      const h = runHeadless({
        provider: runRec.provider,
        prompt: extra ? `${a.prompt}\n\n${extra}` : a.prompt,
        cwd,
        model: a.model,
        effort: a.effort,
        permissionMode: a.permissionMode,
        onSession: (id) => (runRec.agentSessionId = id)
      })
      this.running.set(a.id, h.kill)
      const res = await h.done
      runRec.agentSessionId = res.sessionId ?? runRec.agentSessionId
      runRec.costUsd = res.costUsd
      runRec.output = res.text || `Exited with code ${res.code}`
      runRec.status = res.finished ? (res.isError ? 'error' : 'success') : res.code === 0 ? 'success' : 'error'
      this.running.delete(a.id)
    } catch (e) {
      runRec.status = 'error'
      runRec.output = (e as Error).message
    }
    runRec.finishedAt = Date.now()
    this.emit()
    notify('automation', undefined, `Scheduled task · ${a.name}`, truncate(runRec.output, 200))
  }

  private async pollGithub(a: Automation): Promise<void> {
    if (a.schedule.type !== 'github') return
    const gh = ghPath()
    if (!gh) return
    const sch = a.schedule
    const r = await run(gh, ['pr', 'list', '--repo', sch.repo, '--state', 'all', '--limit', '30', '--json', 'number,title,author,updatedAt,labels,state,url'], { timeout: 60_000 })
    if (r.code !== 0) return
    let prs: { number: number; title: string; author: { login: string }; updatedAt: string; labels: { name: string }[]; state: string; url: string }[] = []
    try {
      prs = JSON.parse(r.stdout)
    } catch {
      return
    }
    const seen = a.githubSeen ? Date.parse(a.githubSeen) : Date.now()
    const f = (sch.filter ?? '').toLowerCase()
    const fresh = prs.filter(
      (p) =>
        Date.parse(p.updatedAt) > seen &&
        (!f || p.title.toLowerCase().includes(f) || p.author.login.toLowerCase().includes(f) || p.labels.some((l) => l.name.toLowerCase().includes(f)))
    )
    a.githubSeen = new Date(Math.max(seen, ...prs.map((p) => Date.parse(p.updatedAt)))).toISOString()
    this.emit()
    if (!fresh.length) return
    const summary = fresh.map((p) => `- #${p.number} "${p.title}" by ${p.author.login} (${p.state}, updated ${p.updatedAt}) ${p.url}`).join('\n')
    await this.runNow(a.id, `GitHub activity in ${sch.repo} that triggered this task:\n${summary}`)
  }
}
