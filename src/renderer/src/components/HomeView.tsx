import { useEffect, useMemo, useState } from 'react'
import type { GitInfo, Project } from '@shared/types'
import { api } from '../api'
import { runCommand } from '../commands'
import { openGroup, openProjectHome, openSession, QUICK, set, useStore } from '../store'
import { cacheGet, cacheSet } from '../viewCache'
import { Icon } from './Icon'
import { shortPath, STATUS_LABEL, timeAgo, useNow } from './ui'

// Home (the 🏠 in the title bar): every project at a glance. Opening one gives it a title-bar tab,
// where its Overview, chats and editor live as sub-tabs.

const ORDER = ['needs-input', 'waiting-auth', 'working', 'starting', 'blocked', 'idle', 'exited']

export function HomeView() {
  const projects = useStore((s) => s.library.projects)
  const recentFolders = useStore((s) => s.library.recentFolders)
  const sessions = useStore((s) => s.sessions)
  const groups = useStore((s) => s.groups)
  const home = useStore((s) => s.homedir)
  const [q, setQ] = useState('')
  useNow(60_000)

  const live = Object.values(sessions).filter((s) => s.kind === 'agent' && s.status !== 'exited')
  const sorted = useMemo(
    () =>
      [...projects]
        .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()) || p.folders.some((f) => f.toLowerCase().includes(q.trim().toLowerCase())))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpened - a.lastOpened),
    [projects, q]
  )
  const known = new Set(projects.flatMap((p) => p.folders.map((f) => f.toLowerCase())))
  const loose = recentFolders.filter((f) => !known.has(f.toLowerCase())).slice(0, 6)
  const quick = live.filter((s) => !projects.some((p) => p.id === s.projectId))

  const openFolder = async (): Promise<void> => {
    for (const d of await api.dialog.openFolder()) await openSession('agent', { cwd: d })
  }

  return (
    <div className="home-view">
      <div className="home-head">
        <h1 className="grow">Projects</h1>
        <input className="input" style={{ width: 220 }} value={q} placeholder="Filter projects" onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => void openFolder()}>
          <Icon name="folder-open" size={13} /> Open folder…
        </button>
        <button className="btn" onClick={() => runCommand('quickChat')}>
          <Icon name="zap" size={13} /> Quick chat
        </button>
        <button className="btn primary" onClick={() => set({ newSession: {} })}>
          <Icon name="plus" size={13} /> New session
        </button>
      </div>

      {!projects.length && (
        <div className="empty-note" style={{ padding: 40 }}>
          Drop a folder onto this window, or use Open folder…, to add your first project.
        </div>
      )}

      <div className="home-grid">
        {sorted.map((p) => (
          <ProjectCard key={p.id} project={p} open={groups.includes(p.id)} chats={live.filter((s) => s.projectId === p.id)} home={home} />
        ))}
        {quick.length > 0 && (
          <div className="home-card" onClick={() => openGroup(QUICK)} title="Chats that aren't in a project">
            <div className="home-card-head">
              <Icon name="zap" size={16} style={{ color: 'var(--accent)' }} />
              <b className="grow ellipsis">Quick chats</b>
              {groups.includes(QUICK) && <span className="badge accent">open</span>}
            </div>
            <ChatDots chats={quick} />
          </div>
        )}
      </div>

      {loose.length > 0 && (
        <>
          <div className="section-label">Recent folders</div>
          <div className="home-grid compact">
            {loose.map((f) => (
              <div key={f} className="home-card" onClick={() => openSession('agent', { cwd: f })} title={`Start a chat in ${f}`}>
                <div className="home-card-head">
                  <Icon name="folder" size={14} style={{ color: 'var(--muted)' }} />
                  <span className="grow ellipsis">{f.split(/[\\/]/).pop()}</span>
                </div>
                <div className="sub ellipsis mono">{shortPath(f, home)}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function ChatDots({ chats }: { chats: { id: string; name: string; status: string }[] }) {
  if (!chats.length) return <div className="sub">No chats open</div>
  const top = [...chats].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status))
  const waiting = chats.filter((c) => c.status === 'needs-input' || c.status === 'waiting-auth').length
  return (
    <div className="home-chats">
      {top.slice(0, 4).map((c) => (
        <div key={c.id} className="row" style={{ gap: 6, minWidth: 0 }} title={STATUS_LABEL[c.status] ?? c.status}>
          <span className={`dot ${c.status}`} />
          <span className="ellipsis">{c.name}</span>
        </div>
      ))}
      {chats.length > 4 && <div className="sub">+{chats.length - 4} more</div>}
      {waiting > 0 && <span className="badge warn">{waiting} waiting for you</span>}
    </div>
  )
}

function ProjectCard({ project: p, open, chats, home }: { project: Project; open: boolean; chats: { id: string; name: string; status: string }[]; home: string }) {
  const root = p.folders[0]
  const key = `homecard:${root}`
  const [gi, setGi] = useState<GitInfo | undefined>(() => cacheGet<GitInfo>(key))
  // Branch and uncommitted changes; the last known values show while this refreshes.
  useEffect(() => {
    let live = true
    void api.git.info(root).then(
      (r) => {
        cacheSet(key, r)
        if (live) setGi(r)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [root])
  return (
    <div className={`home-card ${open ? 'open' : ''}`} onClick={() => openProjectHome(p.id)} title={p.folders.join('\n')}>
      <div className="home-card-head">
        <Icon name="folder" size={16} style={{ color: 'var(--accent)' }} />
        <b className="grow ellipsis">{p.name}</b>
        {p.pinned && <Icon name="pin" size={12} style={{ color: 'var(--muted)' }} />}
        {open && <span className="badge accent">open</span>}
      </div>
      <div className="sub ellipsis mono">{shortPath(root, home)}</div>
      <div className="home-card-git">
        {gi?.isRepo && gi.branch && (
          <span className="badge">
            <Icon name="branch" size={11} /> {gi.branch}
            {gi.ahead ? ` ↑${gi.ahead}` : ''}
            {gi.behind ? ` ↓${gi.behind}` : ''}
          </span>
        )}
        {gi?.isRepo && (gi.dirty ? <span className="badge warn">{gi.dirty} changed</span> : <span className="badge ok">clean</span>)}
        {p.lastOpened ? <span className="sub">opened {timeAgo(p.lastOpened)}</span> : null}
      </div>
      <ChatDots chats={chats} />
    </div>
  )
}
