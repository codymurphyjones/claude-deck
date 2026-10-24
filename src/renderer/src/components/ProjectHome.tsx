import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { isOpenPr, type CurrentPr } from '@shared/repo'
import type { CommitInfo, GitInfo, Project, PullRequestSummary } from '@shared/types'
import { api, errMsg } from '../api'
import { attempt, focusSessionTab, get, loadJobs, loadScripts, openInEditor, openProcessTab, openSession, resumeChat, set, useStore } from '../store'
import { cacheGet, cacheSet } from '../viewCache'
import { Icon } from './Icon'
import { ChatBranchBar } from './ChatBranchBar'
import { WorktreeChanges } from './WorktreeChanges'
import { newChatMenu } from '../branchActions'
import { runRoutine } from './Routines'
import { useRoutines } from './Jobs'
import { shortPath, STATUS_LABEL, timeAgo, useNow } from './ui'

// A project's home tab: everything about the project in one place, with links into the full
// views. While it's the active tab, the Repository / Code review / Routines / Jobs views follow
// this project (store.tabProjectRoot), so they work before any chat is open.

interface GitSnapshot {
  info: GitInfo
  commits: CommitInfo[]
  pr: CurrentPr | null
  reviewPrs: PullRequestSummary[] | null
}

const showView = (sidebarView: 'repo' | 'reviews' | 'routines' | 'jobs', extra: Record<string, unknown> = {}): void => set({ sidebarOpen: true, sidebarView, ...extra })

export function ProjectHome({ projectId, active }: { projectId: string; active: boolean }) {
  const project = useStore((s) => s.library.projects.find((p) => p.id === projectId))
  if (!project) return <div className="empty-note">This project no longer exists. Close the tab.</div>
  return <Home project={project} active={active} />
}

function Home({ project: p, active }: { project: Project; active: boolean }) {
  const root = p.folders[0]
  const home = useStore((s) => s.homedir)
  const key = `home:${root}`
  const [git, setGit] = useState<GitSnapshot | undefined>(() => cacheGet<GitSnapshot>(key))
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  // Git and GitHub state. The last snapshot shows at once; this refreshes it.
  const load = useCallback(async () => {
    setRefreshing(true)
    setError('')
    try {
      const info = await api.git.info(root)
      const commits = info.isRepo ? await api.repo.log(root, { limit: 6 }).catch(() => []) : []
      const base: GitSnapshot = { info, commits, pr: null, reviewPrs: null }
      setGit((cur) => ({ ...base, pr: cur?.pr ?? null, reviewPrs: cur?.reviewPrs ?? null }))
      // Network lookups fill in as they arrive.
      if (info.isRepo && info.ghAvailable && info.hasRemote) {
        const [pr, reviewPrs] = await Promise.all([info.branch ? api.repo.currentPr(root).catch(() => null) : null, api.gh.list(root, 'all').catch(() => null)])
        base.pr = pr
        base.reviewPrs = reviewPrs
        setGit({ ...base })
      }
      cacheSet(key, base)
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setRefreshing(false)
    }
  }, [root, key])
  // Refresh whenever the tab is shown (it may have gone stale in the background).
  useEffect(() => {
    if (active) void load()
  }, [active, load])

  const gi = git?.info
  return (
    <div className="project-home">
      <div className="ph-head">
        <span className="ph-icon">
          <Icon name="folder" size={20} />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 className="ellipsis">{p.name}</h1>
          <div className="ph-meta">
            {p.folders.map((f) => (
              <span key={f} className="mono ellipsis" title={f}>
                {shortPath(f, home)}
              </span>
            ))}
            {gi?.isRepo && gi.branch && (
              <span className="badge">
                <Icon name="branch" size={11} /> {gi.branch}
                {gi.ahead ? ` ↑${gi.ahead}` : ''}
                {gi.behind ? ` ↓${gi.behind}` : ''}
              </span>
            )}
            {gi?.isRepo && !!gi.dirty && <span className="badge warn">{gi.dirty} changed</span>}
          </div>
        </div>
        <button className={`icon-btn ${refreshing ? 'spinning' : ''}`} title={refreshing ? 'Refreshing…' : 'Refresh'} onClick={() => void load()}>
          <Icon name="refresh" size={15} />
        </button>
      </div>

      <div className="ph-actions">
        <span className="btn-split">
          <button className="btn primary" title={gi?.branch ? `New chat on ${gi.branch}` : undefined} onClick={() => openSession('agent', { cwd: root })}>
            <Icon name="plus" size={13} /> New chat{gi?.branch ? ` on ${gi.branch}` : ''}
          </button>
          {gi?.isRepo && (
            <button className="btn primary" title="New chat on another branch" onClick={(e) => void newChatMenu(e.currentTarget, root)}>
              <Icon name="chevron-down" size={12} />
            </button>
          )}
        </span>
        <button className="btn" disabled={!gi?.isRepo} title={gi?.isRepo ? 'A chat in its own git worktree' : 'Worktrees need a Git repository'} onClick={() => openSession('agent', { cwd: root, worktree: {} })}>
          <Icon name="branch" size={13} /> New worktree chat
        </button>
        <button className="btn" onClick={() => openInEditor(root)}>
          <Icon name="code" size={13} /> Open in editor
        </button>
        <button className="btn" onClick={() => api.shell.openPath(root)}>
          <Icon name="folder-open" size={13} /> Reveal folder
        </button>
      </div>
      {error && <div className="banner warn">{error}</div>}

      <div className="ph-grid">
        <ChatsCard project={p} />
        <GitCard root={root} git={git} />
        <ActionsCard project={p} />
        <RoutinesCard root={root} />
        <PullRequestsCard git={git} />
        <WorktreesCard project={p} />
      </div>
    </div>
  )
}

