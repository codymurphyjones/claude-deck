import { useState } from 'react'
import { api } from '../api'
import { runCommand } from '../commands'
import { closeSession, focusTab, get, mergeTabInto, moveTab, openSession, QUICK, set, useStore, type Tab } from '../store'
import { Icon } from './Icon'
import { requestCloseEditor } from './FileEditor'
import { openMenu, STATUS_LABEL } from './ui'

// The active workspace's sub-tabs (its Overview, chats and editor), under the title bar. A popout
// window shows its single chat's tab in its title bar instead (`inTitleBar`).

export function tabStatus(t: Tab, sessions: ReturnType<typeof useStore.getState>['sessions']) {
  const list = t.sessionIds.map((id) => sessions[id]).filter(Boolean)
  const order = ['needs-input', 'waiting-auth', 'working', 'starting', 'blocked', 'idle', 'exited']
  const status = list.map((s) => s.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? 'exited'
  return { list, status, unread: list.some((s) => s.unread), pending: list.reduce((n, s) => n + (s.pendingMessages || 0), 0) }
}

export function SubTabs({ inTitleBar = false }: { inTitleBar?: boolean }) {
  const allTabs = useStore((s) => s.tabs)
  const group = useStore((s) => s.activeGroup)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const project = useStore((s) => s.library.projects.find((p) => p.id === s.activeGroup))
  const popout = useStore((s) => s.popoutSessionId)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const tabs = popout ? allTabs : allTabs.filter((t) => t.group === group)

  const tabMenu = (e: React.MouseEvent, t: Tab): void => {
    const s = sessions[t.activePane]
    openMenu(e, [
      { label: 'Rename…', icon: 'edit', onClick: () => (focusTab(t.id), runCommand('renameSession')) },
      { label: 'Split with new session', icon: 'split', onClick: () => s && openSession('agent', { cwd: s.cwd }, { mode: 'split', splitOf: s.id }) },
      { label: 'Pop out', icon: 'popout', onClick: () => api.window.popOut(t.activePane) },
      { label: 'Fork chat', icon: 'fork', disabled: s?.kind !== 'agent', onClick: () => (focusTab(t.id), runCommand('forkChat')) },
      { label: 'Restart', icon: 'refresh', onClick: () => (focusTab(t.id), runCommand('restartSession')) },
      { label: 'Reveal folder', icon: 'folder-open', onClick: () => s && api.shell.openPath(s.cwd) },
      { separator: true },
      { label: 'Close tab', icon: 'x', danger: true, onClick: () => t.sessionIds.forEach((id) => closeSession(id)) },
      {
        label: 'Close other chats here',
        icon: 'x',
        danger: true,
        onClick: () =>
          get()
            .tabs.filter((x) => x.group === t.group && x.id !== t.id)
            .forEach((x) => (x.editor ? void requestCloseEditor(x.id) : x.sessionIds.forEach((id) => closeSession(id))))
      }
    ])
  }

  const newChat = (): void => {
    if (project) void openSession('agent', { cwd: project.folders[0] })
    else set({ newSession: {} })
  }

  return (
    <div className={inTitleBar ? 'tabs' : 'subtabs'} onDragOver={(e) => e.preventDefault()}>
      {tabs.map((t, i) => {
        const drag = {
          draggable: !t.projectId,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.setData('application/x-deck-tab', t.id)
            e.dataTransfer.effectAllowed = 'move'
          },
          onDragOver: (e: React.DragEvent) => {
            if (e.dataTransfer.types.includes('application/x-deck-tab')) {
              e.preventDefault()
              setDropBefore(t.id)
            }
          },
          onDragLeave: () => setDropBefore(null),
          onDrop: (e: React.DragEvent) => {
            const from = e.dataTransfer.getData('application/x-deck-tab')
            setDropBefore(null)
            if (from && from !== t.id) moveTab(from, i)
          }
        }
        const cls = (extra = ''): string => `tab ${extra} ${t.id === activeTabId ? 'active' : ''} ${dropBefore === t.id ? 'drop-before' : ''}`
        if (t.projectId)
          return (
            <div key={t.id} className={cls('project-tab')} {...drag} onMouseDown={(e) => e.button === 0 && focusTab(t.id)} title={project ? `${project.name}: overview\n${project.folders.join('\n')}` : 'Overview'}>
              <Icon name="home" size={13} style={{ color: 'var(--accent)' }} />
              <span className="title">Overview</span>
            </div>
          )
        if (t.editor)
          return (
            <div
              key={t.id}
              className={cls('project-tab')}
              {...drag}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  void requestCloseEditor(t.id)
                } else if (e.button === 0) focusTab(t.id)
              }}
              onContextMenu={(e) => openMenu(e, [{ label: 'Close editor', icon: 'x', danger: true, onClick: () => void requestCloseEditor(t.id) }])}
              title={`Editor${t.root ? `\n${t.root}` : ''}`}
            >
              <Icon name="code" size={13} style={{ color: 'var(--accent)' }} />
              <span className="title">Editor</span>
              <button
                className="icon-btn sm close"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  void requestCloseEditor(t.id)
                }}
                title="Close"
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          )
        const { list, status, unread, pending } = tabStatus(t, sessions)
        const first = list[0]
        if (!first) return null
        const title = list.length > 1 ? list.map((s) => s.name).join(' · ') : first.name
        const stripe = list.find((s) => s.meshColor && Object.values(sessions).filter((x) => x.meshGroup === s.meshGroup && x.status !== 'exited').length > 1)?.meshColor
        return (
          <div
            key={t.id}
            className={cls(unread ? 'unread' : '')}
            {...drag}
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
            {pending > 0 && (
              <span className="count" title="Unread peer messages">
                {pending}
              </span>
            )}
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
      {!inTitleBar && (
        <>
          <button className="icon-btn sm" title={project ? `New chat in ${project.name}` : group === QUICK ? 'New session' : 'New chat'} onClick={newChat}>
            <Icon name="plus" size={14} />
          </button>
          <span className="grow" />
          {tabs.some((t) => t.sessionIds.length) && (
            <button
              className="icon-btn sm"
              title="Split: drop a chat tab here to merge it into the active tab"
              onDragOver={(e) => e.dataTransfer.types.includes('application/x-deck-tab') && e.preventDefault()}
              onDrop={(e) => {
                const from = e.dataTransfer.getData('application/x-deck-tab')
                const into = get().activeTabId
                if (from && into) mergeTabInto(from, into)
              }}
              onClick={() => runCommand('splitRight')}
            >
              <Icon name="split" size={14} />
            </button>
          )}
        </>
      )}
    </div>
  )
}
