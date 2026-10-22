import { useEffect, useMemo, useRef, useState } from 'react'
import {
  jobDesignBrief,
  newJob,
  routineDesignBrief,
  newStep,
  slugify,
  type JobCheck,
  type JobDef,
  type JobPivot,
  type JobRun,
  type JobRunOptions,
  type JobSource,
  type JobStep,
  type JobStepStatus
} from '@shared/jobs'
import type { Automation } from '@shared/types'
import { api } from '../api'
import { askText, attempt, get, loadJobs, loadRoutines, openSession, set, showSidebar, toast, useStore } from '../store'
import { copyJobCard } from '../jobClipboard'
import { Icon } from './Icon'
import { Modal, openMenu, Seg, shortPath, Switch, timeAgo, useNow } from './ui'

/** Repo folders that can hold jobs: project folders, plus whatever the active chat is in. */
export function useRoots(): string[] {
  const projects = useStore((s) => s.library.projects)
  const sessions = useStore((s) => s.sessions)
  return useMemo(() => {
    const out: string[] = []
    const add = (p?: string): void => {
      if (p && !out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p)
    }
    for (const p of projects) add(p.folders[0])
    for (const s of Object.values(sessions)) if (s.kind === 'claude' && !s.worktreeId) add(s.root)
    return out
  }, [projects, sessions])
}

function useJobs(root?: string): JobDef[] | undefined {
  const defs = useStore((s) => (root ? s.jobDefs[root] : undefined))
  useEffect(() => {
    if (root && !get().jobDefs[root]) void loadJobs(root)
  }, [root])
  return defs
}

export function useRoutines(enabled = true): JobDef[] | undefined {
  const defs = useStore((s) => s.routineDefs)
  useEffect(() => {
    if (enabled && !get().routineDefs) void loadRoutines()
  }, [enabled])
  return defs
}

/** Ref for a list item being highlighted (store `flash`): bring it into view. */
export const scrollToFlash = (el: HTMLElement | null): void => el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })

const STEP_ICON: Record<JobStepStatus, [string, string]> = {
  passed: ['check', 'var(--success)'],
  failed: ['x', 'var(--danger)'],
  running: ['play', 'var(--accent)'],
  pending: ['minus', 'var(--muted)'],
  skipped: ['minus', 'var(--muted)']
}

const runBadge = (r: JobRun): string => (r.status === 'success' ? 'ok' : r.status === 'running' ? 'accent' : r.status === 'stopped' ? 'warn' : 'err')

export async function designInChat(root: string): Promise<void> {
  const goal = await askText('What should the job do? (optional — you can also describe it in the chat)', '', { multiline: true, placeholder: 'Upgrade to React 20: audit usages, migrate, fix tests, update docs' })
  if (goal === null) return
  await openSession('claude', {
    cwd: root,
    name: 'Job design',
    appendSystemPrompt: jobDesignBrief(),
    initialPrompt: goal.trim() ? `Help me design a repo job for this goal:\n${goal.trim()}` : undefined
  })
}

export async function designRoutineInChat(): Promise<void> {
  const goal = await askText('What should the routine do? (optional — you can also describe it in the chat)', '', {
    multiline: true,
    placeholder: 'A significant UI refactor: audit components, unify styling, extract shared pieces, verify nothing regressed'
  })
  if (goal === null) return
  const dir = await attempt(() => api.routines.dir())
  if (!dir) return
  await openSession('claude', {
    cwd: dir,
    name: 'Routine design',
    appendSystemPrompt: routineDesignBrief(),
    initialPrompt: goal.trim() ? `Help me design a routine for this goal:\n${goal.trim()}` : undefined
  })
}

