import { useEffect, useState } from 'react'
import { buildRoutineChatPrompt, buildStepPrompt, newJob, routineRunName, stepsToRun, type JobRunOptions } from '@shared/jobs'
import { api } from '../api'
import { attempt, currentProjectRoot, loadRoutines, openSession, set, showSidebar, useStore } from '../store'
import { Icon } from './Icon'
import { copyJobCard } from '../jobClipboard'
import { startableBranches } from '../branchActions'
import { AgentSelect, BranchOrChatSelect, deleteRoutine, designRoutineInChat, efforts, PermissionSelect, RunItem, RunOptionsFields, scheduleRoutine, scrollToFlash, startRun, useRoots, useRoutines } from './Jobs'
import { Modal, openMenu, Seg, shortPath, Switch, timeAgo, useNow } from './ui'

// Routines are app-level jobs (~/.claude-deck/routines) that run against any repo,
// with optional run-specific context that narrows what they touch.

async function openRoutinesFolder(): Promise<void> {
  const dir = await attempt(() => api.routines.dir())
  if (dir) void api.shell.openPath(dir)
}

// ------------------------------------------------------------------ sidebar
export function RoutinesView() {
  const routines = useRoutines()
  const runs = useStore((s) => s.jobRuns)
  const [openRun, setOpenRun] = useState<string | null>(null)
  const flashing = useStore((s) => (s.flash?.kind === 'routine' ? s.flash.slug : undefined))
  useNow(20_000)
  const routineRuns = runs.filter((r) => r.source === 'routine')
  const lastRun = (slug: string) => routineRuns.find((r) => r.slug === slug)

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Routines</span>
        <button className="btn sm" onClick={() => set({ routineEdit: { draft: newJob('New routine') } })}>
          <Icon name="plus" size={13} /> New routine
        </button>
        <button
          className="icon-btn sm"
          title="More"
          onClick={(e) =>
            openMenu(e, [
              { label: 'Run a routine…', icon: 'play', disabled: !routines?.length, onClick: () => runRoutine() },
              { label: 'Design a routine with Claude (chat)…', icon: 'sparkles', onClick: () => void designRoutineInChat() },
              { label: 'Open routines folder', icon: 'folder-open', onClick: () => void openRoutinesFolder() },
              { label: 'Reload', icon: 'refresh', onClick: () => void loadRoutines() }
            ])
          }
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      <div className="sidebar-body">
        {routines && !routines.length && (
          <div className="empty-note">
            Routines are reusable jobs kept at the app level (<span className="mono">~/.claude-deck/routines</span>), not in a repo. Run one against any project, adding context for that run such as “only the settings screen”.
            <div className="row" style={{ justifyContent: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn sm primary" onClick={() => set({ routineEdit: { draft: newJob('New routine') } })}>
                Create a routine
              </button>
              <button className="btn sm" onClick={() => void designRoutineInChat()}>
                <Icon name="sparkles" size={12} /> Design with Claude
              </button>
            </div>
          </div>
        )}
        {routines?.map((j) => {
          const lr = lastRun(j.slug)
          return (
            <div
              key={j.slug}
              data-card-kind="routine"
              data-card-slug={j.slug}
              ref={flashing === j.slug ? scrollToFlash : undefined}
              className={`list-item ${flashing === j.slug ? 'flash' : ''}`}
              style={{ alignItems: 'flex-start' }}
              onClick={() => set({ routineEdit: { slug: j.slug } })}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: 'Run…', icon: 'play', onClick: () => runRoutine(j.slug) },
                  { label: 'Edit…', icon: 'edit', onClick: () => set({ routineEdit: { slug: j.slug } }) },
                  { label: 'Schedule…', icon: 'clock', onClick: () => scheduleRoutine(j, currentProjectRoot()) },
                  { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', onClick: () => void copyJobCard('routine', j) },
                  { separator: true },
                  { label: 'Delete', icon: 'trash', danger: true, onClick: () => void deleteRoutine(j) }
                ])
              }
            >
              <Icon name="wand" size={14} style={{ marginTop: 2, color: 'var(--accent)' }} />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 600 }}>
                  {j.name}
                </div>
                <div className="sub ellipsis">
                  {j.steps.length} step{j.steps.length === 1 ? '' : 's'}
                  {lr && ` · ${lr.status === 'running' ? 'running' : `${lr.status} ${timeAgo(lr.startedAt)}`} in ${lr.root.split(/[\\/]/).pop()}`}
                  {!lr && j.description && ` · ${j.description}`}
                </div>
              </div>
              <button
                className="run-btn"
                title="Run…"
                onClick={(e) => {
                  e.stopPropagation()
                  runRoutine(j.slug)
                }}
              >
                <Icon name="play" size={11} /> Run
              </button>
            </div>
          )
        })}
        <div className="section-label">
          <span className="grow">Runs</span>
        </div>
        {!routineRuns.length && <div className="empty-note">Background routine runs show their step-by-step progress here. Interactive runs open as chats.</div>}
        {routineRuns.slice(0, 40).map((r) => (
          <RunItem key={r.id} r={r} open={openRun === r.id} onToggle={() => setOpenRun(openRun === r.id ? null : r.id)} />
        ))}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ run dialog
