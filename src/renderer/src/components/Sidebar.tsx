import { providerOf } from '@shared/agent'
import { useEffect, useMemo, useState } from 'react'
import type { ChatRecord, Project, TranscriptSummary } from '@shared/types'
import { api } from '../api'
import { askText, attempt, focusSessionTab, get, openProjectHome, openSession, resumeChat, set, setRight, showSidebar, useStore, type SidebarView } from '../store'
import { Icon } from './Icon'
import { ScheduledView } from './Automations'
import { JobsView, jobsRailPip, openJobsFor } from './Jobs'
import { RoutinesView, runRoutine } from './Routines'
import { RepoView } from './RepoManager'
import { ActionsView } from './Actions'
import { isOpenFailure } from '@shared/processes'
import { ReviewsView } from './Reviews'
import { openMenu, Seg, shortPath, STATUS_LABEL, timeAgo, useNow } from './ui'

const VIEWS: { id: SidebarView; icon: string; title: string }[] = [
  { id: 'projects', icon: 'folder', title: 'Projects & chats' },
  { id: 'activity', icon: 'bell', title: 'Activity (Ctrl+Alt+U)' },
  { id: 'repo', icon: 'branch', title: 'Repository — changes, commits, branches' },
  { id: 'actions', icon: 'play', title: 'Actions — the project’s package.json scripts and running processes' },
  { id: 'team', icon: 'users', title: 'Teams — sessions sharing a folder' },
  { id: 'jobs', icon: 'layers', title: 'Repo jobs' },
  { id: 'routines', icon: 'wand', title: 'Routines — reusable jobs for any repo' },
  { id: 'scheduled', icon: 'clock', title: 'Scheduled tasks' },
  { id: 'reviews', icon: 'pr', title: 'Pull requests' }
]

