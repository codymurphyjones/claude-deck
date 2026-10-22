import { useEffect, useRef, useState } from 'react'
import type { EnvironmentConfig } from '@shared/types'
import { api, type LiveSession } from '../api'
import { restoreSaved } from '../boot'
import { runCommand } from '../commands'
import {
  askText,
  attempt,
  closeSession,
  focusTab,
  openSession,
  resumeChat,
  set,
  setRight,
  shellFor,
  signIn,
  toggleShell,
  useStore,
  type Tab
} from '../store'
import { attach, clearSearch, clearTerminal, detach, focusTerminal, hydrate, refit, rehydrate, searchTerminal } from '../terminal/registry'
import { Icon } from './Icon'
import { ChatView } from '../chat/ChatView'
import { UpdateBanner } from './Updates'
import { openMenuAt, shortPath, STATUS_LABEL, timeAgo } from './ui'

export function MainArea() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const auth = useStore((s) => s.auth)
  const saved = useStore((s) => s.savedTabs)
  const restoreMode = useStore((s) => s.settings.restoreSessions)
  const popout = useStore((s) => s.popoutSessionId)
  return (
    <div className="main">
      {auth.checked && !auth.loggedIn && !popout && (
        <div className="banner warn">
          <Icon name="lock" />
          <div className="grow">
            <b>You're not signed in to Claude.</b> <span className="muted">Sessions you open will start as soon as you sign in.</span>
          </div>
          <button className="btn primary sm" onClick={() => signIn()}>
            Sign in with Claude
          </button>
          <button className="btn sm" onClick={() => signIn({ console: true })}>
            Anthropic Console
          </button>
          <button className="btn sm ghost" onClick={() => signIn({ sso: true })}>
            SSO
          </button>
        </div>
      )}
      {!popout && <UpdateBanner />}
      {saved.length > 0 && restoreMode === 'ask' && !popout && !tabs.length && (
        <div className="banner">
          <Icon name="history" />
          <div className="grow">
            Restore {saved.reduce((n, t) => n + t.sessions.length, 0)} session(s) from last time? <span className="muted">Conversations resume where they left off.</span>
          </div>
          <button className="btn primary sm" onClick={() => void restoreSaved()}>
            Restore
          </button>
          <button className="btn sm ghost" onClick={() => set({ savedTabs: [] })}>
            Dismiss
          </button>
        </div>
      )}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {tabs.map((t) => (
          <TabPage key={t.id} tab={t} active={t.id === activeTabId} />
        ))}
        {!tabs.length && <EmptyState />}
      </div>
    </div>
  )
}

function TabPage({ tab, active }: { tab: Tab; active: boolean }) {
  const n = tab.sessionIds.length
  const cols = n === 1 ? '1fr' : n === 2 ? '1fr 1fr' : n === 3 ? '1fr 1fr 1fr' : '1fr 1fr'
  const rows = n === 4 ? '1fr 1fr' : '1fr'
  return (
    <div className={`tab-page ${active ? '' : 'hidden'}`}>
      <div className="panes" style={{ gridTemplateColumns: cols, gridTemplateRows: rows }}>
        {tab.sessionIds.map((id) => (
          <TerminalPane key={id} id={id} tabId={tab.id} focused={tab.activePane === id} tabActive={active} multi={n > 1} />
        ))}
      </div>
    </div>
  )
}