type Mode = 'background' | 'chat'

export function RoutineRunDialog() {
  const req = useStore((s) => s.routineRunFor)
  const routines = useRoutines(!!req)
  const roots = useRoots()
  const projects = useStore((s) => s.library.projects)
  const home = useStore((s) => s.homedir)
  const [slug, setSlug] = useState('')
  const [cwd, setCwd] = useState('')
  const [extra, setExtra] = useState('')
  const [mode, setMode] = useState<Mode>('background')
  const [opts, setOpts] = useState<Partial<JobRunOptions>>({})
  const [worktree, setWorktree] = useState(false)
  // Interactive chat: the branch ('' = checked out) or conversation it starts from.
  const [chatBranch, setChatBranch] = useState('')
  const [chatFrom, setChatFrom] = useState<string | undefined>()
  const [repoBranches, setRepoBranches] = useState<{ current?: string; held: string[]; local: string[]; remote: string[] }>({ held: [], local: [], remote: [] })
  const [preview, setPreview] = useState(false)
  const job = routines?.find((j) => j.slug === slug)

  useEffect(() => {
    if (!req) return
    setSlug(req.slug ?? '')
    setCwd(req.cwd ?? roots[0] ?? '')
    setExtra(req.context ?? '')
    setOpts(req.step !== undefined ? { onlyStep: req.step } : {})
    setPreview(false)
    setChatBranch('')
    setChatFrom(undefined)
    // Only reset when the dialog is (re)opened.
  }, [req])
  useEffect(() => {
    // One-step routines read naturally as a chat; multi-step ones benefit from the step runner.
    if (job) {
      setMode(job.steps.length === 1 ? 'chat' : 'background')
      setWorktree(job.defaults.workspace === 'worktree')
    }
  }, [job?.slug])

  useEffect(() => {
    setChatBranch('')
    setChatFrom(undefined)
    setOpts((o) => ({ ...o, branch: undefined, from: undefined }))
    if (!cwd) return setRepoBranches({ held: [], local: [], remote: [] })
    let live = true
    void startableBranches(cwd).then((b) => live && setRepoBranches(b))
    return () => {
      live = false
    }
  }, [cwd])

  if (!req) return null
  const close = (): void => set({ routineRunFor: false })
  const folders = cwd && !roots.some((r) => r.toLowerCase() === cwd.toLowerCase()) ? [cwd, ...roots] : roots
  const d = job?.defaults ?? {}

  const run = async (): Promise<void> => {
    if (!job || !cwd) return
    localStorage.setItem(LAST_CWD_KEY, cwd)
    // The dialog closes right away: progress toasts show the setup (worktrees…), and any failure
    // is toasted, so there's nothing to wait for here.
    if (mode === 'background') {
      close()
      await startRun(cwd, job.slug, opts, extra, 'routine')
      return
    }
    const project = projects.find((p) => p.folders.some((f) => f.toLowerCase() === cwd.toLowerCase()))?.name ?? cwd.split(/[\\/]/).filter(Boolean).pop()
    close()
    await openSession('agent', {
        cwd,
        name: routineRunName(job.name, project),
        provider: opts.provider ?? d.provider,
        initialPrompt: buildRoutineChatPrompt(job, extra),
        model: opts.model ?? d.model,
        effort: opts.effort ?? d.effort,
        permissionMode: opts.permissionMode ?? d.permissionMode,
        // A conversation: in its worktree, or (fresh worktree) a copy of it that merges back into it.
        // Another branch than the checked-out one always gets its own worktree.
        ...(chatFrom
          ? worktree
            ? { worktree: { from: chatFrom } }
            : { cwd: chatFrom }
          : { worktree: worktree || (chatBranch && chatBranch !== repoBranches.current) ? { target: chatBranch || undefined } : undefined })
      })
  }

  return (
    <Modal
      title={job ? `Run routine “${job.name}”` : 'Run a routine'}
      icon="wand"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!job || !cwd} onClick={() => void run()}>
            {mode === 'chat' ? 'Open chat' : 'Run'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <label className="field">
          Routine
          <select className="select" value={slug} onChange={(e) => setSlug(e.target.value)}>
            <option value="">{routines?.length ? 'Choose a routine…' : routines ? 'No routines yet' : 'Loading…'}</option>
            {routines?.map((j) => (
              <option key={j.slug} value={j.slug}>
                {j.name} ({j.steps.length} step{j.steps.length === 1 ? '' : 's'})
              </option>
            ))}
          </select>
          {job?.description && <span className="muted" style={{ fontSize: 11.5 }}>{job.description}</span>}
        </label>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field grow">
            Repository
            <select className="select" value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {!folders.length && <option value="">Choose a folder…</option>}
              {folders.map((r) => (
                <option key={r} value={r}>
                  {shortPath(r, home)}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" onClick={async () => setCwd((await api.dialog.openFolder())[0] ?? cwd)}>
            Browse…
          </button>
        </div>
        <label className="field">
          Additional context <span className="muted">(optional — narrows or refines the routine for this run)</span>
          <textarea
            className="textarea"
            rows={5}
            value={extra}
            placeholder={'Limit this run to the Settings modal (src/renderer/src/components/SettingsModal.tsx) and its styles.\nDon’t touch the sidebar or the chat view.'}
            onChange={(e) => setExtra(e.target.value)}
          />
        </label>
        <label className="field">
          Run as
          <Seg
            value={mode}
            onChange={setMode}
            options={[
              ['background', 'Background (step runner)'],
              ['chat', 'Interactive chat']
            ]}
          />
        </label>
        {job && cwd && mode === 'background' && <RunOptionsFields root={cwd} job={job} value={opts} onChange={setOpts} withChats />}
        {job && mode === 'chat' && (
          <>
            <div className="row">
              <label className="field">
                Agent
                <AgentSelect value={opts.provider ?? d.provider} onChange={(provider) => setOpts({ ...opts, provider })} />
              </label>
              <label className="field grow">
                Model
                <input className="input" value={opts.model ?? ''} placeholder={d.model || 'default'} onChange={(e) => setOpts({ ...opts, model: e.target.value || undefined })} />
              </label>
              <label className="field grow">
                Effort
                <select className="select" value={opts.effort ?? ''} onChange={(e) => setOpts({ ...opts, effort: e.target.value || undefined })}>
                  <option value="">{d.effort ? `routine default (${d.effort})` : 'default'}</option>
                  {efforts(opts.provider ?? d.provider).map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                Permissions
                <PermissionSelect value={opts.permissionMode} fallback={d.permissionMode} onChange={(permissionMode) => setOpts({ ...opts, permissionMode })} />
              </label>
            </div>
            <label className="field">
              Branch or conversation
              <BranchOrChatSelect
                root={cwd}
                branches={[...repoBranches.held, ...repoBranches.local]}
                remote={repoBranches.remote}
                current={repoBranches.current}
                branch={chatBranch}
                from={chatFrom}
                onChange={(b, f) => {
                  setChatBranch(b ?? '')
                  setChatFrom(f)
                }}
              />
            </label>
            <div className="row">
              <Switch on={worktree || (!chatFrom && !!chatBranch && chatBranch !== repoBranches.current)} onChange={setWorktree} />
              <span>
                {chatFrom
                  ? worktree
                    ? 'In a copy of the conversation (its changes included), merged back into it'
                    : 'Off: works right in the conversation’s worktree'
                  : 'Use a fresh worktree'}
              </span>
            </div>
          </>
        )}
        {job && (
          <div className="row" style={{ cursor: 'var(--cursor)' }} onClick={() => setPreview((v) => !v)}>
            <Icon name={preview ? 'chevron-down' : 'chevron-right'} size={13} />
            <span className="muted" style={{ fontSize: 12 }}>
              Preview {mode === 'chat' ? 'the first message' : "the first step's prompt"}
            </span>
          </div>
        )}
        {job && preview && (
          <pre className="selectable mono" style={{ whiteSpace: 'pre-wrap', maxHeight: 240, overflow: 'auto', fontSize: 11, margin: 0 }}>
            {mode === 'chat' ? buildRoutineChatPrompt(job, extra) : buildStepPrompt(job, stepsToRun(job, opts)[0] ?? 0, { withContext: true, extra, source: 'routine' })}
          </pre>
        )}
        <div className="muted" style={{ fontSize: 12 }}>
          {mode === 'chat'
            ? 'Opens a normal chat in the repository with the routine as its first message, so you can steer it.'
            : 'Runs unattended, step by step: anything that would need an approval prompt is denied automatically.'}
        </div>
      </div>
    </Modal>
  )
}

export function openRoutines(): void {
  showSidebar('routines')
}

const LAST_CWD_KEY = 'deck.routineCwd'

/** Opens the run dialog targeting `cwd`, else the project being worked in, else the last folder used. */
export function runRoutine(slug?: string, cwd = currentProjectRoot() ?? localStorage.getItem(LAST_CWD_KEY) ?? undefined, step?: number): void {
  set({ routineRunFor: { slug, cwd, step } })
}