export function Sidebar({ open }: { open: boolean }) {
  const view = useStore((s) => s.sidebarView)
  const width = useStore((s) => s.sidebarWidth)
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.automations.runs)
  const jobRuns = useStore((s) => s.jobRuns)
  // Scripts running, or failed and not looked at yet, across projects.
  const actionPip = useStore((s) => s.processes.filter((p) => p.status === 'running' || isOpenFailure(p)).length)
  const attention = Object.values(sessions).filter((s) => s.kind === 'agent' && (s.status === 'needs-input' || s.unread)).length
  const unreadRuns = runs.filter((r) => r.unread && !r.archived).length
  const teams = new Set(
    Object.values(sessions)
      .filter((s) => s.meshGroup && s.status !== 'exited')
      .map((s) => s.meshGroup)
      .filter((g, _i, arr) => arr.filter((x) => x === g).length > 1)
  ).size

  const startDrag = (e: React.MouseEvent): void => {
    const x0 = e.clientX
    const w0 = width
    const move = (ev: MouseEvent): void => set({ sidebarWidth: Math.max(200, Math.min(520, w0 + ev.clientX - x0)) })
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  return (
    <>
      <div className="rail">
        {VIEWS.map((v) => {
          const pip = v.id === 'actions' ? actionPip : v.id === 'activity' ? attention : v.id === 'scheduled' ? unreadRuns : v.id === 'jobs' ? jobsRailPip(jobRuns) : v.id === 'routines' ? jobsRailPip(jobRuns, 'routine') : v.id === 'team' ? teams : 0
          return (
            <button key={v.id} className={`icon-btn ${open && view === v.id ? 'on' : ''}`} title={v.title} onClick={() => showSidebar(v.id)}>
              <Icon name={v.icon} size={18} />
              {pip > 0 && <span className="pip">{pip}</span>}
            </button>
          )
        })}
        <div className="spacer" />
        <button className="icon-btn" title="Cross-session timeline" onClick={() => setRight('timeline')}>
          <Icon name="activity" size={18} />
        </button>
        <button className="icon-btn" title="Settings (Ctrl+,)" onClick={() => set({ settingsOpen: 'general' })}>
          <Icon name="settings" size={18} />
        </button>
      </div>
      {open && (
        <div className="sidebar" style={{ width }}>
          {view === 'projects' && <ProjectsView />}
          {view === 'activity' && <ActivityView />}
          {view === 'team' && <TeamsView />}
          {view === 'repo' && <RepoView />}
          {view === 'actions' && <ActionsView />}
          {view === 'jobs' && <JobsView />}
          {view === 'routines' && <RoutinesView />}
          {view === 'scheduled' && <ScheduledView />}
          {view === 'reviews' && <ReviewsView />}
          <div className="resizer right" onMouseDown={startDrag} />
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------------ projects
function ProjectsView() {
  const lib = useStore((s) => s.library)
  const sessions = useStore((s) => s.sessions)
  const home = useStore((s) => s.homedir)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  // The project whose home tab is showing, highlighted in the list.
  const homeProjectId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.projectId)
  const [results, setResults] = useState<{ agentSessionId: string; snippet: string }[] | null>(null)
  const [history, setHistory] = useState<TranscriptSummary[] | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  useNow()

  const liveByChat = useMemo(() => {
    const m = new Map<string, (typeof sessions)[string]>()
    for (const s of Object.values(sessions)) if (s.agentSessionId && s.status !== 'exited') m.set(s.agentSessionId, s)
    return m
  }, [sessions])

  const ql = q.toLowerCase()
  const match = (c: ChatRecord): boolean => !ql || c.name.toLowerCase().includes(ql) || (c.branch ?? '').toLowerCase().includes(ql) || (c.lastPrompt ?? '').toLowerCase().includes(ql)
  const visible = lib.chats.filter((c) => !c.archived && !c.hidden)
  const pinned = visible.filter((c) => c.pinned && match(c))
  const quick = visible.filter((c) => c.quick && !c.pinned && match(c)).slice(0, 8)
  const projects = [...lib.projects]
    .filter((p) => !ql || p.name.toLowerCase().includes(ql) || visible.some((c) => c.projectId === p.id && match(c)))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpened - a.lastOpened)

  useEffect(() => {
    if (!showHistory || history) return
    void api.library.transcripts().then(setHistory)
  }, [showHistory, history])

  const runSearch = async (): Promise<void> => {
    if (q.trim().length < 2) return setResults(null)
    setResults(await api.library.search(q.trim()))
  }

  const projectMenu = (e: React.MouseEvent, p: Project): void =>
    openMenu(e, [
      { label: 'New chat', icon: 'plus', onClick: () => openSession('agent', { cwd: p.folders[0] }) },
      { label: 'New chat in worktree', icon: 'branch', onClick: () => openSession('agent', { cwd: p.folders[0], worktree: {} }) },
      { label: 'New permanent worktree…', icon: 'layers', onClick: () => askText('Worktree name', 'feature').then<unknown>((n) => n && attempt(() => api.worktree.createPermanent(p.folders[0], n), 'Permanent worktree created')) },
      { label: 'Launch a team here…', icon: 'users', onClick: () => set({ fleetOpen: { cwd: p.folders[0] } }) },
      { label: 'Run a routine…', icon: 'wand', onClick: () => runRoutine(undefined, p.folders[0]) },
      { label: 'Manage repository', icon: 'branch', onClick: () => set({ repoRoot: p.folders[0], sidebarOpen: true, sidebarView: 'repo' }) },
      { separator: true },
      { label: p.pinned ? 'Unpin project' : 'Pin project', icon: 'pin', onClick: () => api.library.updateProject(p.id, { pinned: !p.pinned }) },
      { label: 'Rename…', icon: 'edit', onClick: () => askText('Project name', p.name).then<unknown>((n) => n && api.library.updateProject(p.id, { name: n })) },
      {
        label: 'Project instructions…',
        icon: 'note',
        onClick: () =>
          askText('Instructions applied to every chat in this project', p.instructions ?? '', { multiline: true }).then<unknown>((n) => n !== null && api.library.updateProject(p.id, { instructions: n }))
      },
      { label: 'Environment & actions…', icon: 'play', onClick: () => set({ settingsOpen: `env:${p.folders[0]}` }) },
      {
        label: 'Add folder…',
        icon: 'folder-open',
        onClick: async () => {
          for (const d of await api.dialog.openFolder()) await api.library.addFolderToProject(p.id, d)
        }
      },
      ...p.folders.slice(1).map((f) => ({ label: `Make primary: ${f.split(/[\\/]/).pop()}`, icon: 'star', onClick: () => api.library.makePrimary(p.id, f) })),
      { label: 'Reveal in Explorer', icon: 'folder-open', onClick: () => api.shell.openPath(p.folders[0]) },
      { separator: true },
      { label: 'Archive all chats', icon: 'archive', onClick: () => api.library.archiveProjectChats(p.id) },
      { label: 'Remove project', icon: 'trash', danger: true, onClick: () => api.library.removeProject(p.id) }
    ])

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Projects</span>
        <button className="icon-btn sm" title="Open folder…" onClick={async () => (await api.dialog.openFolder()).forEach((d) => openSession('agent', { cwd: d }))}>
          <Icon name="folder-open" size={15} />
        </button>
        <button className="icon-btn sm" title="New session" onClick={() => set({ newSession: {} })}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div style={{ padding: '0 10px 6px' }}>
        <input
          className="input"
          placeholder="Search chats, branches… (Enter: full text)"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            if (!e.target.value) setResults(null)
          }}
          onKeyDown={(e) => e.key === 'Enter' && void runSearch()}
        />
      </div>
      <div className="sidebar-body">
        {results && (
          <>
            <div className="section-label">Full-text results</div>
            {!results.length && <div className="empty-note">No matches.</div>}
            {results.map((r) => {
              const c = lib.chats.find((x) => x.agentSessionId === r.agentSessionId)
              return (
                <div key={r.agentSessionId} className="list-item" onClick={() => (c ? resumeChat(r.agentSessionId) : resumeTranscript(r.agentSessionId))}>
                  <Icon name="search" size={14} style={{ color: 'var(--muted)' }} />
                  <div className="grow">
                    <div className="ellipsis">{c?.name ?? r.agentSessionId.slice(0, 8)}</div>
                    <div className="sub ellipsis">{r.snippet}</div>
                  </div>
                </div>
              )
            })}
          </>
        )}
        {pinned.length > 0 && (
          <>
            <div className="section-label">
              <Icon name="pin" size={11} /> Pinned
            </div>
            {pinned.map((c) => (
              <ChatItem key={c.agentSessionId} chat={c} live={liveByChat.get(c.agentSessionId)} indent={false} />
            ))}
          </>
        )}
        <div className="section-label">Projects</div>
        {!projects.length && <div className="empty-note">Drop a folder onto the window to create your first project.</div>}
        {projects.map((p) => {
          const chats = visible.filter((c) => c.projectId === p.id && !c.pinned && match(c)).sort((a, b) => b.updatedAt - a.updatedAt)
          const wts = lib.worktrees.filter((w) => w.projectId === p.id && (w.permanent || w.deleted))
          const isCollapsed = collapsed[p.id]
          return (
            <div key={p.id} className="project">
              <div
                className={`project-head ${homeProjectId === p.id ? 'active' : ''}`}
                onClick={() => {
                  openProjectHome(p.id)
                  setCollapsed((c) => ({ ...c, [p.id]: false }))
                }}
                onContextMenu={(e) => projectMenu(e, p)}
                title={`${p.folders.join('\n')}\nClick for the project home`}
              >
                <button
                  className="icon-btn sm project-chevron"
                  title={isCollapsed ? 'Expand' : 'Collapse'}
                  onClick={(e) => {
                    e.stopPropagation()
                    setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))
                  }}
                >
                  <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} style={{ color: 'var(--muted)' }} />
                </button>
                <Icon name="folder" size={14} style={{ color: 'var(--accent)' }} />
                <span className="grow ellipsis">{p.name}</span>
                {p.pinned && <Icon name="pin" size={11} style={{ color: 'var(--muted)' }} />}
                <span className="actions">
                  <button
                    className="icon-btn sm"
                    title="New chat"
                    onClick={(e) => {
                      e.stopPropagation()
                      void openSession('agent', { cwd: p.folders[0] })
                    }}
                  >
                    <Icon name="plus" size={13} />
                  </button>
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      projectMenu(e, p)
                    }}
                  >
                    <Icon name="more" size={13} />
                  </button>
                </span>
              </div>
              {!isCollapsed && (
                <>
                  {chats.slice(0, 30).map((c) => (
                    <ChatItem key={c.agentSessionId} chat={c} live={liveByChat.get(c.agentSessionId)} indent />
                  ))}
                  {!chats.length && (
                    <div className="list-item chat-item muted" onClick={() => openSession('agent', { cwd: p.folders[0] })}>
                      <Icon name="plus" size={13} /> New chat
                    </div>
                  )}
                  {wts.map((w) => (
                    <div
                      key={w.id}
                      className="list-item chat-item"
                      title={w.path}
                      onClick={() => (w.deleted ? attempt(() => api.worktree.restore(w.id), 'Worktree restored') : openSession('agent', { cwd: w.path }))}
                      onContextMenu={(e) =>
                        openMenu(e, [
                          { label: w.deleted ? 'Restore snapshot' : 'New chat here', icon: w.deleted ? 'undo' : 'plus', onClick: () => (w.deleted ? attempt(() => api.worktree.restore(w.id)) : openSession('agent', { cwd: w.path })) },
                          { label: 'Create branch here…', icon: 'branch', disabled: !!w.deleted, onClick: () => askText('Branch name', 'feature').then<unknown>((n) => n && attempt(() => api.worktree.createBranch(w.id, n), 'Branch created')) },
                          { label: 'Reveal folder', icon: 'folder-open', disabled: !!w.deleted, onClick: () => api.shell.openPath(w.path) },
                          { separator: true },
                          { label: w.deleted ? 'Forget' : 'Delete (keeps a snapshot)', icon: 'trash', danger: true, onClick: () => (w.deleted ? api.worktree.forget(w.id) : attempt(() => api.worktree.delete(w.id))) }
                        ])
                      }
                    >
                      <Icon name="branch" size={13} style={{ color: 'var(--muted)' }} />
                      <span className="grow ellipsis">{w.branch ?? w.path.split(/[\\/]/).pop()}</span>
                      <span className="badge">{w.deleted ? 'snapshot' : w.permanent ? 'permanent' : 'worktree'}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )
        })}
        {quick.length > 0 && (
          <>
            <div className="section-label">
              <Icon name="zap" size={11} /> Quick chats
            </div>
            {quick.map((c) => (
              <ChatItem key={c.agentSessionId} chat={c} live={liveByChat.get(c.agentSessionId)} indent={false} />
            ))}
          </>
        )}
        <div className="section-label" style={{ cursor: 'var(--cursor)' }} onClick={() => setShowHistory((v) => !v)}>
          <Icon name={showHistory ? 'chevron-down' : 'chevron-right'} size={11} /> All agent history
        </div>
        {showHistory && !history && <div className="empty-note">Reading transcripts…</div>}
        {showHistory &&
          history
            ?.filter((t) => !ql || t.title.toLowerCase().includes(ql) || t.cwd.toLowerCase().includes(ql))
            .slice(0, 80)
            .map((t) => (
              <div key={t.agentSessionId} className="list-item" title={`${t.cwd}\n${t.messages} prompts · ${new Date(t.lastTs).toLocaleString()}`} onClick={() => openSession('agent', { cwd: t.cwd, provider: t.provider, resumeId: t.agentSessionId, name: t.title.slice(0, 40) })}>
                <Icon name="history" size={13} style={{ color: 'var(--muted)' }} />
                <div className="grow">
                  <div className="ellipsis">{t.title}</div>
                  <div className="sub ellipsis mono">{shortPath(t.cwd, home)}</div>
                </div>
                <span className="badge" title={`${providerOf(t.provider).label} session`}>
                  {providerOf(t.provider).label}
                </span>
                <span className="sub">{timeAgo(t.lastTs)}</span>
              </div>
            ))}
      </div>
    </>
  )
}

