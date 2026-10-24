import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/types'
import { isOpenFailure, plainLines, scriptState, type ProcessInfo, type ScriptPackage } from '@shared/processes'
import { api } from '../api'
import { attempt, get, loadScripts, openProcessTab, retargetProcessTab, set, useStore } from '../store'
import { attach, detach, focusTerminal, hydrate, refit } from '../terminal/registry'
import { Icon } from './Icon'
import { openMenu, useNow } from './ui'

function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

const where = (p: ProcessInfo): string => (p.rel ? ` · ${p.rel}` : '')

const runScript = (projectId: string, pkg: ScriptPackage, script: string): Promise<unknown> => attempt(() => api.processes.start(projectId, pkg.dir, script))

// ------------------------------------------------------------------ sidebar section
/** Right-click on a script or process: open its terminal output. */
const showLog = (e: React.MouseEvent, p?: ProcessInfo): void => {
  if (!p) return
  e.preventDefault()
  e.stopPropagation()
  openProcessTab(p.id)
}

/**
 * A project's package.json scripts and the processes it owns. `embedded`: always open, without its
 * own header row (the Actions sidebar view).
 */
export function ProjectActions({ project, embedded = false }: { project: Project; embedded?: boolean }) {
  const [openState, setOpen] = useState(false)
  const open = embedded || openState
  const focus = useStore((s) => s.actionsFocus)
  useEffect(() => {
    if (focus !== project.id) return
    setOpen(true)
    set({ actionsFocus: undefined })
  }, [focus, project.id])
  const [q, setQ] = useState('')
  const pkgs = useStore((s) => s.scripts[project.id])
  const procs = useStore((s) => s.processes).filter((p) => p.projectId === project.id)
  // Active list: what's running plus failures nobody has looked at. Successes go away quietly.
  const active = procs.filter((p) => p.status === 'running' || isOpenFailure(p))
  const running = procs.filter((p) => p.status === 'running').length
  const failed = procs.filter(isOpenFailure).length
  useNow(running ? 1000 : 60_000)
  useEffect(() => {
    if (open && !get().scripts[project.id]) void loadScripts(project.id)
  }, [open, project.id])

  const total = pkgs?.reduce((n, p) => n + Object.keys(p.scripts).length, 0) ?? 0
  const ql = q.trim().toLowerCase()
  // Root package first, then sub-packages by path.
  const shown = [...(pkgs ?? [])]
    .sort((a, b) => Number(!!a.rel) - Number(!!b.rel) || a.rel.localeCompare(b.rel))
    .map((p) => ({ pkg: p, names: Object.keys(p.scripts).filter((n) => !ql || n.toLowerCase().includes(ql) || p.rel.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql)) }))
    .filter((g) => g.names.length)

  return (
    <>
      {!embedded && (
      <div
        className="list-item chat-item"
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) => openMenu(e, [{ label: 'Rescan package.json scripts', icon: 'refresh', onClick: () => void loadScripts(project.id, true) }])}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} style={{ color: 'var(--muted)' }} />
        <Icon name="play" size={13} style={{ color: 'var(--muted)' }} />
        <span className="grow">Actions</span>
        {running > 0 && (
          <span className="badge warn" title={`${running} running`}>
            <span className="dot running" style={{ width: 6, height: 6 }} /> {running}
          </span>
        )}
        {failed > 0 && (
          <span className="badge err" title={`${failed} failed`}>
            <Icon name="x" size={10} /> {failed}
          </span>
        )}
        {open && (
          <span className="actions">
            <button
              className="icon-btn sm"
              title="Rescan package.json scripts"
              onClick={(e) => {
                e.stopPropagation()
                void loadScripts(project.id, true)
              }}
            >
              <Icon name="refresh" size={12} />
            </button>
          </span>
        )}
      </div>
      )}
      {open && (
        <div className="proj-actions">
          {active.map((p) => (
            <ProcessRow key={p.id} p={p} />
          ))}
          {total > 12 && <input className="input sm" style={{ margin: '2px 0 4px' }} placeholder="Filter scripts…" value={q} onChange={(e) => setQ(e.target.value)} />}
          {!pkgs && <div className="empty-note">Scanning package.json files…</div>}
          {pkgs && !pkgs.length && <div className="empty-note">No package.json scripts found in this project.</div>}
          {shown.map(({ pkg, names }) => (
            <PackageFolder key={pkg.dir} projectId={project.id} pkg={pkg} names={names} procs={procs} defaultOpen={shown.length === 1} forceOpen={!!ql} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * The Actions sidebar view: the current project's scripts and processes (the code on disk, not
 * chats). Follows the selected project tab; from Home or Quick chats, pick a project. Scripts
 * running in other projects are listed too, so nothing keeps running out of sight.
 */
export function ActionsView() {
  const projects = useStore((s) => s.library.projects)
  const activeGroup = useStore((s) => s.activeGroup)
  const focus = useStore((s) => s.actionsFocus)
  const procs = useStore((s) => s.processes)
  const [picked, setPicked] = useState<string | undefined>(undefined)
  // "All actions" links (Overview, command palette) name a project.
  useEffect(() => {
    if (!focus) return
    setPicked(focus)
    set({ actionsFocus: undefined })
  }, [focus])
  const fromTab = projects.some((p) => p.id === activeGroup) ? activeGroup : undefined
  const id = (focus ?? fromTab ?? picked) || projects[0]?.id
  const p = projects.find((x) => x.id === id)
  const elsewhere = procs.filter((x) => x.projectId !== id && (x.status === 'running' || isOpenFailure(x)))
  return (
    <>
      <div className="sidebar-head">
        <span className="title">Actions</span>
        {p && (
          <button className="icon-btn sm" title="Rescan package.json scripts" onClick={() => void loadScripts(p.id, true)}>
            <Icon name="refresh" size={14} />
          </button>
        )}
      </div>
      <div className="col" style={{ padding: '0 10px 8px', gap: 6 }}>
        {fromTab && !focus ? (
          <div className="muted mono ellipsis" style={{ fontSize: 11.5 }} title={`${p?.folders[0] ?? ''} (follows the selected project tab)`}>
            {p?.name}
          </div>
        ) : (
          <select className="select" value={id ?? ''} onChange={(e) => setPicked(e.target.value)}>
            {projects.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="sidebar-body">
        {!p && <div className="empty-note">Add a project to run its scripts here.</div>}
        {p && <ProjectActions key={p.id} project={p} embedded />}
        {elsewhere.length > 0 && (
          <>
            <div className="section-label">Running in other projects</div>
            {elsewhere.map((x) => (
              <div key={x.id} title={projects.find((q) => q.id === x.projectId)?.name}>
                <ProcessRow p={x} />
              </div>
            ))}
          </>
        )}
      </div>
    </>
  )
}

const STATE_HINT = { '': 'Last run stopped', running: 'Running', success: 'Last run succeeded', failed: 'Last run failed' }

/** One package.json as a collapsible folder of its scripts. */
function PackageFolder({ projectId, pkg, names, procs, defaultOpen, forceOpen }: { projectId: string; pkg: ScriptPackage; names: string[]; procs: ProcessInfo[]; defaultOpen: boolean; forceOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const expanded = open || forceOpen
  const own = procs.filter((p) => p.cwd === pkg.dir)
  const states = Object.keys(pkg.scripts).map((n) => scriptState(own.filter((p) => p.script === n)).state)
  const running = states.filter((x) => x === 'running').length
  const failed = states.filter((x) => x === 'failed').length
  const state = running ? 'running' : failed ? 'failed' : states.includes('success') ? 'success' : ''
  const label = pkg.rel || 'root'
  return (
    <>
      <div className={`list-item proj-folder ${state}`} title={`${pkg.name}\n${pkg.dir}\n${pkg.pm} · ${Object.keys(pkg.scripts).length} scripts`} onClick={() => setOpen(!expanded)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
        <Icon name={expanded ? 'folder-open' : 'folder'} size={13} />
        <span className="grow ellipsis">{label}</span>
        {running > 0 && <span className="sub proj-count running">{running} running</span>}
        {failed > 0 && <span className="sub proj-count failed">{failed} failed</span>}
        {!running && !failed && <span className="sub">{names.length}</span>}
      </div>
      {expanded &&
        names.map((n) => {
          const { state: st, latest, live } = scriptState(own.filter((p) => p.script === n))
          const hint = latest ? `${STATE_HINT[st]} · right-click for output\n` : ''
          return (
            <div
              key={n}
              className={`list-item proj-script ${st}`}
              title={`${hint}${pkg.scripts[n]}\n\nClick to run in ${label}`}
              onClick={() => void runScript(projectId, pkg, n)}
              onContextMenu={(e) => showLog(e, latest)}
            >
              <Icon name={st === 'failed' ? 'x' : st === 'success' ? 'check' : 'play'} size={11} />
              <span className="grow ellipsis">{n}</span>
              {live > 1 && <span className="sub">×{live}</span>}
            </div>
          )
        })}
    </>
  )
}

function ProcessRow({ p }: { p: ProcessInfo }) {
  const now = Date.now()
  const status = p.status === 'running' ? `running ${elapsed(now - p.startedAt)}` : p.status === 'success' ? 'done' : p.status === 'failed' ? `failed · exit ${p.exitCode}` : 'stopped'
  return (
    <div className={`list-item proj-proc ${p.status}`} title={`${p.command}\n${p.cwd}${p.reason ? `\n\n${p.reason}` : ''}`} onClick={() => openProcessTab(p.id)} onContextMenu={(e) => showLog(e, p)}>
      {p.status === 'running' ? <span className="dot running" /> : <Icon name={p.status === 'success' ? 'check' : 'x'} size={12} />}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          {p.script}
          <span className="muted">{where(p)}</span>
        </div>
        <div className="sub ellipsis">{p.status === 'failed' && p.reason ? p.reason : status}</div>
      </div>
      <span className="actions" style={{ display: 'flex' }}>
        <ProcessButtons p={p} small />
      </span>
    </div>
  )
}

function ProcessButtons({ p, small, log = true }: { p: ProcessInfo; small?: boolean; log?: boolean }) {
  const cls = small ? 'icon-btn sm' : 'btn sm'
  const stop = (e: React.MouseEvent): void => (e.stopPropagation(), void attempt(() => api.processes.stop(p.id)))
  const restart = (e: React.MouseEvent): void => {
    e.stopPropagation()
    void attempt(() => api.processes.restart(p.id)).then((np) => {
      // Keep an open terminal tab following the new run.
      if (np) retargetProcessTab(p.id, np.id)
    })
  }
  const dismiss = (e: React.MouseEvent): void => (e.stopPropagation(), void attempt(() => api.processes.dismiss(p.id)))
  return (
    <>
      {log && small && (
        <button className={cls} title="View log" onClick={(e) => (e.stopPropagation(), openProcessTab(p.id))}>
          <Icon name="terminal" size={12} />
        </button>
      )}
      {p.status === 'running' ? (
        <button className={cls} title="Stop" onClick={stop}>
          <Icon name="stop" size={12} />
          {!small && ' Stop'}
        </button>
      ) : (
        <>
          <button className={cls} title="Run again" onClick={restart}>
            <Icon name="refresh" size={12} />
            {!small && ' Run again'}
          </button>
          {isOpenFailure(p) && (
            <button className={cls} title="Dismiss" onClick={dismiss}>
              <Icon name="x" size={12} />
              {!small && ' Dismiss'}
            </button>
          )}
        </>
      )}
    </>
  )
}

// ------------------------------------------------------------------ log viewer
/**
 * A script run's terminal, shown in a sub-tab of its project's workspace (next to the chats). Closing
 * the tab leaves the script running; "Close terminal" stops it and clears its status.
 */
export function ProcessPane({ processId, active }: { processId: string; active: boolean }) {
  const p = useStore((s) => s.processes.find((x) => x.id === processId))
  const host = useRef<HTMLDivElement>(null)
  useNow(p?.status === 'running' && active ? 1000 : 60_000)
  useEffect(() => {
    const el = host.current
    if (!el || !p) return
    attach(processId, el)
    void hydrate(processId).then(() => refit(processId))
    return () => detach(processId, el)
  }, [processId, !!p])
  // Fit the terminal when its tab is shown (it can't measure itself while hidden).
  useEffect(() => {
    if (!active || !p) return
    requestAnimationFrame(() => {
      refit(processId)
      focusTerminal(processId)
    })
  }, [active, processId, !!p])
  if (!p) return <div className="empty-note">This run is gone.</div>
  const copy = async (): Promise<void> => {
    await api.clipboard.writeText(plainLines(await api.session.buffer(p.id)).join('\n'))
  }
  return (
    <div className="proc-pane">
      <div className="proc-pane-head">
        <Icon name="terminal" size={14} style={{ color: 'var(--accent)' }} />
        <span className="mono ellipsis" title={p.command}>
          {p.command}
        </span>
        <span className={`badge ${p.status === 'running' ? 'warn' : p.status === 'failed' ? 'err' : p.status === 'success' ? 'ok' : ''}`}>
          {p.status === 'running' ? `running ${elapsed(Date.now() - p.startedAt)}` : p.status === 'failed' ? `failed · exit ${p.exitCode}` : p.status}
        </span>
        <span className="muted mono ellipsis grow" style={{ fontSize: 11.5 }} title={p.cwd}>
          {p.rel || p.cwd}
        </span>
        <button className="btn sm" title="Copy output" onClick={() => void attempt(copy, 'Output copied')}>
          <Icon name="copy" size={12} /> Copy
        </button>
        <button className="btn sm" title="Reveal folder" onClick={() => api.shell.openPath(p.cwd)}>
          <Icon name="folder-open" size={12} />
        </button>
        <ProcessButtons p={p} log={false} />
        <button
          className="btn sm danger"
          title={p.status === 'running' ? 'Stop the process, close its terminal and clear its status' : 'Close this terminal and clear the script’s status'}
          onClick={() => void attempt(() => api.processes.close(p.id))}
        >
          <Icon name="trash" size={12} /> Close terminal
        </button>
      </div>
      {p.status === 'failed' && p.reason && (
        <div className="proc-reason">
          <Icon name="x" size={13} /> {p.reason}
        </div>
      )}
      <div className="proc-pane-term" ref={host} />
    </div>
  )
}

// ------------------------------------------------------------------ failure alerts
/** Sticky cards for failed processes: they stay until dismissed or re-run. */
export function ProcessAlerts() {
  const failed = useStore((s) => s.processes).filter(isOpenFailure)
  const projects = useStore((s) => s.library.projects)
  // The run whose terminal tab is showing doesn't need a card too.
  const viewing = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.processId)
  const cards = failed.filter((p) => p.id !== viewing)
  if (!cards.length) return null
  return (
    <div className="proc-alerts">
      {cards.slice(-4).map((p) => {
        const project = projects.find((x) => x.id === p.projectId)
        const tail = (p.tail ?? '').split('\n').slice(-6).join('\n')
        return (
          <div key={p.id} className="proc-alert" role="alert">
            <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <Icon name="x" size={15} style={{ color: 'var(--danger)', marginTop: 2 }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }}>
                  <span className="mono">{p.command}</span> failed
                </div>
                <div className="sub">
                  {project?.name ?? 'Project'}
                  {where(p)} · exit code {p.exitCode}
                </div>
              </div>
              <button className="icon-btn sm" title="Dismiss" onClick={() => void attempt(() => api.processes.dismiss(p.id))}>
                <Icon name="x" size={13} />
              </button>
            </div>
            {p.reason && <div className="proc-alert-reason">{p.reason}</div>}
            {tail && tail !== p.reason && <pre className="proc-alert-tail mono selectable">{tail}</pre>}
            <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
              <button className="btn sm" onClick={() => openProcessTab(p.id)}>
                <Icon name="terminal" size={12} /> View log
              </button>
              <button className="btn sm" onClick={() => void attempt(() => api.processes.restart(p.id))}>
                <Icon name="refresh" size={12} /> Run again
              </button>
            </div>
          </div>
        )
      })}
      {failed.length > 4 && <div className="proc-alert sub">+{failed.length - 4} more failed — see the project's Actions</div>}
    </div>
  )
}
