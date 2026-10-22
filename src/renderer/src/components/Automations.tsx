import { useEffect, useState } from 'react'
import type { Automation, AutomationSchedule } from '@shared/types'
import { api } from '../api'
import { attempt, openSession, set, useStore } from '../store'
import { Icon } from './Icon'
import { Modal, openMenu, Seg, Switch, timeAgo, useNow } from './ui'

function describe(s: AutomationSchedule): string {
  if (s.type === 'interval') return s.minutes % 1440 === 0 ? `every ${s.minutes / 1440}d` : s.minutes % 60 === 0 ? `every ${s.minutes / 60}h` : `every ${s.minutes}m`
  if (s.type === 'rrule') return s.rule.replace(/^RRULE:/, '').toLowerCase().slice(0, 40)
  return `on GitHub activity in ${s.repo}`
}

const until = (ts?: number): string => {
  if (!ts) return '—'
  const s = Math.round((ts - Date.now()) / 1000)
  if (s <= 0) return 'due'
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `in ${Math.round(s / 3600)}h`
  return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export function ScheduledView() {
  const { automations, runs } = useStore((s) => s.automations)
  const chats = useStore((s) => s.library.chats)
  const [showArchived, setShowArchived] = useState(false)
  const [openRun, setOpenRun] = useState<string | null>(null)
  useNow(20_000)
  const visibleRuns = runs.filter((r) => showArchived || !r.archived)
  return (
    <>
      <div className="sidebar-head">
        <span className="title">Scheduled</span>
        <button className="btn sm" onClick={() => set({ automationEdit: {} })}>
          <Icon name="plus" size={13} /> New task
        </button>
      </div>
      <div className="sidebar-body">
        {!automations.length && (
          <div className="empty-note">
            Schedule work for Claude: daily reviews, dependency checks, triage, follow-ups inside an existing chat, or runs triggered by GitHub pull-request activity. Tasks run while Claude Deck is open (it keeps running in the tray).
          </div>
        )}
        {automations.map((a) => (
          <div
            key={a.id}
            className="list-item"
            style={{ alignItems: 'flex-start' }}
            onClick={() => set({ automationEdit: a })}
            onContextMenu={(e) =>
              openMenu(e, [
                { label: 'Run now', icon: 'play', onClick: () => api.automations.runNow(a.id) },
                { label: a.status === 'active' ? 'Pause' : 'Resume', icon: a.status === 'active' ? 'pause' : 'play', onClick: () => api.automations.upsert({ id: a.id, status: a.status === 'active' ? 'paused' : 'active' }) },
                { label: 'Edit…', icon: 'edit', onClick: () => set({ automationEdit: a }) },
                { separator: true },
                { label: 'Delete', icon: 'trash', danger: true, onClick: () => api.automations.remove(a.id) }
              ])
            }
          >
            <Icon name={a.kind === 'inchat' ? 'message' : a.schedule.type === 'github' ? 'pr' : 'clock'} size={14} style={{ marginTop: 2, color: a.status === 'active' ? 'var(--accent)' : 'var(--muted)' }} />
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: 600 }}>
                {a.name}
              </div>
              <div className="sub ellipsis">
                {describe(a.schedule)} · {a.status === 'active' ? until(a.nextRun) : a.status}
                {a.kind === 'inchat' && ` · in “${chats.find((c) => c.claudeSessionId === a.targetChatId)?.name ?? 'chat'}”`}
                {a.pending && ' · waiting for chat to be idle'}
              </div>
            </div>
            <span className="actions">
              <button
                className="icon-btn sm"
                title="Run now"
                onClick={(e) => {
                  e.stopPropagation()
                  void api.automations.runNow(a.id)
                }}
              >
                <Icon name="play" size={12} />
              </button>
            </span>
          </div>
        ))}
        <div className="section-label">
          <span className="grow">Inbox</span>
          <button className="btn sm ghost" style={{ height: 18, fontSize: 11 }} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
        {!visibleRuns.length && <div className="empty-note">Runs with results land here.</div>}
        {visibleRuns.slice(0, 60).map((r) => (
          <div key={r.id}>
            <div
              className="list-item"
              style={{ alignItems: 'flex-start' }}
              onClick={() => {
                setOpenRun(openRun === r.id ? null : r.id)
                if (r.unread) void api.automations.updateRun(r.id, { unread: false })
              }}
            >
              {r.unread ? <span className="dot working" style={{ marginTop: 5, animation: 'none' }} /> : <span style={{ width: 8 }} />}
              <div className="grow">
                <div className="row" style={{ gap: 6 }}>
                  <span className="ellipsis" style={{ fontWeight: r.unread ? 650 : 500 }}>
                    {r.automationName}
                  </span>
                  <span className={`badge ${r.status === 'error' ? 'err' : r.status === 'success' ? 'ok' : ''}`}>{r.status}</span>
                </div>
                <div className="sub ellipsis">{r.output || 'Running…'}</div>
              </div>
              <span className="sub">{timeAgo(r.startedAt)}</span>
            </div>
            {openRun === r.id && (
              <div className="card" style={{ margin: '4px 6px 10px', padding: 10, boxShadow: 'none' }}>
                <div className="selectable" style={{ whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.5, maxHeight: 260, overflow: 'auto' }}>
                  {r.output || 'No output yet.'}
                </div>
                <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
                  {r.claudeSessionId && (
                    <button className="btn sm primary" onClick={() => openSession('claude', { cwd: r.cwd, resumeId: r.claudeSessionId, name: r.automationName })}>
                      Continue as chat
                    </button>
                  )}
                  <button className="btn sm" onClick={() => api.automations.updateRun(r.id, { pinned: !r.pinned })}>
                    <Icon name="pin" size={12} /> {r.pinned ? 'Unpin' : 'Pin (keep worktree)'}
                  </button>
                  <button className="btn sm" onClick={() => api.automations.updateRun(r.id, { archived: !r.archived })}>
                    <Icon name="archive" size={12} /> {r.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  {r.costUsd !== undefined && <span className="muted" style={{ fontSize: 11 }}>${r.costUsd.toFixed(3)}</span>}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

const PRESETS: [string, string][] = [
  ['FREQ=DAILY;BYHOUR=9;BYMINUTE=0', 'Every day at 9:00'],
  ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0', 'Weekdays at 9:00'],
  ['FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0', 'Mondays at 10:00'],
  ['FREQ=HOURLY;INTERVAL=4', 'Every 4 hours']
]

export function AutomationDialog() {
  const edit = useStore((s) => s.automationEdit)
  const chats = useStore((s) => s.library.chats)
  const projects = useStore((s) => s.library.projects)
  const [a, setA] = useState<Partial<Automation>>({})
  useEffect(() => {
    if (edit)
      setA({
        name: '',
        prompt: '',
        kind: 'standalone',
        schedule: { type: 'rrule', rule: PRESETS[0][0] },
        useWorktree: false,
        ...edit,
        cwd: edit.cwd ?? projects[0]?.folders[0] ?? ''
      })
  }, [edit, projects])
  if (!edit) return null
  const sch = a.schedule ?? { type: 'interval', minutes: 60 }
  const close = (): void => set({ automationEdit: false })
  const save = async (): Promise<void> => {
    if (!a.prompt?.trim()) return
    if (a.kind === 'standalone' && !a.cwd) return
    const r = await attempt(() => api.automations.upsert({ ...a, name: a.name || a.prompt!.slice(0, 40) }), a.id ? 'Task updated' : 'Task scheduled')
    if (r) close()
  }
  return (
    <Modal
      title={a.id ? 'Edit scheduled task' : 'New scheduled task'}
      icon="clock"
      onClose={close}
      footer={
        <>
          {a.id && (
            <button className="btn danger" style={{ marginRight: 'auto' }} onClick={() => api.automations.remove(a.id!).then(close)}>
              Delete
            </button>
          )}
          {a.id && (
            <button className="btn" onClick={() => api.automations.runNow(a.id!)}>
              Run now
            </button>
          )}
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            {a.id ? 'Save' : 'Schedule'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <Seg
          value={a.kind ?? 'standalone'}
          onChange={(kind) => setA({ ...a, kind, schedule: kind === 'inchat' && sch.type === 'github' ? { type: 'interval', minutes: 30 } : sch })}
          options={[
            ['standalone', 'Standalone (new chat per run)'],
            ['inchat', 'Inside an existing chat']
          ]}
        />
        <label className="field">
          Name
          <input className="input" value={a.name ?? ''} placeholder="Daily dependency check" onChange={(e) => setA({ ...a, name: e.target.value })} />
        </label>
        <label className="field">
          Prompt
          <textarea className="textarea" rows={5} value={a.prompt ?? ''} placeholder="Check for outdated dependencies, summarize risky upgrades, and open a draft PR for safe patch bumps." onChange={(e) => setA({ ...a, prompt: e.target.value })} />
        </label>
        {a.kind === 'inchat' ? (
          <label className="field">
            Chat
            <select className="select" value={a.targetChatId ?? ''} onChange={(e) => setA({ ...a, targetChatId: e.target.value })}>
              <option value="">Choose a chat…</option>
              {chats
                .filter((c) => !c.archived)
                .slice(0, 100)
                .map((c) => (
                  <option key={c.claudeSessionId} value={c.claudeSessionId}>
                    {c.name} — {c.cwd.split(/[\\/]/).pop()}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field grow">
              Folder
              <input className="input mono" value={a.cwd ?? ''} onChange={(e) => setA({ ...a, cwd: e.target.value })} list="deck-projects" />
              <datalist id="deck-projects">
                {projects.map((p) => (
                  <option key={p.id} value={p.folders[0]} />
                ))}
              </datalist>
            </label>
            <button className="btn" onClick={async () => setA({ ...a, cwd: (await api.dialog.openFolder())[0] ?? a.cwd })}>
              Browse…
            </button>
          </div>
        )}
        <label className="field">
          When
          <Seg
            value={sch.type}
            onChange={(type) =>
              setA({
                ...a,
                schedule: type === 'interval' ? { type, minutes: 60 } : type === 'rrule' ? { type, rule: PRESETS[0][0] } : { type: 'github', repo: '', events: ['pr'] }
              })
            }
            options={[
              ['rrule', 'Calendar'],
              ['interval', 'Interval'],
              ...(a.kind !== 'inchat' ? ([['github', 'GitHub trigger']] as [AutomationSchedule['type'], string][]) : [])
            ]}
          />
        </label>
        {sch.type === 'interval' && (
          <div className="row">
            <span>Every</span>
            <input className="input" style={{ width: 90 }} type="number" min={1} value={sch.minutes} onChange={(e) => setA({ ...a, schedule: { type: 'interval', minutes: Math.max(1, +e.target.value) } })} />
            <span>minutes</span>
          </div>
        )}
        {sch.type === 'rrule' && (
          <div className="col">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              {PRESETS.map(([r, l]) => (
                <button key={r} className={`btn sm ${sch.rule === r ? 'primary' : ''}`} onClick={() => setA({ ...a, schedule: { type: 'rrule', rule: r } })}>
                  {l}
                </button>
              ))}
            </div>
            <label className="field">
              RRULE (RFC 5545)
              <input className="input mono" value={sch.rule} onChange={(e) => setA({ ...a, schedule: { type: 'rrule', rule: e.target.value } })} />
            </label>
          </div>
        )}
        {sch.type === 'github' && (
          <div className="row">
            <label className="field grow">
              Repository (owner/name)
              <input className="input mono" value={sch.repo} placeholder="octocat/hello-world" onChange={(e) => setA({ ...a, schedule: { ...sch, repo: e.target.value } })} />
            </label>
            <label className="field grow">
              Filter (title, author or label contains)
              <input className="input" value={sch.filter ?? ''} onChange={(e) => setA({ ...a, schedule: { ...sch, filter: e.target.value } })} />
            </label>
          </div>
        )}
        {a.kind !== 'inchat' && (
          <>
            <div className="row">
              <Switch on={!!a.useWorktree} onChange={(useWorktree) => setA({ ...a, useWorktree })} />
              <span>Run in a dedicated background worktree (Git repos) so it never touches your working copy</span>
            </div>
            <div className="row">
              <label className="field grow">
                Model
                <input className="input" value={a.model ?? ''} placeholder="default" onChange={(e) => setA({ ...a, model: e.target.value || undefined })} />
              </label>
              <label className="field grow">
                Effort
                <select className="select" value={a.effort ?? ''} onChange={(e) => setA({ ...a, effort: e.target.value || undefined })}>
                  <option value="">default</option>
                  {['low', 'medium', 'high', 'xhigh', 'max'].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                Permissions
                <select className="select" value={a.permissionMode ?? 'acceptEdits'} onChange={(e) => setA({ ...a, permissionMode: e.target.value })}>
                  <option value="plan">Read-only (plan)</option>
                  <option value="acceptEdits">Workspace edits</option>
                  <option value="auto">Auto</option>
                  <option value="bypassPermissions">Full access</option>
                </select>
              </label>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              Runs are unattended: anything that would need an approval prompt is denied automatically.
            </div>
          </>
        )}
        {a.id && (
          <div className="row">
            <Switch on={a.status === 'active'} onChange={(on) => setA({ ...a, status: on ? 'active' : 'paused' })} />
            <span>Active</span>
          </div>
        )}
      </div>
    </Modal>
  )
}
