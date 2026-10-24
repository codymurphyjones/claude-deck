import { useState } from 'react'
import { api } from '../api'
import { runCommand } from '../commands'
import { shortcutMap, prettyCombo } from '../shortcuts'
import { closeGroup, goHome, HOME, moveGroup, openGroup, openSession, QUICK, set, signIn, useAuth, useStore } from '../store'
import { Icon } from './Icon'
import { SubTabs } from './SubTabs'
import { openMenu, openMenuAt, STATUS_LABEL } from './ui'

// Title bar: Home, then one tab per open workspace (a project, or Quick chats). A workspace's chats,
// Overview and editor are its sub-tabs (SubTabs, under the title bar). A popout window shows its
// single chat's tab here instead.

const ORDER = ['needs-input', 'waiting-auth', 'working', 'starting', 'blocked', 'idle', 'exited']

export function TitleBar() {
  const groups = useStore((s) => s.groups)
  const activeGroup = useStore((s) => s.activeGroup)
  const tabs = useStore((s) => s.tabs)
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.library.projects)
  const auth = useAuth()
  const popout = useStore((s) => s.popoutSessionId)
  const settings = useStore((s) => s.settings)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const sc = shortcutMap(settings)

  const newMenu = (el: HTMLElement): void =>
    openMenuAt(el, [
      { label: 'New session…', icon: 'plus', hint: prettyCombo(sc.newSession), onClick: () => set({ newSession: {} }) },
      { label: 'New session in worktree…', icon: 'branch', hint: prettyCombo(sc.newWorktreeSession), onClick: () => set({ newSession: { worktree: true } }) },
      { label: 'Quick chat', icon: 'zap', hint: prettyCombo(sc.quickChat), onClick: () => runCommand('quickChat') },
      { label: 'Open folder…', icon: 'folder-open', onClick: () => runCommand('openFolder') },
      { separator: true },
      { label: 'Launch a team…', icon: 'users', onClick: () => runCommand('fleet') },
      ...settings.sessionTemplates.map((t) => ({ label: `Template: ${t.name}`, icon: 'layers', onClick: () => set({ newSession: { templateId: t.id } }) })),
      { separator: true },
      { label: 'Run a cloud task…', icon: 'cloud', onClick: () => runCommand('cloud') }
    ])

  if (popout)
    return (
      <div className="titlebar">
        <SubTabs inTitleBar />
        <div className="drag" />
      </div>
    )

  return (
    <div className="titlebar">
      <button className={`icon-btn home-btn ${activeGroup === HOME ? 'on' : ''}`} title="Home: all projects" onClick={goHome}>
        <Icon name="home" size={16} />
      </button>
      <div className="tabs" onDragOver={(e) => e.preventDefault()}>
        {groups.map((g, i) => {
          const p = projects.find((x) => x.id === g)
          const mine = tabs.filter((t) => t.group === g)
          const chats = mine.flatMap((t) => t.sessionIds.map((id) => sessions[id]).filter(Boolean)).filter((s) => s.kind !== 'shell')
          const status = chats.map((s) => s.status).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0]
          const unread = chats.some((s) => s.unread)
          const pending = chats.reduce((n, s) => n + (s.pendingMessages || 0), 0)
          const name = g === QUICK ? 'Quick chats' : (p?.name ?? 'Project')
          const close = (): void => void closeGroup(g)
          return (
            <div
              key={g}
              className={`tab group-tab ${g === activeGroup ? 'active' : ''} ${unread ? 'unread' : ''} ${dropBefore === g ? 'drop-before' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-deck-group', g)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-deck-group')) {
                  e.preventDefault()
                  setDropBefore(g)
                }
              }}
              onDragLeave={() => setDropBefore(null)}
              onDrop={(e) => {
                const from = e.dataTransfer.getData('application/x-deck-group')
                setDropBefore(null)
                if (from && from !== g) moveGroup(from, i)
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  close()
                } else if (e.button === 0) openGroup(g)
              }}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: p ? `New chat in ${p.name}` : 'New session…', icon: 'plus', onClick: () => (p ? void openSession('agent', { cwd: p.folders[0] }) : set({ newSession: {} })) },
                  ...(p ? [{ label: 'Reveal folder', icon: 'folder-open', onClick: () => api.shell.openPath(p.folders[0]) }] : []),
                  { separator: true },
                  { label: chats.length ? `Close ${name} (${chats.length} chat${chats.length === 1 ? '' : 's'})` : `Close ${name}`, icon: 'x', danger: true, onClick: close }
                ])
              }
              title={`${name}${p ? `\n${p.folders.join('\n')}` : ''}\n${chats.length} chat${chats.length === 1 ? '' : 's'}${status ? ` · ${STATUS_LABEL[status] ?? status}` : ''}`}
            >
              {status ? <span className={`dot ${status}`} /> : <Icon name={g === QUICK ? 'zap' : 'folder'} size={13} style={{ color: 'var(--accent)' }} />}
              <span className="title">{name}</span>
              {chats.length > 1 && <span className="group-count">{chats.length}</span>}
              {pending > 0 && <span className="count" title="Unread peer messages">{pending}</span>}
              <button
                className="icon-btn sm close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  close()
                }}
                title="Close"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          )
        })}
      </div>
      <button className="icon-btn" title={`New session (${prettyCombo(sc.newSession)})`} onClick={() => set({ newSession: {} })} onContextMenu={(e) => newMenu(e.currentTarget)}>
        <Icon name="plus" />
      </button>
      <div className="drag" onDoubleClick={() => set({ newSession: {} })} />
      <button className="brand icon-btn" style={{ width: 'auto', padding: '0 8px' }} onClick={(e) => newMenu(e.currentTarget)} title="Claude Deck: new session, quick chat, open folder…">
        <span className="brand-mark">
          <Icon name="sparkles" size={12} stroke={2.4} />
        </span>
        <span>Deck</span>
      </button>
      <button className="icon-btn" title={`Command palette (${prettyCombo(sc.palette)})`} onClick={() => set({ palette: 'all' })}>
        <Icon name="search" />
      </button>
      {auth.checked && !auth.loggedIn ? (
        <button className="btn sm primary" onClick={() => signIn()}>
          <Icon name="login" size={14} /> Sign in
        </button>
      ) : (
        <button
          className="icon-btn"
          title={auth.email ? `Signed in as ${auth.email} (${auth.subscriptionType ?? auth.authMethod})` : 'Account'}
          onClick={(e) =>
            openMenuAt(e.currentTarget, [
              { label: auth.email ?? 'Signed in', icon: 'user', disabled: true },
              { label: `Plan: ${auth.subscriptionType ?? auth.authMethod ?? 'unknown'}`, disabled: true },
              { separator: true },
              { label: 'Settings', icon: 'settings', onClick: () => set({ settingsOpen: 'general' }) },
              { label: 'Usage insights', icon: 'activity', onClick: () => set({ settingsOpen: 'profile' }) },
              { label: 'Sign out', icon: 'logout', danger: true, onClick: () => runCommand('signOut') }
            ])
          }
        >
          <Icon name="user" />
        </button>
      )}
    </div>
  )
}
