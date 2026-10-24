import { useEffect, useState } from 'react'
import { api } from '../api'
import { activeSession, openSession, set, startAction, toast, useStore } from '../store'
import { Icon } from './Icon'
import { providerOf } from '@shared/agent'
import { Modal, Switch } from './ui'

export function GoalDialog() {
  const id = useStore((s) => s.goalFor)
  const s = useStore((st) => (id ? st.sessions[id] : undefined))
  const max = useStore((st) => st.settings.goalMaxIterations)
  const [text, setText] = useState('')
  useEffect(() => setText(s?.goal?.text ?? ''), [id])
  if (!id || !s) return null
  const close = (): void => set({ goalFor: undefined })
  const start = (): void => {
    if (!text.trim()) return
    void api.session.setGoal(id, text.trim())
    close()
  }
  return (
    <Modal
      title={`Set a goal for ${s.name}`}
      icon="target"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={start}>
            Start goal
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="muted" style={{ lineHeight: 1.5 }}>
          Claude keeps working — turn after turn — until the goal's completion criteria are met (up to {max} continuation turns), it says it's blocked, or you pause it. Normal permission rules still apply. Be specific about what “done” means.
        </div>
        <textarea
          className="textarea"
          autoFocus
          rows={6}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. All tests in packages/api pass, lint is clean, and the new /users pagination is documented in README."
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && start()}
        />
        <div className="muted" style={{ fontSize: 12 }}>
          Tip: unclear on the outcome? Start in plan mode first and ask Claude to interview you and propose measurable success criteria.
        </div>
      </div>
    </Modal>
  )
}

