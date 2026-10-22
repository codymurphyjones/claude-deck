import { useState } from 'react'
import { api } from '../api'
import { runCommand } from '../commands'
import { shortcutMap, prettyCombo } from '../shortcuts'
import { closeSession, focusTab, get, mergeTabInto, moveTab, openSession, set, signIn, useStore, type Tab } from '../store'
import { Icon } from './Icon'
import { openMenu, openMenuAt, STATUS_LABEL } from './ui'

function tabStatus(t: Tab, sessions: ReturnType<typeof useStore.getState>['sessions']) {
  const list = t.sessionIds.map((id) => sessions[id]).filter(Boolean)
  const order = ['needs-input', 'waiting-auth', 'working', 'starting', 'blocked', 'idle', 'exited']
  const status = list.map((s) => s.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'exited'
  return { list, status, unread: list.some((s) => s.unread), pending: list.reduce((n, s) => n + (s.pendingMessages || 0), 0) }
}

export function TitleBar() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const auth = useStore((s) => s.auth)
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

  const tabMenu = (e: React.MouseEvent, t: Tab): void => {
    const s = sessions[t.activePane]
    openMenu(e, [
      { label: 'Rename…', icon: 'edit', onClick: () => (focusTab(t.id), runCommand('renameSession')) },
      { label: 'Split with new session', icon: 'split', onClick: () => s && openSession('claude', { cwd: s.cwd }, { mode: 'split', splitOf: s.id }) },
      { label: 'Pop out', icon: 'popout', onClick: () => api.window.popOut(t.activePane) },
      { label: 'Fork chat', icon: 'fork', disabled: s?.kind !== 'claude', onClick: () => (focusTab(t.id), runCommand('forkChat')) },
      { label: 'Restart', icon: 'refresh', onClick: () => (focusTab(t.id), runCommand('restartSession')) },
      { label: 'Reveal folder', icon: 'folder-open', onClick: () => s && api.shell.openPath(s.cwd) },
      { separator: true },
      { label: 'Close tab', icon: 'x', danger: true, onClick: () => t.sessionIds.forEach((id) => closeSession(id)) },
      { label: 'Close other tabs', icon: 'x', danger: true, onClick: () => get().tabs.filter((x) => x.id !== t.id).forEach((x) => x.sessionIds.forEach((id) => closeSession(id))) }
    ])
  }

  return (
    <div className="titlebar">
      {!popout && (
        <button className="brand icon-btn" style={{ width: 'auto', padding: '0 8px' }} onClick={(e) => newMenu(e.currentTarget)} title="Claude Deck">
          <span className="brand-mark">
            <Icon name="sparkles" size={12} stroke={2.4} />
          </span>
          <span>Deck</span>
        </button>
      )}
      <div className="tabs" onDragOver={(e) => e.preventDefault()}>
        {tabs.map((t, i) => {
          const { list, status, unread, pending } = tabStatus(t, sessions)
          const first = list[0]
          if (!first) return null
          const title = list.length > 1 ? list.map((s) => s.name).join(' · ') : first.name
          const stripe = list.find((s) => s.meshColor && Object.values(sessions).filter((x) => x.meshGroup === s.meshGroup && x.status !== 'exited').length > 1)?.meshColor
          return (
            <div
              key={t.id}
              className={`tab ${t.id === activeTabId ? 'active' : ''} ${unread ? 'unread' : ''} ${dropBefore === t.id ? 'drop-before' : ''}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-deck-tab', t.id)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes('application/x-deck-tab')) {
                  e.preventDefault()
                  setDropBefore(t.id)
                }
              }}
              onDragLeave={() => setDropBefore(null)}
              onDrop={(e) => {
                const from = e.dataTransfer.getData('application/x-deck-tab')
                setDropBefore(null)
                if (from && from !== t.id) moveTab(from, i)
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  t.sessionIds.forEach((id) => closeSession(id))
                } else if (e.button === 0) focusTab(t.id)
              }}
              onContextMenu={(e) => tabMenu(e, t)}
              title={`${title}\n${first.cwd}\n${STATUS_LABEL[status]}`}
            >
              <span className={`dot ${status}`} />
              {first.kind === 'login' && <Icon name="login" size={13} />}
              {first.kind === 'command' && <Icon name="cloud" size={13} />}
              {list.length > 1 && <Icon name="split" size={13} />}
              <span className="title">{title}</span>
              {pending > 0 && <span className="count" title="Unread peer messages">{pending}</span>}
              <button
                className="icon-btn sm close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  t.sessionIds.forEach((id) => closeSession(id))
                }}
                title="Close"
              >
                <Icon name="x" size={13} />
              </button>
              {stripe && <span className="stripe" style={{ background: stripe }} />}
            </div>
          )
        })}
      </div>
      {!popout && (
        <button className="icon-btn" title={`New session (${prettyCombo(sc.newSession)})`} onClick={() => set({ newSession: {} })} onContextMenu={(e) => newMenu(e.currentTarget)}>
          <Icon name="plus" />
        </button>
      )}
      <div className="drag" onDoubleClick={() => set({ newSession: {} })} />
      {tabs.length > 0 && !popout && (
        <button
          className="icon-btn"
          title="Drop a tab here to merge it into the active tab as a split"
          onDragOver={(e) => e.dataTransfer.types.includes('application/x-deck-tab') && e.preventDefault()}
          onDrop={(e) => {
            const from = e.dataTransfer.getData('application/x-deck-tab')
            const into = get().activeTabId
            if (from && into) mergeTabInto(from, into)
          }}
          onClick={() => runCommand('splitRight')}
        >
          <Icon name="split" />
        </button>
      )}
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