// ------------------------------------------------------------------ sidebar
export function JobsView() {
  const roots = useRoots()
  const home = useStore((s) => s.homedir)
  const storedRoot = useStore((s) => s.jobsRoot)
  const root = storedRoot && roots.includes(storedRoot) ? storedRoot : roots[0]
  const jobs = useJobs(root)
  const runs = useStore((s) => s.jobRuns)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const flashing = useStore((s) => (s.flash?.kind === 'repo' ? s.flash.slug : undefined))
  useNow(20_000)
  const rootRuns = runs.filter((r) => r.root === root && !r.source)
  const lastRun = (slug: string): JobRun | undefined => rootRuns.find((r) => r.slug === slug)

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Jobs</span>
        <button className="btn sm" disabled={!root} onClick={() => root && set({ jobEdit: { root, draft: newJob() } })}>
          <Icon name="plus" size={13} /> New job
        </button>
        <button
          className="icon-btn sm"
          title="More"
          disabled={!root}
          onClick={(e) =>
            root &&
            openMenu(e, [
              { label: 'Design a job with Claude (chat)…', icon: 'sparkles', onClick: () => void designInChat(root) },
              { label: 'Open repo_jobs folder', icon: 'folder-open', onClick: () => void api.shell.openPath(`${root}/repo_jobs`) },
              { label: 'Reload', icon: 'refresh', onClick: () => void loadJobs(root) }
            ])
          }
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      <div className="sidebar-body">
        {roots.length > 1 && (
          <select className="select" style={{ width: '100%', margin: '4px 0 6px' }} value={root} onChange={(e) => set({ jobsRoot: e.target.value })}>
            {roots.map((r) => (
              <option key={r} value={r}>
                {shortPath(r, home)}
              </option>
            ))}
          </select>
        )}
        {!root && <div className="empty-note">Open a project to create jobs for it.</div>}
        {root && jobs && !jobs.length && (
          <div className="empty-note">
            Jobs are reusable, multi-step task orders kept in this repo's <span className="mono">repo_jobs</span> folder. Each step has a prompt, expectations Claude Deck checks (including commands such as tests), and pivots for when things go sideways.
            <div className="row" style={{ justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn sm primary" onClick={() => set({ jobEdit: { root, draft: newJob() } })}>
                Create a job
              </button>
              <button className="btn sm" onClick={() => void designInChat(root)}>
                <Icon name="sparkles" size={12} /> Design with Claude
              </button>
            </div>
          </div>
        )}
        {root &&
          jobs?.map((j) => {
            const lr = lastRun(j.slug)
            return (
              <div
                key={j.slug}
                data-card-kind="repo"
                data-card-slug={j.slug}
                data-card-root={root}
                ref={flashing === j.slug ? scrollToFlash : undefined}
                className={`list-item ${flashing === j.slug ? 'flash' : ''}`}
                style={{ alignItems: 'flex-start' }}
                onClick={() => set({ jobEdit: { root, slug: j.slug } })}
                onContextMenu={(e) =>
                  openMenu(e, [
                    { label: 'Run…', icon: 'play', onClick: () => set({ jobRunFor: { root, slug: j.slug } }) },
                    { label: 'Run with defaults', icon: 'zap', onClick: () => void startRun(root, j.slug, {}) },
                    { label: 'Edit…', icon: 'edit', onClick: () => set({ jobEdit: { root, slug: j.slug } }) },
                    { label: 'Schedule…', icon: 'clock', onClick: () => scheduleJob(root, j) },
                    { label: 'Save as routine…', icon: 'wand', onClick: () => void saveAsRoutine(j) },
                    { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', onClick: () => void copyJobCard('repo', j) },
                    { separator: true },
                    { label: 'Delete', icon: 'trash', danger: true, onClick: () => void deleteJob(root, j) }
                  ])
                }
              >
                <Icon name="layers" size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
                <div className="grow">
                  <div className="ellipsis" style={{ fontWeight: 600 }}>
                    {j.name}
                  </div>
                  <div className="sub ellipsis">
                    {j.steps.length} step{j.steps.length === 1 ? '' : 's'}
                    {lr && ` · ${lr.status === 'running' ? 'running' : `${lr.status} ${timeAgo(lr.startedAt)}`}`}
                    {!lr && j.description && ` · ${j.description}`}
                  </div>
                </div>
                <button
                  className="run-btn"
                  title="Run…"
                  onClick={(e) => {
                    e.stopPropagation()
                    set({ jobRunFor: { root, slug: j.slug } })
                  }}
                >
                  <Icon name="play" size={11} /> Run
                </button>
              </div>
            )
          })}
        {root && (
          <>
            <div className="section-label">
              <span className="grow">Runs</span>
            </div>
            {!rootRuns.length && <div className="empty-note">Job runs show their step-by-step progress here.</div>}
            {rootRuns.slice(0, 40).map((r) => (
              <RunItem key={r.id} r={r} open={openRun === r.id} onToggle={() => setOpenRun(openRun === r.id ? null : r.id)} />
            ))}
          </>
        )}
      </div>
    </>
  )
}

export function RunItem({ r, open, onToggle }: { r: JobRun; open: boolean; onToggle: () => void }) {
  const done = r.steps.filter((s) => s.status === 'passed').length
  const total = r.steps.filter((s) => s.status !== 'skipped' || r.status === 'running').length
  return (
    <div>
      <div
        className="list-item"
        style={{ alignItems: 'flex-start' }}
        onClick={() => {
          onToggle()
          if (r.unread && r.status !== 'running') void api.jobs.updateRun(r.id, { unread: false })
        }}
      >
        {r.unread && r.status !== 'running' ? <span className="dot working" style={{ marginTop: 5, animation: 'none' }} /> : <span style={{ width: 8 }} />}
        <div className="grow">
          <div className="row" style={{ gap: 6 }}>
            <span className="ellipsis" style={{ fontWeight: 600 }}>
              {r.jobName}
            </span>
            <span className={`badge ${runBadge(r)}`}>{r.status}</span>
          </div>
          <div className="sub ellipsis">
            {r.source === 'routine' && `${r.root.split(/[\\/]/).pop()} · `}
            {done}/{total} steps{r.branch && ` · ${r.branch}`}
            {r.trigger === 'schedule' && ' · scheduled'}
          </div>
        </div>
        <span className="sub">{timeAgo(r.startedAt)}</span>
      </div>
      {open && <RunDetail r={r} />}
    </div>
  )
}

function RunDetail({ r }: { r: JobRun }) {
  const [openStep, setOpenStep] = useState<string | null>(null)
  const ws = r.worktreePath ?? r.cwd
  return (
    <div className="card" style={{ margin: '4px 6px 10px', padding: 10, boxShadow: 'none' }}>
      {r.error && (
        <div className="selectable" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap', fontSize: 12.5, marginBottom: 8 }}>
          {r.error}
        </div>
      )}
      <div className="col" style={{ gap: 2 }}>
        {r.steps.map((s, i) => {
          const [icon, color] = STEP_ICON[s.status]
          const expanded = openStep === s.stepId
          return (
            <div key={s.stepId}>
              <div className="job-step-run" onClick={() => setOpenStep(expanded ? null : s.stepId)}>
                {s.status === 'running' ? <span className="dot working" style={{ marginTop: 5 }} /> : <Icon name={icon} size={13} style={{ color, marginTop: 2 }} />}
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ opacity: s.status === 'skipped' ? 0.55 : 1 }}>
                    {i + 1}. {s.title}
                    {s.attempts > 1 && <span className="muted"> · attempt {s.attempts}</span>}
                  </div>
                  {s.summary && <div className={`sub ${expanded ? '' : 'ellipsis'}`}>{s.summary}</div>}
                </div>
              </div>
              {expanded && (s.checks.length > 0 || s.pivot) && (
                <div style={{ padding: '2px 0 6px 21px', fontSize: 12 }}>
                  {s.pivot && (
                    <div className="muted" style={{ marginBottom: 4 }}>
                      <Icon name="undo" size={11} /> Pivot taken: {s.pivot}
                    </div>
                  )}
                  {s.checks.map((c, k) => (
                    <details key={k} style={{ marginBottom: 2 }}>
                      <summary style={{ color: c.ok ? 'var(--success)' : 'var(--danger)', cursor: 'var(--cursor)' }}>
                        {c.ok ? '✓' : '✗'} {c.kind === 'command' ? <span className="mono">{c.text}</span> : c.text}
                      </summary>
                      {c.output && (
                        <pre className="selectable mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto', fontSize: 11, margin: '4px 0' }}>
                          {c.output}
                        </pre>
                      )}
                    </details>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {r.status === 'running' && (
          <button className="btn sm danger" onClick={() => api.jobs.stop(r.id)}>
            <Icon name="stop" size={12} /> Stop
          </button>
        )}
        {r.claudeSessionId && r.status !== 'running' && (
          <button className="btn sm primary" onClick={() => openSession('claude', { cwd: ws, resumeId: r.claudeSessionId, name: r.jobName })}>
            Continue as chat
          </button>
        )}
        {r.worktreePath && (
          <button className="btn sm" onClick={() => api.shell.openPath(r.worktreePath!)}>
            <Icon name="folder-open" size={12} /> Worktree
          </button>
        )}
        {r.worktreePath && r.branch && r.status !== 'running' && (
          <>
            <button className="btn sm" onClick={() => attempt(() => api.git.push(r.worktreePath!), `Pushed ${r.branch}`)}>
              <Icon name="upload" size={12} /> Push
            </button>
            <button
              className="btn sm"
              onClick={async () => {
                const url = await attempt(() => api.git.createPr(r.worktreePath!, { title: `${r.source === 'routine' ? 'Routine' : 'Job'}: ${r.jobName}`, body: prBody(r), draft: true }))
                if (url) void api.shell.openExternal(url)
              }}
            >
              <Icon name="pr" size={12} /> Draft PR
            </button>
          </>
        )}
        {r.status !== 'running' && (
          <button className="btn sm ghost" title="Remove from history" onClick={() => api.jobs.removeRun(r.id)}>
            <Icon name="trash" size={12} />
          </button>
        )}
        <span className="grow" />
        {r.costUsd > 0 && <span className="muted" style={{ fontSize: 11 }}>${r.costUsd.toFixed(3)}</span>}
      </div>
    </div>
  )
}

function prBody(r: JobRun): string {
  const lines = r.steps.filter((s) => s.status !== 'skipped').map((s) => `- [${s.status === 'passed' ? 'x' : ' '}] **${s.title}**${s.summary ? ` — ${s.summary}` : ''}`)
  return `Automated run of ${r.source === 'routine' ? 'routine' : 'repo job'} \`${r.slug}\`.\n\n${lines.join('\n')}`
}

export async function startRun(root: string, slug: string, opts: Partial<JobRunOptions>, extra?: string, source: JobSource = 'repo'): Promise<boolean> {
  const run = await attempt(() => (source === 'routine' ? api.routines.run(root, slug, opts, extra) : api.jobs.run(root, slug, opts, extra)))
  if (!run) return false
  toast(`Started “${run.jobName}”`, 'success')
  if (source === 'routine') set({ sidebarOpen: true, sidebarView: 'routines' })
  else set({ sidebarOpen: true, sidebarView: 'jobs', jobsRoot: root })
  return true
}

function scheduleJob(root: string, j: JobDef): void {
  set({ jobEdit: false, automationEdit: { kind: 'job', name: j.name, prompt: '', cwd: root, job: { slug: j.slug, options: {} } } })
}

export function scheduleRoutine(j: JobDef, cwd = ''): void {
  set({ routineEdit: false, automationEdit: { kind: 'job', name: j.name, prompt: '', cwd, job: { slug: j.slug, options: {}, routine: true } } })
}

async function saveAsRoutine(j: JobDef): Promise<void> {
  const existing = get().routineDefs ?? (await loadRoutines())
  if (existing.some((r) => r.slug === j.slug)) {
    const c = await api.dialog.confirm(`A routine named "${j.slug}" already exists. Replace it?`, undefined, ['Replace', 'Cancel'])
    if (c !== 0) return
  }
  await attempt(() => api.routines.save(j), 'Saved as routine')
}

export async function deleteRoutine(j: JobDef): Promise<boolean> {
  const r = await api.dialog.confirm(`Delete routine "${j.name}"?`, `This removes ~/.claude-deck/routines/${j.slug}.`, ['Delete', 'Cancel'])
  if (r !== 0) return false
  return (await attempt(() => api.routines.remove(j.slug), 'Routine deleted')) !== undefined
}

async function deleteJob(root: string, j: JobDef): Promise<boolean> {
  const r = await api.dialog.confirm(`Delete job "${j.name}"?`, `This removes repo_jobs/${j.slug} from the repository.`, ['Delete', 'Cancel'])
  if (r !== 0) return false
  return (await attempt(() => api.jobs.remove(root, j.slug), 'Job deleted')) !== undefined
}

// ------------------------------------------------------------------ run options
/** `root` is the repo the run targets; without one (routine defaults) the branch picker is hidden. */
export function RunOptionsFields({ root, job, value, onChange }: { root?: string; job?: JobDef; value: Partial<JobRunOptions>; onChange: (v: Partial<JobRunOptions>) => void }) {
  const [branches, setBranches] = useState<string[]>([])
  const [current, setCurrent] = useState<string>()
  useEffect(() => {
    setBranches([])
    setCurrent(undefined)
    if (!root) return
    void api.git.branches(root).then(setBranches, () => setBranches([]))
    void api.git.info(root).then((g) => setCurrent(g.branch), () => undefined)
  }, [root])
  const d = job?.defaults ?? {}
  const workspace = value.workspace ?? d.workspace ?? 'worktree'
  const branchMode = value.branchMode ?? d.branchMode ?? 'new'
  const branch = value.branch ?? d.branch ?? ''
  const stepMode = value.onlyStep !== undefined ? 'only' : value.fromStep ? 'from' : 'all'
  const target = branch || current || 'the current branch'
  return (
    <>
      {root && (
        <label className="field">
          Branch
          <select className="select" value={branch} onChange={(e) => onChange({ ...value, branch: e.target.value || undefined })}>
            <option value="">Current branch{current ? ` (${current})` : ''}</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Workspace
        <Seg
          value={workspace}
          onChange={(w) => onChange({ ...value, workspace: w })}
          options={[
            ['worktree', 'Isolated worktree'],
            ['inplace', 'Working copy']
          ]}
        />
      </label>
      {workspace === 'worktree' ? (
        <label className="field">
          Commits
          <Seg
            value={branchMode}
            onChange={(m) => onChange({ ...value, branchMode: m })}
            options={[
              ['new', `New branch from ${target}`],
              ['direct', `Directly onto ${target}`]
            ]}
          />
          <span className="muted" style={{ fontSize: 11.5 }}>
            Each step that passes is committed. {branchMode === 'direct' ? 'The branch must not be checked out elsewhere (e.g. in your working copy).' : 'Review, push or open a PR from the run afterwards.'}
          </span>
        </label>
      ) : (
        <div className="muted" style={{ fontSize: 11.5 }}>
          Runs in your working copy{branch && branch !== current ? ` after switching to ${branch} (needs a clean tree)` : ''}. Changes are left uncommitted.
        </div>
      )}
      {job && job.steps.length > 1 && (
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field grow">
            Steps
            <Seg
              value={stepMode}
              onChange={(m) => onChange({ ...value, fromStep: m === 'from' ? Math.max(1, value.fromStep ?? 1) : undefined, onlyStep: m === 'only' ? value.onlyStep ?? 0 : undefined })}
              options={[
                ['all', 'All'],
                ['from', 'Starting at…'],
                ['only', 'Only…']
              ]}
            />
          </label>
          {stepMode !== 'all' && (
            <select
              className="select grow"
              value={stepMode === 'only' ? value.onlyStep : value.fromStep}
              onChange={(e) => onChange({ ...value, [stepMode === 'only' ? 'onlyStep' : 'fromStep']: +e.target.value })}
            >
              {job.steps.map((s, i) => (
                <option key={s.id} value={i}>
                  {i + 1}. {s.title}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="row">
        <label className="field grow">
          Model
          <input className="input" value={value.model ?? ''} placeholder={d.model || 'default'} onChange={(e) => onChange({ ...value, model: e.target.value || undefined })} />
        </label>
        <label className="field grow">
          Effort
          <select className="select" value={value.effort ?? ''} onChange={(e) => onChange({ ...value, effort: e.target.value || undefined })}>
            <option value="">{d.effort ? `job default (${d.effort})` : 'default'}</option>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          Permissions
          <PermissionSelect value={value.permissionMode} fallback={d.permissionMode} onChange={(permissionMode) => onChange({ ...value, permissionMode })} />
        </label>
      </div>
    </>
  )
}

export function PermissionSelect({ value, fallback, onChange }: { value?: string; fallback?: string; onChange: (v?: string) => void }) {
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{fallback ? `job default (${fallback})` : 'default (workspace edits)'}</option>
      <option value="acceptEdits">Workspace edits</option>
      <option value="auto">Auto</option>
      <option value="bypassPermissions">Full access</option>
      <option value="plan">Read-only (plan)</option>
    </select>
  )
}

export function JobRunDialog() {
  const req = useStore((s) => s.jobRunFor)
  const jobs = useJobs(req ? req.root : undefined)
  const [opts, setOpts] = useState<Partial<JobRunOptions>>({})
  const [extra, setExtra] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setOpts(req && req.step !== undefined ? { onlyStep: req.step } : {})
    setExtra('')
  }, [req])
  if (!req) return null
  const job = jobs?.find((j) => j.slug === req.slug)
  const close = (): void => set({ jobRunFor: false })
  return (
    <Modal
      title={`Run “${job?.name ?? req.slug}”`}
      icon="play"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !job}
            onClick={async () => {
              setBusy(true)
              const ok = await startRun(req.root, req.slug, opts, extra)
              setBusy(false)
              if (ok) close()
            }}
          >
            {busy ? 'Starting…' : 'Run'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {job ? <RunOptionsFields root={req.root} job={job} value={opts} onChange={setOpts} /> : <div className="muted">Loading job…</div>}
        <label className="field">
          Additional context <span className="muted">(optional)</span>
          <textarea className="textarea" rows={3} value={extra} placeholder="Anything specific to this run: an area to focus on, an issue link, constraints…" onChange={(e) => setExtra(e.target.value)} />
        </label>
        <div className="muted" style={{ fontSize: 12 }}>
          Runs are unattended: anything that would need an approval prompt is denied automatically.
        </div>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------ designer
type Sel = 'overview' | number

/** Designer for repo jobs, or (scope "routine") for app-level routines, which share the same shape. */
export function JobDesigner({ scope = 'repo' }: { scope?: JobSource }) {
  const isRoutine = scope === 'routine'
  const jobEdit = useStore((s) => s.jobEdit)
  const routineEdit = useStore((s) => s.routineEdit)
  const edit = isRoutine ? routineEdit : jobEdit
  const root = !isRoutine && jobEdit ? jobEdit.root : undefined
  const repoJobs = useJobs(root)
  const routines = useRoutines(isRoutine && !!edit)
  const jobs = isRoutine ? routines : repoJobs
  const noun = isRoutine ? 'routine' : 'job'
  const [job, setJob] = useState<JobDef | null>(null)
  const [origSlug, setOrigSlug] = useState<string>()
  const [sel, setSel] = useState<Sel>('overview')
  const [dirty, setDirty] = useState(false)
  const [assist, setAssist] = useState('')
  const [assisting, setAssisting] = useState(false)
  const undo = useRef<JobDef | null>(null)

  useEffect(() => {
    if (!edit) return setJob(null)
    if (edit.draft) {
      setJob(edit.draft)
      setOrigSlug(undefined)
      setDirty(true)
    } else {
      const j = jobs?.find((x) => x.slug === edit.slug)
      if (!j) return
      setJob(structuredClone(j))
      setOrigSlug(j.slug)
      setDirty(false)
    }
    setSel('overview')
    undo.current = null
    // Only (re)load when the target changes, not when the file watcher refreshes the list.
  }, [edit, !!jobs])

  if (!edit || !job) return null
  const dismiss = (): void => set(isRoutine ? { routineEdit: false } : { jobEdit: false })
  const update = (patch: Partial<JobDef>): void => {
    setJob({ ...job, ...patch })
    setDirty(true)
  }
  const updateStep = (i: number, patch: Partial<JobStep>): void => update({ steps: job.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) })
  const close = async (): Promise<void> => {
    if (dirty && job.steps.some((s) => s.prompt.trim())) {
      const r = await api.dialog.confirm(`Discard unsaved changes to this ${noun}?`, undefined, ['Discard', 'Keep editing'])
      if (r !== 0) return
    }
    dismiss()
  }
  const save = async (): Promise<JobDef | undefined> => {
    if (!job.name.trim()) return void toast(`Give the ${noun} a name`, 'error')
    const input = { ...job, slug: origSlug ?? slugify(job.name) }
    const saved = await attempt(() => (isRoutine ? api.routines.save(input, origSlug) : api.jobs.save(root!, input, origSlug)), isRoutine ? 'Routine saved' : 'Job saved')
    if (!saved) return undefined
    setJob(saved)
    setOrigSlug(saved.slug)
    setDirty(false)
    void (isRoutine ? loadRoutines() : loadJobs(root!))
    return saved
  }
  const runAssist = async (): Promise<void> => {
    if (!assist.trim()) return
    setAssisting(true)
    const hasContent = job.steps.some((s) => s.prompt.trim()) || job.description.trim()
    const current = hasContent ? job : undefined
    const r = await attempt(() => (isRoutine ? api.routines.assist(assist.trim(), current) : api.jobs.assist(root!, assist.trim(), current)))
    setAssisting(false)
    if (!r) return
    undo.current = job
    setJob({ ...r, slug: origSlug ?? r.slug })
    setDirty(true)
    setSel('overview')
    setAssist('')
    toast(`${isRoutine ? 'Routine' : 'Job'} ${hasContent ? 'revised' : 'drafted'} — review and save`, 'success')
  }
  const moveStep = (i: number, d: -1 | 1): void => {
    const j = i + d
    if (j < 0 || j >= job.steps.length) return
    const steps = [...job.steps]
    ;[steps[i], steps[j]] = [steps[j], steps[i]]
    update({ steps })
    setSel(j)
  }
  const removeStep = (i: number): void => {
    update({ steps: job.steps.filter((_, k) => k !== i) })
    setSel(job.steps.length > 1 ? Math.max(0, i - 1) : 'overview')
  }
  const addStep = (): void => {
    const s = newStep(`Step ${job.steps.length + 1}`, job.steps.map((x) => x.id))
    update({ steps: [...job.steps, s] })
    setSel(job.steps.length)
  }
  const step = typeof sel === 'number' ? job.steps[sel] : undefined

  return (
    <Modal
      wide
      title={
        <span className="row" style={{ gap: 8 }}>
          {origSlug ? `Edit ${noun}` : `New ${noun}`}
          <span className="badge mono">
            {isRoutine ? 'routines' : 'repo_jobs'}/{origSlug ?? slugify(job.name)}
          </span>
          {dirty && <span className="badge warn">unsaved</span>}
        </span>
      }
      icon={isRoutine ? 'wand' : 'layers'}
      onClose={() => void close()}
      footer={
        <>
          {origSlug && (
            <button
              className="btn danger"
              style={{ marginRight: 'auto' }}
              onClick={async () => {
                const target = { ...job, slug: origSlug }
                if (await (isRoutine ? deleteRoutine(target) : deleteJob(root!, target))) dismiss()
              }}
            >
              Delete
            </button>
          )}
          <button
            className="btn"
            onClick={async () => {
              const s = dirty ? await save() : job
              if (s) isRoutine ? scheduleRoutine(s) : scheduleJob(root!, s)
            }}
          >
            <Icon name="clock" size={13} /> Schedule…
          </button>
          <button
            className="btn"
            onClick={async () => {
              const s = dirty ? await save() : job
              const step = typeof sel === 'number' ? sel : undefined
              if (!s) return
              if (isRoutine) set({ routineEdit: false, routineRunFor: { slug: s.slug, step } })
              else set({ jobEdit: false, jobRunFor: { root: root!, slug: s.slug, step } })
            }}
          >
            <Icon name="play" size={13} /> {typeof sel === 'number' ? 'Run step…' : 'Run…'}
          </button>
          <button className="btn" onClick={() => void close()}>
            Close
          </button>
          <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="jd-assist">
        <Icon name="sparkles" size={15} style={{ color: 'var(--accent)', marginTop: 8 }} />
        <textarea
          className="textarea grow"
          rows={1}
          value={assist}
          disabled={assisting}
          placeholder={
            job.steps.some((s) => s.prompt.trim())
              ? `Ask Claude to revise this ${noun}: “add a verification step that runs the e2e suite”, “split step 2 into smaller steps”…`
              : isRoutine
                ? 'Describe the routine and Claude drafts it: “a significant UI refactor: audit, unify styling, extract shared components, verify”…'
                : 'Describe the job and Claude drafts it from your repo: “migrate the settings store to zod with tests and docs”…'
          }
          onChange={(e) => setAssist(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void runAssist()
            }
          }}
        />
        <button className="btn primary" disabled={assisting || !assist.trim()} onClick={() => void runAssist()}>
          {assisting ? (isRoutine ? 'Claude is drafting…' : 'Claude is exploring the repo…') : job.steps.some((s) => s.prompt.trim()) ? 'Revise' : 'Draft'}
        </button>
        {undo.current && !assisting && (
          <button
            className="btn ghost"
            title="Undo the last Claude edit"
            onClick={() => {
              setJob(undo.current)
              undo.current = null
            }}
          >
            <Icon name="undo" size={13} />
          </button>
        )}
        <button className="btn ghost" title="Design interactively in a chat (Claude edits the files)" onClick={() => void (isRoutine ? designRoutineInChat() : designInChat(root!))}>
          <Icon name="message" size={13} />
        </button>
      </div>
      <div className="job-designer">
        <div className="jd-nav">
          <div className={`list-item ${sel === 'overview' ? 'active' : ''}`} onClick={() => setSel('overview')}>
            <Icon name="target" size={14} />
            <span className="grow ellipsis">Overview</span>
          </div>
          <div className="section-label">Steps</div>
          {job.steps.map((s, i) => (
            <div
              key={s.id + i}
              className={`list-item ${sel === i ? 'active' : ''}`}
              onClick={() => setSel(i)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Move up', icon: 'chevron-left', onClick: () => moveStep(i, -1) },
                  { label: 'Move down', icon: 'chevron-right', onClick: () => moveStep(i, 1) },
                  {
                    label: 'Duplicate',
                    icon: 'copy',
                    onClick: () => {
                      const copy = { ...structuredClone(s), id: newStep(s.title, job.steps.map((x) => x.id)).id }
                      update({ steps: [...job.steps.slice(0, i + 1), copy, ...job.steps.slice(i + 1)] })
                    }
                  },
                  { separator: true },
                  { label: 'Delete step', icon: 'trash', danger: true, onClick: () => removeStep(i) }
                ])
              }
            >
              <span className="jd-num">{i + 1}</span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis">{s.title || 'Untitled step'}</div>
                <div className="sub ellipsis">
                  {s.expectations.length} expectation{s.expectations.length === 1 ? '' : 's'}
                  {s.pivots.length > 0 && ` · ${s.pivots.length} pivot${s.pivots.length === 1 ? '' : 's'}`}
                </div>
              </div>
              <span className="actions">
                <button className="icon-btn sm" title="Move up" onClick={(e) => (e.stopPropagation(), moveStep(i, -1))}>
                  <Icon name="chevron-down" size={12} style={{ transform: 'rotate(180deg)' }} />
                </button>
                <button className="icon-btn sm" title="Move down" onClick={(e) => (e.stopPropagation(), moveStep(i, 1))}>
                  <Icon name="chevron-down" size={12} />
                </button>
              </span>
            </div>
          ))}
          <button className="btn sm ghost" style={{ margin: '6px 4px' }} onClick={addStep}>
            <Icon name="plus" size={12} /> Add step
          </button>
        </div>
        <div className="jd-edit">
          {sel === 'overview' || !step ? (
            <OverviewEditor job={job} update={update} root={root} />
          ) : (
            <StepEditor key={sel} step={step} index={sel as number} total={job.steps.length} onChange={(p) => updateStep(sel as number, p)} onRemove={() => removeStep(sel as number)} />
          )}
        </div>
      </div>
    </Modal>
  )
}

function OverviewEditor({ job, update, root }: { job: JobDef; update: (p: Partial<JobDef>) => void; root?: string }) {
  const [showDefaults, setShowDefaults] = useState(Object.keys(job.defaults).length > 0)
  return (
    <>
      <label className="field">
        Name
        <input className="input" value={job.name} placeholder="Upgrade dependencies" onChange={(e) => update({ name: e.target.value })} />
      </label>
      <label className="field">
        Goal
        <textarea className="textarea" rows={2} value={job.description} placeholder="What this job achieves overall, in a sentence or two." onChange={(e) => update({ description: e.target.value })} />
      </label>
      <label className="field">
        Shared context <span className="muted">(context.md — given to Claude at the start of every run)</span>
        <textarea
          className="textarea mono"
          rows={7}
          value={job.context}
          placeholder={'Background, constraints and conventions every step should know.\n- Never change the public API of src/shared\n- Use the existing test helpers in tests/'}
          onChange={(e) => update({ context: e.target.value })}
        />
      </label>
      <PivotList
        label="Job-wide pivots"
        hint="Apply to every step."
        pivots={job.pivots}
        onChange={(pivots) => update({ pivots })}
      />
      <div className="row" style={{ cursor: 'var(--cursor)' }} onClick={() => setShowDefaults((v) => !v)}>
        <Icon name={showDefaults ? 'chevron-down' : 'chevron-right'} size={13} />
        <span style={{ fontWeight: 600 }}>Run defaults</span>
        <span className="muted" style={{ fontSize: 12 }}>
          used when running or scheduling unless overridden
        </span>
      </div>
      {showDefaults && <RunOptionsFields root={root} value={job.defaults} onChange={(defaults) => update({ defaults: { ...defaults, fromStep: undefined, onlyStep: undefined } })} />}
    </>
  )
}

function StepEditor({ step, index, total, onChange, onRemove }: { step: JobStep; index: number; total: number; onChange: (p: Partial<JobStep>) => void; onRemove: () => void }) {
  return (
    <>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field grow">
          Step {index + 1} of {total}
          <input className="input" value={step.title} placeholder="Investigate the current implementation" onChange={(e) => onChange({ title: e.target.value })} />
        </label>
        <button className="icon-btn" title="Delete step" onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <label className="field">
        Prompt <span className="muted">(steps/{step.id}.md)</span>
        <textarea
          className="textarea mono"
          rows={10}
          value={step.prompt}
          placeholder="Tell Claude exactly what to do in this step. Earlier steps' conversation is available unless this step starts a fresh session."
          onChange={(e) => onChange({ prompt: e.target.value })}
        />
      </label>
      <CheckList checks={step.expectations} onChange={(expectations) => onChange({ expectations })} />
      <PivotList label="Pivots" hint="If this happens → do this instead." pivots={step.pivots} onChange={(pivots) => onChange({ pivots })} />
      <div className="row" style={{ flexWrap: 'wrap', gap: 14 }}>
        <label className="field">
          Attempts
          <input className="input" type="number" min={1} max={10} style={{ width: 80 }} value={step.maxAttempts} onChange={(e) => onChange({ maxAttempts: Math.max(1, Math.min(10, +e.target.value || 1)) })} />
        </label>
        <label className="field">
          If it still fails
          <select className="select" value={step.onFail} onChange={(e) => onChange({ onFail: e.target.value as JobStep['onFail'] })}>
            <option value="stop">Stop the job</option>
            <option value="continue">Continue with the next step</option>
          </select>
        </label>
        <div className="row" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
          <Switch on={!!step.freshSession} onChange={(freshSession) => onChange({ freshSession: freshSession || undefined })} />
          <span>Fresh conversation</span>
        </div>
      </div>
    </>
  )
}

function CheckList({ checks, onChange }: { checks: JobCheck[]; onChange: (c: JobCheck[]) => void }) {
  const set = (i: number, p: Partial<JobCheck>): void => onChange(checks.map((c, k) => (k === i ? { ...c, ...p } : c)))
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <span style={{ fontWeight: 600 }}>Expectations</span>
        <span className="muted grow" style={{ fontSize: 12 }}>
          Outcomes Claude must reach. Commands are run by Claude Deck and must exit 0.
        </span>
        <button className="btn sm ghost" onClick={() => onChange([...checks, { kind: 'text', text: '' }])}>
          <Icon name="plus" size={12} /> Outcome
        </button>
        <button className="btn sm ghost" onClick={() => onChange([...checks, { kind: 'command', text: '' }])}>
          <Icon name="terminal" size={12} /> Command
        </button>
      </div>
      {checks.map((c, i) => (
        <div key={i} className="row">
          <select className="select" style={{ width: 110 }} value={c.kind} onChange={(e) => set(i, { kind: e.target.value as JobCheck['kind'] })}>
            <option value="text">Outcome</option>
            <option value="command">Command</option>
          </select>
          <input
            className={`input grow ${c.kind === 'command' ? 'mono' : ''}`}
            value={c.text}
            placeholder={c.kind === 'command' ? 'npm test' : 'All call sites use the new API'}
            onChange={(e) => set(i, { text: e.target.value })}
          />
          {c.kind === 'command' && (
            <input
              className="input"
              type="number"
              min={10}
              style={{ width: 80 }}
              title="Timeout (seconds)"
              placeholder="600s"
              value={c.timeoutSec ?? ''}
              onChange={(e) => set(i, { timeoutSec: +e.target.value || undefined })}
            />
          )}
          <button className="icon-btn sm" title="Remove" onClick={() => onChange(checks.filter((_, k) => k !== i))}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function PivotList({ label, hint, pivots, onChange }: { label: string; hint: string; pivots: JobPivot[]; onChange: (p: JobPivot[]) => void }) {
  const set = (i: number, p: Partial<JobPivot>): void => onChange(pivots.map((c, k) => (k === i ? { ...c, ...p } : c)))
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span className="muted grow" style={{ fontSize: 12 }}>
          {hint}
        </span>
        <button className="btn sm ghost" onClick={() => onChange([...pivots, { when: '', then: '' }])}>
          <Icon name="plus" size={12} /> Pivot
        </button>
      </div>
      {pivots.map((p, i) => (
        <div key={i} className="row">
          <span className="muted" style={{ fontSize: 12 }}>
            If
          </span>
          <input className="input grow" value={p.when} placeholder="the migration breaks more than 20 tests" onChange={(e) => set(i, { when: e.target.value })} />
          <Icon name="arrow" size={13} style={{ color: 'var(--muted)' }} />
          <input className="input grow" value={p.then} placeholder="revert, migrate one module at a time and report" onChange={(e) => set(i, { then: e.target.value })} />
          <button className="icon-btn sm" title="Remove" onClick={() => onChange(pivots.filter((_, k) => k !== i))}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

type ScheduledJob = NonNullable<Automation['job']>

/** Job/routine picker + options for scheduled tasks of kind "job". A routine runs on the task's folder. */
export function ScheduledJobFields({ root, value, onChange }: { root: string; value?: ScheduledJob; onChange: (v: ScheduledJob) => void }) {
  const isRoutine = !!value?.routine
  const repoJobs = useJobs(!isRoutine && root ? root : undefined)
  const routines = useRoutines(isRoutine)
  const jobs = isRoutine ? routines : repoJobs
  const job = jobs?.find((j) => j.slug === value?.slug)
  const routine = isRoutine ? { routine: true } : {}
  return (
    <>
      <Seg
        value={isRoutine ? 'routine' : 'repo'}
        onChange={(s) => onChange({ slug: '', options: {}, ...(s === 'routine' ? { routine: true } : {}) })}
        options={[
          ['repo', "Repo job (this folder's repo_jobs)"],
          ['routine', 'Routine (app-level)']
        ]}
      />
      <label className="field">
        {isRoutine ? 'Routine' : 'Job'}
        <select className="select" value={value?.slug ?? ''} onChange={(e) => onChange({ slug: e.target.value, options: {}, ...routine })}>
          <option value="">
            {jobs?.length ? `Choose a ${isRoutine ? 'routine' : 'job'}…` : isRoutine ? 'No routines yet' : root ? 'No jobs in this folder yet' : 'Choose a folder first'}
          </option>
          {jobs?.map((j) => (
            <option key={j.slug} value={j.slug}>
              {j.name} ({j.steps.length} steps)
            </option>
          ))}
        </select>
      </label>
      {job && <RunOptionsFields root={root || undefined} job={job} value={value?.options ?? {}} onChange={(options) => onChange({ slug: job.slug, options, ...routine })} />}
    </>
  )
}

export const jobsRailPip = (runs: JobRun[], source: JobSource = 'repo'): number =>
  runs.filter((r) => r.unread && r.status !== 'running' && (source === 'routine') === (r.source === 'routine')).length

export function openJobsFor(root?: string): void {
  if (root) set({ jobsRoot: root })
  showSidebar('jobs')
}