export function FleetDialog() {
  const open = useStore((s) => s.fleetOpen)
  const lib = useStore((s) => s.library)
  const [cwd, setCwd] = useState('')
  const [task, setTask] = useState('')
  const [workers, setWorkers] = useState(2)
  const [worktrees, setWorktrees] = useState(false)
  const [reviewer, setReviewer] = useState(false)
  const [model, setModel] = useState('')
  const [isRepo, setIsRepo] = useState(false)
  useEffect(() => {
    if (open) {
      setCwd(open.cwd ?? activeSession()?.root ?? lib.recentFolders[0] ?? '')
      setTask('')
    }
  }, [open])
  useEffect(() => {
    if (cwd) void api.git.info(cwd).then((g) => setIsRepo(g.isRepo))
  }, [cwd])
  if (!open) return null
  const close = (): void => set({ fleetOpen: false })
  const launch = async (): Promise<void> => {
    if (!cwd || !task.trim()) return
    close()
    const base = cwd.split(/[\\/]/).pop() ?? 'team'
    const names = Array.from({ length: workers }, (_, i) => `worker-${i + 1}`)
    const action = startAction(`Launching the team (lead + ${workers} worker${workers > 1 ? 's' : ''})…`, `launch team ${workers}`)
    const lead = await openSession('agent', {
      cwd,
      name: 'lead',
      role: 'lead',
      model: model || undefined,
      initialPrompt: `You are leading a team of ${workers} worker session${workers > 1 ? 's' : ''} (${names.join(', ')})${reviewer ? ' and a reviewer session ("reviewer")' : ''} working in ${base}${worktrees ? ' (each worker has its own git worktree of this repository)' : ''}.\n\nTeam task:\n${task.trim()}\n\nFirst explore just enough to plan. Then split the work into independent, file-disjoint tasks and put them on the shared board with board_add, assigning each to a worker by name. Workers start automatically when you assign them. Monitor progress with board_list and mesh_inbox, answer questions, and when all tasks are done, verify and integrate the results${worktrees ? ' (merge the workers\' branches)' : ''}, then report back to me.`
    })
    if (!lead) return action.drop()
    for (const n of names)
      await openSession(
        'agent',
        {
          cwd,
          name: n,
          role: 'worker',
          model: model || undefined,
          worktree: worktrees && isRepo ? { carryChanges: false } : undefined,
          initialPrompt: `You are ${n}, a worker on a team led by the session "lead". Check board_list for tasks assigned to you. If there are none yet, reply "Ready" and stop: you will be woken automatically when the lead assigns you work.`
        },
        { mode: 'split', splitOf: lead.id, background: false }
      )
    if (reviewer) await openSession('agent', { cwd, name: 'reviewer', role: 'reviewer', permissionMode: 'plan', model: model || undefined }, { mode: 'tab', background: true })
    set({ rightPanel: 'team', teamKey: lead.meshGroup })
    action.done(`Team launched: lead + ${workers} worker${workers > 1 ? 's' : ''}${reviewer ? ' + reviewer' : ''}`)
  }
  return (
    <Modal
      title="Launch a team"
      icon="users"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={launch} disabled={!task.trim() || !cwd}>
            <Icon name="zap" size={13} /> Launch
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="muted" style={{ lineHeight: 1.5 }}>
          Starts a <b>lead</b> session that plans the work and splits it onto a shared task board, plus <b>workers</b> that pick up tasks. They see each other's progress, claim files to avoid conflicts, and message each other — all visible in the Team panel.
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field grow">
            Folder
            <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
          </label>
          <button className="btn" onClick={async () => setCwd((await api.dialog.openFolder())[0] ?? cwd)}>
            Browse
          </button>
        </div>
        <label className="field">
          What should the team build?
          <textarea className="textarea" autoFocus rows={5} value={task} onChange={(e) => setTask(e.target.value)} placeholder="e.g. Add dark mode across the app: theme tokens, a toggle in settings, and update every component's hard-coded colors." />
        </label>
        <div className="row" style={{ gap: 18, flexWrap: 'wrap' }}>
          <label className="field" style={{ width: 120 }}>
            Workers
            <select className="select" value={workers} onChange={(e) => setWorkers(+e.target.value)}>
              {[1, 2, 3].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 200 }}>
            Model
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {providerOf(useStore.getState().settings.defaultProvider).models.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <Switch on={worktrees && isRepo} onChange={(v) => isRepo && setWorktrees(v)} />
          <span className={isRepo ? '' : 'muted'}>Give each worker its own worktree {isRepo ? '' : '(needs a Git repository)'}</span>
        </div>
        <div className="row">
          <Switch on={reviewer} onChange={setReviewer} />
          <span>Add a reviewer session that reviews every finished turn</span>
        </div>
      </div>
    </Modal>
  )
}

export function BroadcastDialog() {
  const open = useStore((s) => s.broadcastOpen)
  const sessions = useStore((s) => s.sessions)
  const list = Object.values(sessions).filter((s) => s.kind === 'agent' && s.status !== 'exited')
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [text, setText] = useState('')
  useEffect(() => {
    if (open) {
      setPicked(Object.fromEntries(list.map((s) => [s.id, true])))
      setText('')
    }
  }, [open])
  if (!open) return null
  const close = (): void => set({ broadcastOpen: false })
  const ids = Object.entries(picked)
    .filter(([, v]) => v)
    .map(([k]) => k)
  const send = (): void => {
    if (!text.trim() || !ids.length) return
    void api.session.broadcast(ids, text.trim())
    toast(`Sent to ${ids.length} session(s) (queued where busy)`, 'success')
    close()
  }
  return (
    <Modal
      title="Broadcast a prompt"
      icon="radio"
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={send} disabled={!ids.length}>
            Send to {ids.length}
          </button>
        </>
      }
    >
      <div className="modal-body">
        <textarea className="textarea" autoFocus rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Run the test suite and report failures." onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && send()} />
        <div className="col" style={{ gap: 4 }}>
          {!list.length && <div className="muted">No running sessions.</div>}
          {list.map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={!!picked[s.id]} onChange={(e) => setPicked((p) => ({ ...p, [s.id]: e.target.checked }))} />
              <span className={`dot ${s.status}`} /> {s.name} <span className="muted mono" style={{ fontSize: 11 }}>{s.cwd}</span>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  )
}