function Card({ title, icon, link, children }: { title: string; icon: string; link?: { label: string; onClick: () => void }; children: ReactNode }) {
  return (
    <section className="ph-card">
      <div className="ph-card-head">
        <Icon name={icon} size={14} style={{ color: 'var(--accent)' }} />
        <span className="grow">{title}</span>
        {link && (
          <button className="btn sm ghost" onClick={link.onClick}>
            {link.label} <Icon name="chevron-right" size={12} />
          </button>
        )}
      </div>
      <div className="ph-card-body">{children}</div>
    </section>
  )
}

// ------------------------------------------------------------------ chats
function ChatsCard({ project: p }: { project: Project }) {
  const sessions = useStore((s) => s.sessions)
  const chats = useStore((s) => s.library.chats)
  useNow(60_000)
  const inProject = (dir: string): boolean => p.folders.some((f) => dir.toLowerCase().startsWith(f.toLowerCase()))
  const live = Object.values(sessions).filter((s) => s.kind === 'agent' && s.status !== 'exited' && (s.projectId === p.id || inProject(s.root)))
  const liveIds = new Set(live.map((s) => s.agentSessionId))
  const recent = chats
    .filter((c) => c.projectId === p.id && !c.archived && !c.hidden && !liveIds.has(c.agentSessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 8)
  return (
    <Card title="Chats" icon="message">
      {!live.length && !recent.length && (
        <div className="empty-note">
          No chats yet.{' '}
          <button className="btn sm" onClick={() => openSession('agent', { cwd: p.folders[0] })}>
            Start one
          </button>
        </div>
      )}
      {live.map((s) => (
        <div key={s.id} className="list-item" onClick={() => focusSessionTab(s.id)} title="Switch to this chat">
          <span className={`dot ${s.status}`} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis">{s.name}</div>
            <div className="sub ellipsis">
              {STATUS_LABEL[s.status] ?? s.status}
              {s.lastPrompt ? ` · ${s.lastPrompt.replace(/\s+/g, ' ')}` : ''}
            </div>
          </div>
        </div>
      ))}
      {recent.map((c) => (
        <div key={c.agentSessionId} className="list-item" onClick={() => void resumeChat(c.agentSessionId)} title="Resume this chat">
          <Icon name="history" size={13} style={{ color: 'var(--muted)' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis">{c.name}</div>
            <div className="sub ellipsis">
              {timeAgo(c.updatedAt)}
              {c.branch ? ` · ${c.branch}` : ''}
              {c.lastPrompt ? ` · ${c.lastPrompt.replace(/\s+/g, ' ')}` : ''}
            </div>
          </div>
        </div>
      ))}
    </Card>
  )
}

// ------------------------------------------------------------------ git
function GitCard({ root, git }: { root: string; git?: GitSnapshot }) {
  const gi = git?.info
  if (gi && !gi.isRepo)
    return (
      <Card title="Repository" icon="branch">
        <div className="empty-note">Not a Git repository.</div>
      </Card>
    )
  const openPr = git?.pr && isOpenPr(git.pr) ? git.pr : undefined
  return (
    <Card title="Changes & branch" icon="branch" link={{ label: 'Repository', onClick: () => showView('repo') }}>
      {!gi && <div className="empty-note">Loading…</div>}
      {gi && (
        <>
          <div
            className="list-item"
            onClick={() => (gi.dirty ? set({ repoDiff: { kind: 'working', view: 'unstaged', title: 'Changes', cwd: root } }) : undefined)}
            title={gi.dirty ? 'View the uncommitted changes' : undefined}
          >
            <Icon name={gi.dirty ? 'edit' : 'check'} size={13} style={{ color: gi.dirty ? 'var(--warning)' : 'var(--success)' }} />
            <span className="grow">{gi.dirty ? `${gi.dirty} uncommitted change${gi.dirty === 1 ? '' : 's'}${gi.staged ? ` (${gi.staged} staged)` : ''}` : 'Working tree clean'}</span>
            {!!gi.dirty && <Icon name="chevron-right" size={12} style={{ color: 'var(--muted)' }} />}
          </div>
          {/* Chats edit in their own worktrees, which the folder's status above doesn't include. */}
          <WorktreeChanges root={root} heading={<div className="ph-sub-label">In chat worktrees</div>} />
          {openPr && (
            <div className="list-item" onClick={() => api.shell.openExternal(openPr.url)} title="Open the pull request">
              <Icon name="pr" size={13} style={{ color: 'var(--accent)' }} />
              <span className="grow ellipsis">
                #{openPr.number} {openPr.title}
              </span>
              {openPr.isDraft && <span className="badge">draft</span>}
              {openPr.checks !== 'none' && <span className={`badge ${openPr.checks === 'pass' ? 'ok' : openPr.checks === 'fail' ? 'err' : 'warn'}`}>checks {openPr.checks}</span>}
            </div>
          )}
          <div className="ph-sub-label">Recent commits</div>
          {!git?.commits.length && <div className="empty-note">No commits yet.</div>}
          {git?.commits.map((c) => (
            <div key={c.sha} className="list-item" title={`${c.sha}\n${c.subject}`} onClick={() => set({ repoDiff: { kind: 'commit', ref: c.sha, title: `${c.short} ${c.subject}`, cwd: root } })}>
              <span className="mono muted" style={{ fontSize: 11.5 }}>
                {c.short}
              </span>
              <span className="grow ellipsis">{c.subject}</span>
              <span className="sub">{c.date}</span>
            </div>
          ))}
        </>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ actions (package.json scripts)
function ActionsCard({ project: p }: { project: Project }) {
  const pkgs = useStore((s) => s.scripts[p.id])
  const procs = useStore((s) => s.processes).filter((x) => x.projectId === p.id)
  useEffect(() => {
    if (!get().scripts[p.id]) void loadScripts(p.id)
  }, [p.id])
  const scripts = (pkgs ?? []).flatMap((pkg) => Object.keys(pkg.scripts).map((name) => ({ pkg, name })))
  const runOf = (dir: string, name: string) => procs.filter((x) => x.cwd === dir && x.script === name).sort((a, b) => b.startedAt - a.startedAt)[0]
  return (
    <Card title="Actions" icon="play" link={{ label: 'All actions', onClick: () => set({ sidebarOpen: true, sidebarView: 'actions', actionsFocus: p.id }) }}>
      {!pkgs && <div className="empty-note">Scanning scripts…</div>}
      {pkgs && !scripts.length && <div className="empty-note">No package.json scripts.</div>}
      {scripts.slice(0, 10).map(({ pkg, name }) => {
        const run = runOf(pkg.dir, name)
        const running = run?.status === 'running'
        return (
          <div key={pkg.dir + name} className="list-item" title={pkg.scripts[name]} onClick={() => run && openProcessTab(run.id)}>
            <span className={`dot ${running ? 'working' : run?.status === 'failed' ? 'needs-input' : 'idle'}`} />
            <span className="grow ellipsis">
              <span className="mono">{name}</span>
              {pkg.rel && <span className="muted"> · {pkg.rel}</span>}
            </span>
            {run && <span className="sub">{running ? 'running' : run.status}</span>}
            <button
              className="icon-btn sm"
              title={running ? 'Stop' : 'Run'}
              onClick={(e) => {
                e.stopPropagation()
                void attempt<unknown>(() => (running ? api.processes.stop(run.id) : api.processes.start(p.id, pkg.dir, name)))
              }}
            >
              <Icon name={running ? 'stop' : 'play'} size={12} />
            </button>
          </div>
        )
      })}
      {scripts.length > 10 && (
        <div className="sub" style={{ padding: '4px 8px' }}>
          +{scripts.length - 10} more in All actions
        </div>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ routines & jobs
function RoutinesCard({ root }: { root: string }) {
  const routines = useRoutines()
  const jobs = useStore((s) => s.jobDefs[root])
  useEffect(() => {
    if (!get().jobDefs[root]) void loadJobs(root)
  }, [root])
  return (
    <Card title="Routines & jobs" icon="wand" link={{ label: 'Routines', onClick: () => showView('routines') }}>
      {jobs?.map((j) => (
        <div key={`job:${j.slug}`} className="list-item" title={j.description} onClick={() => set({ jobRunFor: { root, slug: j.slug } })}>
          <Icon name="layers" size={13} style={{ color: 'var(--muted)' }} />
          <span className="grow ellipsis">{j.name}</span>
          <span className="badge">job</span>
          <Icon name="play" size={12} style={{ color: 'var(--muted)' }} />
        </div>
      ))}
      {routines?.slice(0, 8).map((r) => (
        <div key={`rt:${r.slug}`} className="list-item" title={r.description} onClick={() => runRoutine(r.slug, root)}>
          <Icon name="wand" size={13} style={{ color: 'var(--muted)' }} />
          <span className="grow ellipsis">{r.name}</span>
          <span className="sub">
            {r.steps.length} step{r.steps.length === 1 ? '' : 's'}
          </span>
          <Icon name="play" size={12} style={{ color: 'var(--muted)' }} />
        </div>
      ))}
      {routines && !routines.length && !jobs?.length && <div className="empty-note">No routines or jobs yet.</div>}
      {!!jobs?.length && (
        <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => showView('jobs', { jobsRoot: root })}>
          Repo jobs <Icon name="chevron-right" size={12} />
        </button>
      )}
    </Card>
  )
}

// ------------------------------------------------------------------ pull requests
/** GitHub's review decision, as a short label and badge style. */
const REVIEW_BADGE: Record<string, [string, string]> = {
  APPROVED: ['approved', 'ok'],
  CHANGES_REQUESTED: ['changes requested', 'err'],
  REVIEW_REQUIRED: ['needs review', 'warn']
}

function PullRequestsCard({ git }: { git?: GitSnapshot }) {
  const gi = git?.info
  const prs = git?.reviewPrs
  return (
    <Card title={prs?.length ? `Open pull requests (${prs.length})` : 'Open pull requests'} icon="pr" link={{ label: prs && prs.length > 6 ? `All ${prs.length}` : 'Pull requests', onClick: () => showView('reviews') }}>
      {gi && (!gi.ghAvailable || !gi.hasRemote) && <div className="empty-note">{!gi.hasRemote ? 'No remote configured.' : 'Install the GitHub CLI (gh) to see pull requests.'}</div>}
      {gi?.ghAvailable && gi.hasRemote && prs === null && <div className="empty-note">Loading…</div>}
      {prs && !prs.length && <div className="empty-note">No open pull requests.</div>}
      {prs?.slice(0, 6).map((pr) => (
        <div key={pr.number} className="list-item" title="Open in Pull requests" onClick={() => showView('reviews')}>
          <Icon name="pr" size={13} style={{ color: 'var(--muted)' }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis">
              #{pr.number} {pr.title}
            </div>
            <div className="sub ellipsis">
              {pr.author} · {pr.headRefName}
            </div>
          </div>
          {pr.isDraft && <span className="badge">draft</span>}
          {!pr.isDraft && pr.reviewDecision && <span className={`badge ${REVIEW_BADGE[pr.reviewDecision]?.[1] ?? ''}`}>{REVIEW_BADGE[pr.reviewDecision]?.[0] ?? pr.reviewDecision.toLowerCase()}</span>}
        </div>
      ))}
    </Card>
  )
}

// ------------------------------------------------------------------ worktrees
function WorktreesCard({ project: p }: { project: Project }) {
  const all = useStore((s) => s.library.worktrees).filter((w) => w.projectId === p.id)
  const sessions = useStore((s) => s.sessions)
  // Chats working toward a branch, each with its Merge; then other worktrees (snapshots, permanent).
  const chats = all.filter((w) => !w.deleted && w.branch && w.target)
  const wts = all.filter((w) => !chats.includes(w))
  if (!all.length) return null
  return (
    <Card title="Branches in progress" icon="branch">
      {chats.map((w) => {
        const s = Object.values(sessions).find((x) => x.worktreeId === w.id && x.kind === 'agent' && x.status !== 'exited')
        return (
          <div key={w.id} className="ph-branch">
            <div className="row" style={{ gap: 6, minWidth: 0 }}>
              {s ? <span className={`dot ${s.status}`} /> : <Icon name="history" size={12} style={{ color: 'var(--muted)' }} />}
              <span
                className="ellipsis grow"
                style={{ cursor: 'var(--cursor)' }}
                title={s ? 'Switch to this chat' : 'Open a chat in this worktree'}
                onClick={() => (s ? focusSessionTab(s.id) : openSession('agent', { cwd: w.path }))}
              >
                {s?.name ?? 'No open chat'}
              </span>
            </div>
            <ChatBranchBar worktreeId={w.id} compact />
          </div>
        )
      })}
      {wts.slice(0, 8).map((w) => (
        <div key={w.id} className="list-item" title={w.path} onClick={() => (w.deleted ? attempt(() => api.worktree.restore(w.id), 'Worktree restored') : openSession('agent', { cwd: w.path }))}>
          <Icon name="branch" size={13} style={{ color: 'var(--muted)' }} />
          <span className="grow ellipsis">{w.branch ?? w.path.split(/[\\/]/).pop()}</span>
          <span className="badge">{w.deleted ? 'snapshot' : w.permanent ? 'permanent' : 'worktree'}</span>
        </div>
      ))}
    </Card>
  )
}