async function resumeTranscript(id: string): Promise<void> {
  const list = await api.library.transcripts()
  const t = list.find((x) => x.agentSessionId === id)
  if (t) await openSession('agent', { cwd: t.cwd, provider: t.provider, resumeId: id, name: t.title.slice(0, 40) })
}

function ChatItem({ chat: c, live, indent }: { chat: ChatRecord; live?: ReturnType<typeof get>['sessions'][string]; indent: boolean }) {
  const active = useStore((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId)
    return !!live && t?.activePane === live.id
  })
  return (
    <div
      className={`list-item ${indent ? 'chat-item' : ''} ${active ? 'active' : ''}`}
      title={`${c.name}\n${c.cwd}${c.branch ? `\nbranch: ${c.branch}` : ''}${c.lastPrompt ? `\n\n${c.lastPrompt}` : ''}`}
      onClick={() => (live ? focusSessionTab(live.id) : resumeChat(c.agentSessionId))}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: live ? 'Focus' : 'Resume', icon: 'play', onClick: () => (live ? focusSessionTab(live.id) : resumeChat(c.agentSessionId)) },
          { label: 'Open in split', icon: 'split', onClick: () => resumeChat(c.agentSessionId, 'split') },
          ...(providerOf(c.provider).caps.fork
            ? [{ label: 'Fork', icon: 'fork', onClick: () => openSession('agent', { cwd: c.cwd, provider: c.provider, resumeId: c.agentSessionId, fork: true, name: `${c.name} fork` }) }]
            : []),
          { label: c.pinned ? 'Unpin' : 'Pin', icon: 'pin', onClick: () => api.library.updateChat(c.agentSessionId, { pinned: !c.pinned }) },
          {
            label: 'Rename…',
            icon: 'edit',
            onClick: () =>
              askText('Rename chat', c.name).then((n) => {
                if (!n) return
                void api.library.updateChat(c.agentSessionId, { name: n })
                if (live) void api.session.rename(live.id, n)
              })
          },
          { label: 'Copy session id', icon: 'copy', onClick: () => api.clipboard.writeText(c.agentSessionId) },
          { separator: true },
          { label: 'Archive', icon: 'archive', onClick: () => api.library.updateChat(c.agentSessionId, { archived: true }) }
        ])
      }
    >
      {live ? <span className={`dot ${live.status}`} /> : <Icon name="message" size={13} style={{ color: 'var(--muted)', opacity: 0.7 }} />}
      <span className="grow ellipsis" style={live?.unread ? { fontWeight: 650 } : undefined}>
        {c.name}
      </span>
      {c.worktreeId && <Icon name="branch" size={11} style={{ color: 'var(--muted)' }} />}
      <span className="sub">{timeAgo(c.updatedAt)}</span>
      <span className="actions">
        <button
          className="icon-btn sm"
          title="Archive"
          onClick={(e) => {
            e.stopPropagation()
            void api.library.updateChat(c.agentSessionId, { archived: true })
          }}
        >
          <Icon name="archive" size={12} />
        </button>
      </span>
    </div>
  )
}

