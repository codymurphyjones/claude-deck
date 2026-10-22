import { useEffect, useRef, useState } from 'react'
import type { BoardItem, MeshMessageKind, MeshRole } from '@shared/types'
import { api, type LiveSession } from '../api'
import { askText, focusSessionTab, openSession, set, useStore } from '../store'
import { Icon } from './Icon'
import { openMenuAt, Seg, STATUS_LABEL, timeAgo, useNow } from './ui'

const COLS: { id: BoardItem['status']; title: string }[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'done', title: 'Done' }
]

export function TeamPanel({ session }: { session?: LiveSession }) {
  const mesh = useStore((s) => s.mesh)
  const sessions = useStore((s) => s.sessions)
  const teamKey = useStore((s) => s.teamKey)
  const enabled = useStore((s) => s.settings.mesh.enabled)
  const liveGroups = Object.values(mesh).filter((g) => Object.values(sessions).some((s) => s.meshGroup === g.key && s.status !== 'exited'))
  const key = (teamKey && mesh[teamKey] ? teamKey : undefined) ?? session?.meshGroup ?? liveGroups[0]?.key
  const g = key ? mesh[key] : undefined
  const [tab, setTab] = useState<'overview' | 'board' | 'notes'>('overview')
  const [to, setTo] = useState('all')
  const [kind, setKind] = useState<MeshMessageKind>('request')
  const [text, setText] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useNow(15_000)

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [g?.messages.length, tab])

  if (!enabled) return <div className="empty-note">Collaboration is off. Enable it in Settings → Collaboration.</div>
  if (!g)
    return (
      <div className="empty-note">
        No team yet. Sessions that share a folder (or worktrees of one repository) form a team automatically.
        <div style={{ marginTop: 12 }} className="row">
          {session && (
            <button className="btn sm" onClick={() => openSession('agent', { cwd: session.cwd }, { mode: 'split', splitOf: session.id })}>
              <Icon name="split" size={13} /> Add a peer here
            </button>
          )}
          <button className="btn sm primary" onClick={() => set({ fleetOpen: { cwd: session?.cwd } })}>
            <Icon name="users" size={13} /> Launch a team
          </button>
        </div>
      </div>
    )

  const members = Object.values(sessions).filter((s) => s.meshGroup === g.key && s.kind === 'agent' && s.status !== 'exited')
  const send = (): void => {
    if (!text.trim()) return
    void api.mesh.send(g.key, to, text.trim(), kind)
    setText('')
  }
  const addTask = async (): Promise<void> => {
    const title = await askText('New task for the team board', '', { placeholder: 'e.g. Add pagination to /api/users' })
    if (title) void api.mesh.board(g.key, 'add', { title })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="col" style={{ padding: '8px 10px', gap: 6, borderBottom: '1px solid var(--border)' }}>
        <div className="row">
          {liveGroups.length > 1 ? (
            <select className="select" style={{ flex: 1 }} value={g.key} onChange={(e) => set({ teamKey: e.target.value })}>
              {liveGroups.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          ) : (
            <b className="grow ellipsis">{g.label}</b>
          )}
          <span className="badge">{members.length} sessions</span>
          <button
            className="icon-btn sm"
            title="Team actions"
            onClick={(e) =>
              openMenuAt(e.currentTarget, [
                { label: 'Add a session to this team', icon: 'plus', onClick: () => members[0] && openSession('agent', { cwd: members[0].cwd }) },
                { label: 'Add a reviewer', icon: 'eye', onClick: () => members[0] && openSession('agent', { cwd: members[0].cwd, role: 'reviewer', name: 'reviewer', permissionMode: 'plan' }) },
                { label: 'Broadcast a prompt…', icon: 'radio', onClick: () => set({ broadcastOpen: true }) },
                { separator: true },
                { label: 'Clear message & edit history', icon: 'trash', danger: true, onClick: () => api.mesh.clear(g.key) }
              ])
            }
          >
            <Icon name="more" size={14} />
          </button>
        </div>
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            ['overview', 'Overview'],
            ['board', `Board (${g.board.filter((b) => b.status !== 'done').length})`],
            ['notes', `Notes (${Object.keys(g.notes).length})`]
          ]}
        />
      </div>

      {tab === 'overview' && (
        <>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 6, borderBottom: '1px solid var(--border)', maxHeight: '42%', overflow: 'auto' }}>
            {members.map((m) => {
              const claims = g.claims.filter((c) => c.sessionId === m.id)
              return (
                <div key={m.id} className="peer">
                  <span className={`dot ${m.status}`} style={{ marginTop: 5 }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <b className="ellipsis" style={{ cursor: 'var(--cursor)' }} onClick={() => focusSessionTab(m.id)}>
                        {m.name}
                      </b>
                      <RolePicker id={m.id} role={m.role} />
                      <span className="muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                        {STATUS_LABEL[m.status]}
                      </span>
                    </div>
                    {m.lastPrompt && (
                      <div className="muted ellipsis" style={{ fontSize: 12 }} title={m.lastPrompt}>
                        {m.lastPrompt}
                      </div>
                    )}
                    {claims.length > 0 && (
                      <div className="row" style={{ flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                        {claims.map((c) => (
                          <span key={c.key} className="badge" title={`${c.intent}${c.soft ? ' (auto while editing)' : ''} — click to release`} style={{ cursor: 'var(--cursor)' }} onClick={() => api.mesh.releaseClaim(g.key, c.key)}>
                            <Icon name="lock" size={10} /> {c.key}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {m.pendingMessages > 0 && (
                    <button className="btn sm" title="Deliver unread messages now" onClick={() => api.session.deliverMessages(m.id)}>
                      {m.pendingMessages} <Icon name="send" size={11} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
          <div ref={listRef} style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {!g.messages.length && (
              <div className="empty-note">
                Messages between sessions appear here. Sessions also see each other's tasks, claims and edits automatically — they message when they need something.
              </div>
            )}
            {g.messages.map((m) => (
              <div key={m.id} className={`msg ${m.from === 'user' ? 'user' : ''}`}>
                <div className="meta">
                  <b style={{ color: 'var(--text)' }}>{m.from === 'user' ? 'You' : m.fromName}</b>
                  <Icon name="arrow" size={10} />
                  <span>{m.to === 'all' ? 'everyone' : m.to === 'user' ? 'you' : m.toName}</span>
                  <span className="badge" style={{ height: 15, fontSize: 10 }}>
                    {m.kind}
                  </span>
                  <span style={{ marginLeft: 'auto' }}>{timeAgo(m.ts)}</span>
                </div>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                {m.readBy.length > 0 && m.to !== 'user' && (
                  <div className="muted" style={{ fontSize: 10.5, marginTop: 3 }}>
                    seen by {m.readBy.map((id) => sessions[id]?.name ?? 'a session').join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="col" style={{ padding: 10, borderTop: '1px solid var(--border)', gap: 6 }}>
            <div className="row" style={{ gap: 6 }}>
              <select className="select" style={{ flex: 1 }} value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="all">To everyone</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    To {m.name}
                  </option>
                ))}
              </select>
              <select className="select" style={{ width: 120 }} value={kind} onChange={(e) => setKind(e.target.value as MeshMessageKind)}>
                <option value="request">Request</option>
                <option value="question">Question</option>
                <option value="info">FYI</option>
                <option value="handoff">Handoff</option>
              </select>
            </div>
            <div className="row" style={{ gap: 6, alignItems: 'flex-end' }}>
              <textarea
                className="textarea"
                rows={2}
                style={{ minHeight: 44 }}
                placeholder="Message the team — idle sessions pick it up right away"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <button className="btn primary" onClick={send} style={{ height: 44 }}>
                <Icon name="send" size={14} />
              </button>
            </div>
          </div>
        </>
      )}

      {tab === 'board' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 10 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <span className="muted grow" style={{ fontSize: 12 }}>
              A lead session splits work here with <code>board_add</code>; workers take tasks with <code>board_take</code>. You can drag cards and assign owners too.
            </span>
            <button className="btn sm primary" onClick={addTask}>
              <Icon name="plus" size={12} /> Task
            </button>
          </div>
          <div className="kanban">
            {COLS.map((col) => (
              <div
                key={col.id}
                className={`kanban-col ${overCol === col.id ? 'over' : ''}`}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOverCol(col.id)
                }}
                onDragLeave={() => setOverCol(null)}
                onDrop={() => {
                  if (dragId) void api.mesh.board(g.key, 'update', { id: dragId, status: col.id })
                  setDragId(null)
                  setOverCol(null)
                }}
              >
                <div className="row muted" style={{ fontSize: 11.5, padding: '2px 2px 4px' }}>
                  <span className="grow" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>
                    {col.title}
                  </span>
                  <span>{g.board.filter((b) => b.status === col.id).length}</span>
                </div>
                {g.board
                  .filter((b) => b.status === col.id)
                  .map((b) => (
                    <div key={b.id} className="kcard" draggable onDragStart={() => setDragId(b.id)} title={b.detail}>
                      <div className="row" style={{ gap: 4, alignItems: 'flex-start' }}>
                        <span className="grow">{b.title}</span>
                        <button
                          className="icon-btn sm"
                          style={{ width: 18, height: 18 }}
                          onClick={(e) =>
                            openMenuAt(e.currentTarget, [
                              ...members.map((m) => ({ label: `Assign to ${m.name}`, icon: b.owner === m.id ? 'check' : 'user', onClick: () => api.mesh.board(g.key, 'update', { id: b.id, owner: m.id }) })),
                              { label: 'Unassign', icon: 'x', onClick: () => api.mesh.board(g.key, 'update', { id: b.id, owner: '' }) },
                              { separator: true },
                              { label: 'Edit…', icon: 'edit', onClick: () => askText('Task', b.title).then<unknown>((t) => t && api.mesh.board(g.key, 'update', { id: b.id, title: t })) },
                              { label: 'Delete', icon: 'trash', danger: true, onClick: () => api.mesh.board(g.key, 'delete', { id: b.id }) }
                            ])
                          }
                        >
                          <Icon name="more" size={12} />
                        </button>
                      </div>
                      <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                        [{b.id}] {b.ownerName ? `· ${b.ownerName}` : '· unassigned'}
                      </div>
                      {b.notes.length > 0 && (
                        <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                          “{b.notes[b.notes.length - 1].text}”
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'notes' && (
        <div style={{ flex: 1, overflow: 'auto', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="row">
            <span className="muted grow" style={{ fontSize: 12 }}>
              A shared blackboard (decisions, API contracts, conventions). Sessions read it with <code>notes_get</code>.
            </span>
            <button
              className="btn sm primary"
              onClick={async () => {
                const k = await askText('Note title', '')
                if (!k) return
                const v = await askText(`Note: ${k}`, '', { multiline: true })
                if (v) void api.mesh.setNote(g.key, k, v)
              }}
            >
              <Icon name="plus" size={12} /> Note
            </button>
          </div>
          {Object.entries(g.notes).map(([k, n]) => (
            <div key={k} className="msg">
              <div className="meta">
                <b style={{ color: 'var(--text)' }}>{k}</b> by {n.by} · {timeAgo(n.ts)}
                <span style={{ marginLeft: 'auto' }} className="row">
                  <button className="icon-btn sm" onClick={() => askText(k, n.value, { multiline: true }).then<unknown>((v) => v !== null && api.mesh.setNote(g.key, k, v))}>
                    <Icon name="edit" size={12} />
                  </button>
                  <button className="icon-btn sm" onClick={() => api.mesh.setNote(g.key, k, null)}>
                    <Icon name="trash" size={12} />
                  </button>
                </span>
              </div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{n.value}</div>
            </div>
          ))}
          {g.edits.length > 0 && <div className="section-label">Recent edits across the team</div>}
          {[...g.edits]
            .reverse()
            .slice(0, 40)
            .map((e, i) => (
              <div key={i} className="row" style={{ fontSize: 12 }}>
                <span className="muted" style={{ width: 34 }}>
                  {timeAgo(e.ts)}
                </span>
                <b>{e.sessionName}</b>
                <span className="muted">{e.tool}</span>
                <span className="mono ellipsis">{e.key}</span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

function RolePicker({ id, role }: { id: string; role: MeshRole }) {
  return (
    <span
      className={`badge ${role !== 'free' ? 'accent' : ''}`}
      style={{ cursor: 'var(--cursor)' }}
      onClick={(e) =>
        openMenuAt(e.currentTarget, (['free', 'lead', 'worker', 'driver', 'reviewer'] as MeshRole[]).map((r) => ({ label: r === 'free' ? 'no role' : r, icon: r === role ? 'check' : undefined, onClick: () => api.session.setRole(id, r) })))
      }
    >
      {role === 'free' ? 'peer' : role}
    </span>
  )
}