function fmtTokens(n?: number): string | undefined {
  if (!n) return undefined
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

const MODE_LABEL: Record<string, string> = {
  plan: 'Plan',
  acceptEdits: 'Accept edits',
  bypassPermissions: 'Bypass',
  auto: 'Auto',
  manual: 'Ask',
  dontAsk: "Don't ask",
  default: 'Default'
}

function TerminalPane({ id, tabId, focused, tabActive, multi }: { id: string; tabId: string; focused: boolean; tabActive: boolean; multi: boolean }) {
  const s = useStore((st) => st.sessions[id]) as LiveSession | undefined
  const windowId = useStore((st) => st.windowId)
  const shellOpen = useStore((st) => !!st.shellOpen[id])
  const home = useStore((st) => st.homedir)
  const peers = useStore((st) => (s?.meshGroup ? Object.values(st.sessions).filter((x) => x.meshGroup === s.meshGroup && x.id !== id && x.status !== 'exited' && x.kind === 'claude').length : 0))
  const hostRef = useRef<HTMLDivElement>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [q, setQ] = useState('')
  const hostedHere = !!s && s.hostWindow === windowId
  const prevHost = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!hostedHere || !hostRef.current) return
    const el = hostRef.current
    const wasElsewhere = prevHost.current !== undefined && prevHost.current !== windowId
    if (wasElsewhere) void rehydrate(id)
    else void hydrate(id)
    attach(id, el)
    return () => detach(id, el)
  }, [id, hostedHere, windowId])

  useEffect(() => {
    prevHost.current = s?.hostWindow
  }, [s?.hostWindow])

  useEffect(() => {
    if (tabActive && hostedHere) {
      refit(id)
      if (focused) requestAnimationFrame(() => focusTerminal(id))
    }
  }, [tabActive, focused, hostedHere, id])

  useEffect(() => {
    const onFind = (): void => {
      if (tabActive && focused) setSearchOpen(true)
    }
    window.addEventListener('deck:find', onFind)
    return () => window.removeEventListener('deck:find', onFind)
  }, [tabActive, focused])

  if (!s) return <div className="pane" />

  const isClaude = s.kind === 'claude'
  const restart = (): void => {
    clearTerminal(id)
    void api.session.restart(id)
  }

  const moreMenu = (el: HTMLElement): void =>
    openMenuAt(el, [
      { label: 'Rename…', icon: 'edit', onClick: () => askText('Rename session', s.name).then<unknown>((n) => n && api.session.rename(id, n)) },
      ...(isClaude
        ? [
            { label: 'Fork chat', icon: 'fork', onClick: () => runCommand('forkChat') },
            { label: 'Fork into worktree', icon: 'branch', onClick: () => runCommand('forkWorktree') },
            { label: 'Side chat', icon: 'message', onClick: () => runCommand('sideChat') },
            { label: s.worktreeId ? 'Hand off to local checkout' : 'Hand off to a worktree', icon: 'arrow', onClick: () => runCommand('handoff') },
            { separator: true },
            { label: 'Set goal…', icon: 'target', onClick: () => set({ goalFor: id }) },
            { label: 'Schedule follow-up…', icon: 'clock', onClick: () => runCommand('scheduleInChat') },
            { label: 'Cycle permission mode', icon: 'shield', hint: 'Shift+Tab', onClick: () => api.session.cycleMode(id) },
            { label: 'Role…', icon: 'users', onClick: (() => roleMenu(el)) as () => void },
            { label: 'Continue on phone (Remote Control)', icon: 'phone', onClick: () => runCommand('remoteControl') },
            { separator: true }
          ]
        : []),
      { label: 'Find in terminal', icon: 'search', onClick: () => setSearchOpen(true) },
      { label: 'Copy working directory', icon: 'copy', onClick: () => api.clipboard.writeText(s.cwd) },
      { label: 'Reveal folder', icon: 'folder-open', onClick: () => api.shell.openPath(s.cwd) },
      { label: 'Open in editor', icon: 'code', onClick: () => api.shell.openInEditor(s.cwd) },
      { label: 'Pop out', icon: 'popout', onClick: () => api.window.popOut(id) },
      { label: 'Restart', icon: 'refresh', onClick: restart },
      { separator: true },
      { label: 'Close', icon: 'x', danger: true, onClick: () => closeSession(id) }
    ])

  const roleMenu = (el: HTMLElement): void =>
    openMenuAt(el, [
      { label: 'No role (awareness only)', icon: s.role === 'free' ? 'check' : undefined, onClick: () => api.session.setRole(id, 'free') },
      { label: 'Lead — splits work onto the board', icon: s.role === 'lead' ? 'check' : 'flag', onClick: () => api.session.setRole(id, 'lead') },
      { label: 'Worker — takes board tasks', icon: s.role === 'worker' ? 'check' : 'hand', onClick: () => api.session.setRole(id, 'worker') },
      { label: 'Driver — implements, gets reviewed', icon: s.role === 'driver' ? 'check' : 'code', onClick: () => api.session.setRole(id, 'driver') },
      { label: 'Reviewer — reviews peers’ changes', icon: s.role === 'reviewer' ? 'check' : 'eye', onClick: () => api.session.setRole(id, 'reviewer') }
    ])

  return (
    <div
      className={`pane ${focused && multi ? 'focused' : ''}`}
      onMouseDown={() => {
        if (!focused) focusTab(tabId, id)
      }}
    >
      <div className="pane-head" onDoubleClick={() => runCommand('renameSession')}>
        <span className={`dot ${s.status}`} title={STATUS_LABEL[s.status]} />
        <span className="name ellipsis">{s.name}</span>
        <span className="path ellipsis mono" title={s.cwd}>
          {shortPath(s.cwd, home)}
        </span>
        {s.branch && (
          <span className="badge opt" title="Git branch">
            <Icon name="branch" size={11} /> {s.branch}
          </span>
        )}
        {s.worktreeId && (
          <span className="badge accent" title="Running in a managed worktree">
            worktree
          </span>
        )}
        {isClaude && s.permissionMode && s.permissionMode !== 'default' && (
          <span className="badge" title="Permission mode — click to cycle (Shift+Tab in the terminal)" style={{ cursor: 'var(--cursor)' }} onClick={() => api.session.cycleMode(id)}>
            <Icon name="shield" size={11} /> {MODE_LABEL[s.permissionMode] ?? s.permissionMode}
          </span>
        )}
        {s.role !== 'free' && (
          <span className="badge accent" style={{ cursor: 'var(--cursor)' }} onClick={(e) => roleMenu(e.currentTarget)}>
            {s.role}
          </span>
        )}
        {peers > 0 && (
          <span className="badge" style={{ borderColor: s.meshColor, color: s.meshColor, cursor: 'var(--cursor)' }} title="Other Claude sessions in this folder/repo — they coordinate through the mesh" onClick={() => setRight('team')}>
            <Icon name="users" size={11} /> {peers} peer{peers > 1 ? 's' : ''}
          </span>
        )}
        {fmtTokens(s.contextTokens) && (
          <span className="badge opt" title="Context window in use">
            {fmtTokens(s.contextTokens)} ctx
          </span>
        )}
        {s.launch.remoteControl ? (
          <span className="badge ok" title="Remote Control enabled">
            <Icon name="phone" size={11} /> remote
          </span>
        ) : null}
        <div className="tools">
          {isClaude && (
            <>
              <EnvActions session={s} />
              <button className={`icon-btn sm ${shellOpen ? 'on' : ''}`} title="Integrated terminal (Ctrl+`)" onClick={() => toggleShell(id)}>
                <Icon name="terminal" size={14} />
              </button>
              <button className="icon-btn sm" title="Review changes (Ctrl+Shift+G)" onClick={() => (focusTab(tabId, id), setRight('review'))}>
                <Icon name="branch" size={14} />
              </button>
              <button className="icon-btn sm" title="Files Claude touched (Ctrl+Shift+E)" onClick={() => (focusTab(tabId, id), setRight('files'))}>
                <Icon name="file" size={14} />
              </button>
            </>
          )}
          <button className="icon-btn sm" title="More" onClick={(e) => moreMenu(e.currentTarget)}>
            <Icon name="more" size={14} />
          </button>
          {multi && (
            <button className="icon-btn sm" title="Close pane" onClick={() => closeSession(id)}>
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
      </div>
      {!isClaude && s.status === 'needs-input' && s.attention && (
        <div className="attention">
          <Icon name="hand" size={14} style={{ color: 'var(--warning)' }} />
          <span className="grow ellipsis">{s.attention}</span>
          <button className="btn sm" onClick={() => focusTerminal(id)}>
            Respond
          </button>
        </div>
      )}
      {s.goal && <GoalRow session={s} />}
      {s.pendingMessages > 0 && s.status !== 'working' && (
        <div className="goal-row">
          <Icon name="message" size={14} />
          <span className="text">
            {s.pendingMessages} unread message{s.pendingMessages > 1 ? 's' : ''} from peer sessions
          </span>
          <button className="btn sm" onClick={() => api.session.deliverMessages(id)}>
            Deliver now
          </button>
          <button className="btn sm ghost" onClick={() => setRight('team')}>
            View
          </button>
        </div>
      )}
      {!isClaude && !!s.queuedCount && (
        <div className="goal-row" style={{ background: 'var(--panel2)' }}>
          <Icon name="list" size={14} />
          <span className="text">{s.queuedCount} follow-up(s) queued — they send when this turn finishes.</span>
        </div>
      )}
      {isClaude && hostedHere && <ChatView session={s} />}
      {isClaude && !hostedHere && (
        <div className="term-wrap">
          <div className="overlay-center">
            <div className="card col" style={{ alignItems: 'center', textAlign: 'center' }}>
              <Icon name="popout" size={22} />
              <div>
                <b>{s.name}</b> is open in its own window.
              </div>
              <div className="row">
                <button className="btn" onClick={() => api.focusSession(id)}>
                  Show window
                </button>
                <button className="btn" onClick={() => api.window.popIn(id)}>
                  Bring back
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {!isClaude && (
      <div className="term-wrap">
        <div className="term-host" ref={hostRef} />
        {searchOpen && (
          <div className="search-bar">
            <input
              className="input"
              autoFocus
              placeholder="Find…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                searchTerminal(id, e.target.value)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') searchTerminal(id, q, e.shiftKey ? 'prev' : 'next')
                if (e.key === 'Escape') {
                  setSearchOpen(false)
                  clearSearch(id)
                  focusTerminal(id)
                }
              }}
            />
            <button className="icon-btn sm" onClick={() => searchTerminal(id, q, 'prev')}>
              <Icon name="chevron-left" size={14} />
            </button>
            <button className="icon-btn sm" onClick={() => searchTerminal(id, q, 'next')}>
              <Icon name="chevron-right" size={14} />
            </button>
            <button
              className="icon-btn sm"
              onClick={() => {
                setSearchOpen(false)
                clearSearch(id)
              }}
            >
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
        {!hostedHere && (
          <div className="overlay-center">
            <div className="card col" style={{ alignItems: 'center', textAlign: 'center' }}>
              <Icon name="popout" size={22} />
              <div>
                <b>{s.name}</b> is open in its own window.
              </div>
              <div className="row">
                <button className="btn" onClick={() => api.focusSession(id)}>
                  Show window
                </button>
                <button className="btn" onClick={() => api.window.popIn(id)}>
                  Bring back
                </button>
              </div>
            </div>
          </div>
        )}
        {s.status === 'waiting-auth' && (
          <div className="overlay-center">
            <div className="card col" style={{ alignItems: 'center', textAlign: 'center', maxWidth: 380 }}>
              <Icon name="lock" size={22} />
              <b>Waiting for sign-in</b>
              <div className="muted">This session will start automatically once you're signed in to Claude.</div>
              <button className="btn primary" onClick={() => signIn()}>
                Sign in
              </button>
            </div>
          </div>
        )}
        {s.status === 'exited' && hostedHere && (
          <div className="overlay-center" style={{ background: 'transparent', backdropFilter: 'none', placeItems: 'end center', paddingBottom: 18, pointerEvents: 'none' }}>
            <div className="card row" style={{ pointerEvents: 'auto', padding: '10px 12px' }}>
              <span className="muted">
                {s.kind === 'login' ? 'Sign-in finished.' : `Session ended${s.exitCode !== undefined ? ` (code ${s.exitCode})` : ''}.`}
              </span>
              {s.kind !== 'login' && (
                <button className="btn sm primary" onClick={restart} autoFocus>
                  <Icon name="refresh" size={13} /> {isClaude ? 'Resume' : 'Restart'}
                </button>
              )}
              <button className="btn sm" onClick={() => closeSession(id, false)}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
      )}
      {shellOpen && <ShellDrawer parentId={id} />}
    </div>
  )
}

function GoalRow({ session: s }: { session: LiveSession }) {
  const g = s.goal!
  const color = g.status === 'done' ? 'var(--success)' : g.status === 'blocked' ? 'var(--danger)' : 'var(--accent)'
  return (
    <div className="goal-row">
      <Icon name="target" size={14} style={{ color }} />
      <span className="text ellipsis" title={g.text}>
        <b>Goal{g.status !== 'active' ? ` (${g.status})` : ''}:</b> {g.text}
      </span>
      <span className="muted" style={{ fontSize: 11.5 }}>
        {g.iterations}/{g.maxIterations} turns · {timeAgo(g.startedAt)}
      </span>
      {g.status === 'active' ? (
        <button className="icon-btn sm" title="Pause goal" onClick={() => api.session.updateGoal(s.id, 'pause')}>
          <Icon name="pause" size={13} />
        </button>
      ) : g.status !== 'done' ? (
        <button className="icon-btn sm" title="Resume goal" onClick={() => api.session.updateGoal(s.id, 'resume')}>
          <Icon name="play" size={13} />
        </button>
      ) : null}
      <button
        className="icon-btn sm"
        title="Edit goal"
        onClick={() => askText('Edit goal', g.text, { multiline: true }).then<unknown>((t) => t && api.session.updateGoal(s.id, 'edit', t))}
      >
        <Icon name="edit" size={13} />
      </button>
      <button className="icon-btn sm" title="Clear goal" onClick={() => api.session.updateGoal(s.id, 'clear')}>
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

function EnvActions({ session }: { session: LiveSession }) {
  const [env, setEnv] = useState<EnvironmentConfig | null>(null)
  useEffect(() => {
    void api.env.load(session.root).then(setEnv)
  }, [session.root])
  const run = async (command: string): Promise<void> => {
    set((st) => ({ shellOpen: { ...st.shellOpen, [session.id]: true } }))
    await attempt(() => api.env.runAction(session.id, command))
  }
  const edit = (): void => set({ settingsOpen: `env:${session.root}` })
  if (!env?.actions.length)
    return (
      <button className="icon-btn sm" title="Add environment actions (dev server, tests…)" onClick={edit}>
        <Icon name="play" size={14} />
      </button>
    )
  return (
    <>
      {env.actions.slice(0, 3).map((a) => (
        <button key={a.id} className="icon-btn sm" title={`${a.name}: ${a.command}`} onClick={() => run(a.windows || a.command)}>
          <Icon name={a.icon || 'play'} size={14} />
        </button>
      ))}
      {env.actions.length > 3 && (
        <button
          className="icon-btn sm"
          title="More actions"
          onClick={(e) =>
            openMenuAt(e.currentTarget, [
              ...env.actions.slice(3).map((a) => ({ label: a.name, icon: a.icon || 'play', onClick: () => run(a.windows || a.command) })),
              { separator: true },
              { label: 'Edit actions…', icon: 'edit', onClick: edit }
            ])
          }
        >
          <Icon name="chevron-down" size={14} />
        </button>
      )}
    </>
  )
}

function ShellDrawer({ parentId }: { parentId: string }) {
  const shell = useStore(() => shellFor(parentId))
  const sessions = useStore((s) => s.sessions)
  const [h, setH] = useState(240)
  const hostRef = useRef<HTMLDivElement>(null)
  const sh = shell && sessions[shell.id]
  useEffect(() => {
    if (!sh || !hostRef.current) return
    const el = hostRef.current
    void hydrate(sh.id)
    attach(sh.id, el)
    requestAnimationFrame(() => focusTerminal(sh.id))
    return () => detach(sh.id, el)
  }, [sh?.id])
  useEffect(() => {
    if (sh) refit(sh.id)
  }, [h, sh])
  const startDrag = (e: React.MouseEvent): void => {
    const y0 = e.clientY
    const h0 = h
    const move = (ev: MouseEvent): void => setH(Math.max(100, Math.min(window.innerHeight - 200, h0 - (ev.clientY - y0))))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return (
    <div className="shell-drawer" style={{ height: h }}>
      <div className="hresizer" onMouseDown={startDrag} />
      <div className="drawer-head">
        <Icon name="terminal" size={13} />
        <span className="grow ellipsis">Terminal{sh ? ` — ${sh.cwd}` : ''}</span>
        {sh?.status === 'exited' && (
          <button className="btn sm" onClick={() => api.session.restart(sh.id)}>
            Restart
          </button>
        )}
        <button className="icon-btn sm" title="Clear" onClick={() => sh && api.session.sendPrompt(sh.id, 'cls', 'steer')}>
          <Icon name="trash" size={13} />
        </button>
        <button className="icon-btn sm" title="Hide (Ctrl+`)" onClick={() => toggleShell(parentId)}>
          <Icon name="chevron-down" size={13} />
        </button>
        <button
          className="icon-btn sm"
          title="Kill terminal"
          onClick={() => {
            if (sh) void api.session.close(sh.id)
            set((st) => ({ shellOpen: { ...st.shellOpen, [parentId]: false } }))
          }}
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <div className="term-host" ref={hostRef} style={{ inset: '4px 4px 2px 10px' }} />
        {!sh && <div className="empty-note">Starting shell…</div>}
      </div>
    </div>
  )
}

function EmptyState() {
  const lib = useStore((s) => s.library)
  const home = useStore((s) => s.homedir)
  const recent = lib.recentFolders.slice(0, 8)
  const chats = lib.chats.filter((c) => !c.archived && !c.hidden && !c.quick).slice(0, 6)
  const open = async (): Promise<void> => {
    const dirs = await api.dialog.openFolder()
    for (const d of dirs) await openSession('claude', { cwd: d })
  }
  return (
    <div className="empty">
      <div className="drop-target" onClick={open} style={{ cursor: 'var(--cursor)' }}>
        <span className="brand-mark" style={{ width: 44, height: 44, borderRadius: 12 }}>
          <Icon name="sparkles" size={24} stroke={2} />
        </span>
        <h2>Drop a folder anywhere to start Claude</h2>
        <div className="muted" style={{ maxWidth: 420, lineHeight: 1.5 }}>
          Drag a folder — or any file inside it — onto this window. Each session opens in its own tab, and sessions sharing a folder automatically coordinate.
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <button
            className="btn primary"
            onClick={(e) => {
              e.stopPropagation()
              set({ newSession: {} })
            }}
          >
            <Icon name="plus" size={14} /> New session
          </button>
          <button
            className="btn"
            onClick={(e) => {
              e.stopPropagation()
              void open()
            }}
          >
            <Icon name="folder-open" size={14} /> Open folder…
          </button>
          <button
            className="btn"
            onClick={(e) => {
              e.stopPropagation()
              runCommand('quickChat')
            }}
          >
            <Icon name="zap" size={14} /> Quick chat
          </button>
        </div>
      </div>
      {recent.length > 0 && (
        <>
          <div className="section-label" style={{ width: 'min(560px,100%)' }}>
            Recent folders
          </div>
          <div className="recent-grid">
            {recent.map((f) => (
              <div key={f} className="recent-card" onClick={() => openSession('claude', { cwd: f })} title={f}>
                <Icon name="folder" size={15} style={{ color: 'var(--accent)' }} />
                <div className="grow">
                  <div className="ellipsis">{f.split(/[\\/]/).pop()}</div>
                  <div className="ellipsis muted mono" style={{ fontSize: 11 }}>
                    {shortPath(f, home)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {chats.length > 0 && (
        <>
          <div className="section-label" style={{ width: 'min(560px,100%)' }}>
            Continue a chat
          </div>
          <div className="recent-grid">
            {chats.map((c) => (
              <div key={c.claudeSessionId} className="recent-card" onClick={() => resumeChat(c.claudeSessionId)} title={c.lastPrompt}>
                <Icon name="message" size={15} style={{ color: 'var(--muted)' }} />
                <div className="grow">
                  <div className="ellipsis">{c.name}</div>
                  <div className="ellipsis muted" style={{ fontSize: 11 }}>
                    {timeAgo(c.updatedAt)} · {c.cwd.split(/[\\/]/).pop()}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      <div className="muted row" style={{ fontSize: 12, gap: 14 }}>
        <span>
          <span className="kbd">Ctrl K</span> commands
        </span>
        <span>
          <span className="kbd">Ctrl T</span> new session
        </span>
        <span>
          <span className="kbd">Ctrl `</span> terminal
        </span>
      </div>
    </div>
  )
}