// ------------------------------------------------------------------ activity
function ActivityView() {
  const sessions = useStore((s) => s.sessions)
  const runs = useStore((s) => s.automations.runs)
  const jobRuns = useStore((s) => s.jobRuns)
  const chats = useStore((s) => s.library.chats)
  const [filter, setFilter] = useState<'all' | 'running' | 'waiting' | 'unread' | 'pinned' | 'scheduled'>('all')
  useNow(15_000)
  const list = Object.values(sessions)
    .filter((s) => s.kind === 'agent')
    .filter((s) => {
      if (filter === 'running') return s.status === 'working'
      if (filter === 'waiting') return s.status === 'needs-input' || s.status === 'waiting-auth' || s.goal?.status === 'blocked'
      if (filter === 'unread') return s.unread
      if (filter === 'pinned') return chats.some((c) => c.agentSessionId === s.agentSessionId && c.pinned)
      if (filter === 'scheduled') return false
      return true
    })
    .sort((a, b) => b.lastActivity - a.lastActivity)
  const runList = filter === 'scheduled' || filter === 'all' || filter === 'unread' ? runs.filter((r) => !r.archived && (filter !== 'unread' || r.unread)).slice(0, 20) : []
  const jobRunList = filter === 'scheduled' || filter === 'all' || filter === 'unread' ? jobRuns.filter((r) => filter !== 'unread' || (r.unread && r.status !== 'running')).slice(0, 20) : []
  return (
    <>
      <div className="sidebar-head">
        <span className="title">Activity</span>
        <button
          className="btn sm ghost"
          onClick={() => {
            void api.session.markAllRead()
            void api.automations.markAllRead()
            void api.jobs.markAllRead()
          }}
        >
          Mark all read
        </button>
      </div>
      <div style={{ padding: '0 10px 6px', overflowX: 'auto' }}>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All'],
            ['running', 'Running'],
            ['waiting', 'Waiting'],
            ['unread', 'Unread'],
            ['pinned', 'Pinned'],
            ['scheduled', 'Scheduled']
          ]}
        />
      </div>
      <div className="sidebar-body">
        {!list.length && !runList.length && !jobRunList.length && <div className="empty-note">Nothing here right now.</div>}
        {list.map((s) => (
          <div key={s.id} className="list-item" style={{ alignItems: 'flex-start' }} onClick={() => focusSessionTab(s.id)}>
            <span className={`dot ${s.status}`} style={{ marginTop: 5 }} />
            <div className="grow">
              <div className="row" style={{ gap: 6 }}>
                <span className="ellipsis" style={{ fontWeight: s.unread ? 650 : 500 }}>
                  {s.name}
                </span>
                <span className="sub" style={{ marginLeft: 'auto' }}>
                  {timeAgo(s.lastActivity)}
                </span>
              </div>
              <div className="sub ellipsis">{s.status === 'needs-input' && s.attention ? `⚠ ${s.attention}` : s.status === 'working' ? `Working: ${s.lastPrompt ?? ''}` : s.lastAssistant ?? STATUS_LABEL[s.status]}</div>
              {s.goal && <div className="sub ellipsis">🎯 {s.goal.status}: {s.goal.text}</div>}
            </div>
          </div>
        ))}
        {runList.length > 0 && <div className="section-label">Scheduled runs</div>}
        {runList.map((r) => (
          <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }} onClick={() => (showSidebar('scheduled'), api.automations.updateRun(r.id, { unread: false }))}>
            <Icon name={r.status === 'running' ? 'refresh' : r.status === 'error' ? 'x' : 'check'} size={13} style={{ marginTop: 3, color: r.status === 'error' ? 'var(--danger)' : 'var(--success)' }} />
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: r.unread ? 650 : 500 }}>
                {r.automationName}
              </div>
              <div className="sub ellipsis">{r.output || 'Running…'}</div>
            </div>
            <span className="sub">{timeAgo(r.startedAt)}</span>
          </div>
        ))}
        {jobRunList.length > 0 && <div className="section-label">Job runs</div>}
        {jobRunList.map((r) => {
          const ok = r.status === 'success'
          const current = r.steps.findIndex((s) => s.status === 'running')
          const passed = r.steps.filter((s) => s.status === 'passed').length
          const ran = r.steps.filter((s) => s.status !== 'skipped').length
          const unread = r.unread && r.status !== 'running'
          return (
            <div
              key={r.id}
              className="list-item"
              style={{ alignItems: 'flex-start' }}
              onClick={() => {
                if (r.source === 'routine') showSidebar('routines')
                else openJobsFor(r.root)
                if (unread) void api.jobs.updateRun(r.id, { unread: false })
              }}
            >
              <Icon name={r.status === 'running' ? 'refresh' : ok ? 'check' : 'x'} size={13} style={{ marginTop: 3, color: r.status === 'running' ? 'var(--accent)' : ok ? 'var(--success)' : 'var(--danger)' }} />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: unread ? 650 : 500 }}>
                  {r.jobName}
                </div>
                <div className="sub ellipsis">
                  {r.status === 'running' ? `Running step ${current + 1}…` : r.error ?? `${passed}/${ran} steps passed${r.branch ? ` · ${r.branch}` : ''}`}
                </div>
              </div>
              <span className="sub">{timeAgo(r.startedAt)}</span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ teams
function TeamsView() {
  const mesh = useStore((s) => s.mesh)
  const sessions = useStore((s) => s.sessions)
  const enabled = useStore((s) => s.settings.mesh.enabled)
  const groups = Object.values(mesh).filter((g) => Object.values(sessions).some((s) => s.meshGroup === g.key && s.status !== 'exited'))
  return (
    <>
      <div className="sidebar-head">
        <span className="title">Teams</span>
        <button className="icon-btn sm" title="Launch a team…" onClick={() => set({ fleetOpen: {} })}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      <div className="sidebar-body">
        {!enabled && <div className="empty-note">Collaboration is turned off in Settings → Collaboration.</div>}
        {enabled && !groups.length && (
          <div className="empty-note">
            Open two or more sessions in the same folder (or worktrees of one repo) and they form a team automatically: they see each other's work, claim files, share a task board and message each other.
            <div style={{ marginTop: 12 }}>
              <button className="btn primary sm" onClick={() => set({ fleetOpen: {} })}>
                <Icon name="users" size={13} /> Launch a team
              </button>
            </div>
          </div>
        )}
        {groups.map((g) => {
          const members = Object.values(sessions).filter((s) => s.meshGroup === g.key && s.status !== 'exited')
          const open = g.board.filter((b) => b.status !== 'done').length
          return (
            <div key={g.key} style={{ marginBottom: 10 }}>
              <div className="project-head" onClick={() => (set({ teamKey: g.key }), setRight('team'))}>
                <span className="dot" style={{ background: members[0]?.meshColor }} />
                <span className="grow ellipsis">{g.label}</span>
                <span className="badge">{members.length}</span>
              </div>
              {members.map((m) => (
                <div key={m.id} className="list-item chat-item" onClick={() => focusSessionTab(m.id)}>
                  <span className={`dot ${m.status}`} />
                  <span className="grow ellipsis">{m.name}</span>
                  {m.role !== 'free' && <span className="badge">{m.role}</span>}
                  {m.pendingMessages > 0 && <span className="badge accent">{m.pendingMessages}</span>}
                </div>
              ))}
              <div className="sub" style={{ padding: '2px 26px', color: 'var(--muted)', fontSize: 11.5 }}>
                {open} open task{open === 1 ? '' : 's'} · {g.claims.length} claim{g.claims.length === 1 ? '' : 's'} · {g.messages.length} message{g.messages.length === 1 ? '' : 's'}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}
