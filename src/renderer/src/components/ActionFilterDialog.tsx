import { useState } from 'react'
import { actionKey, folderKey, packageScriptKey, scriptKey, toolKey, type HideScope } from '@shared/actionFilters'
import { setHidden, useHiddenRules } from '../actionFilters'
import { useStore } from '../store'
import { Icon } from './Icon'
import { Modal } from './ui'

// "Hide actions": every script, package folder, command folder and command of the project, each
// with "This project" and "Everywhere" switches. Hidden ones leave the Actions list.

export function ActionFilterDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const project = useStore((s) => s.library.projects.find((p) => p.id === projectId))
  const pkgs = useStore((s) => s.scripts[projectId]) ?? []
  const tools = useStore((s) => s.tools[projectId]) ?? []
  const rules = useHiddenRules(projectId)
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const match = (...s: string[]): boolean => !ql || s.some((x) => x.toLowerCase().includes(ql))

  /** One row: a label, and its two switches (each key may differ per scope). */
  const Row = ({ label, sub, keys, depth }: { label: string; sub?: string; keys: Record<HideScope, string>; depth: number }) => {
    const by = (scope: HideScope): boolean => (scope === 'everywhere' ? rules.everywhere : rules.project).has(keys[scope])
    return (
      <div className={`filter-row depth-${depth}`}>
        <span className="grow ellipsis">
          {label}
          {sub && <span className="muted"> {sub}</span>}
        </span>
        {(['project', 'everywhere'] as HideScope[]).map((scope) => (
          <label key={scope} className="filter-check" title={scope === 'project' ? `Hide in ${project?.name ?? 'this project'}` : `Hide in every project (${keys.everywhere.replace(/^\w+:/, '')})`}>
            <input type="checkbox" checked={by(scope)} onChange={(e) => void setHidden(projectId, keys[scope], scope, e.target.checked)} />
          </label>
        ))}
      </div>
    )
  }

  const toolRows = (t: (typeof tools)[number]) => {
    const actions = t.actions.filter((a) => match(a.name, a.title, t.title))
    if (!actions.length && !match(t.title)) return null
    return (
      <div key={t.id}>
        <Row label={t.title} sub={t.rel ? `· ${t.rel}` : 'commands'} keys={{ project: toolKey(t.kind), everywhere: toolKey(t.kind) }} depth={0} />
        {actions.map((a) => (
          <Row key={a.id} label={a.name} sub={a.title !== a.name ? a.title : undefined} keys={{ project: actionKey(a.id), everywhere: actionKey(a.id) }} depth={1} />
        ))}
      </div>
    )
  }

  const hiddenCount = rules.project.size + rules.everywhere.size
  return (
    <Modal title="Hide actions" icon="filter" onClose={onClose} wide>
      <div className="modal-body action-filter">
        <div className="row" style={{ gap: 8 }}>
          <input className="input grow" autoFocus placeholder="Search scripts and commands…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="muted" style={{ fontSize: 12 }}>
            {hiddenCount} rule{hiddenCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          Ticked items leave the Actions list. <b>This project</b> applies to {project?.name ?? 'this project'} only; <b>Everywhere</b> to every project (a script everywhere means every script of that name).
        </div>
        <div className="filter-head">
          <span className="grow" />
          <span className="filter-check">This project</span>
          <span className="filter-check">Everywhere</span>
        </div>
        <div className="filter-list">
          {/* In the list's order: .mono, the scripts, then the package manager's commands. */}
          {tools.filter((t) => t.kind === 'mono').map(toolRows)}
          {pkgs.map((p) => {
            const names = Object.keys(p.scripts).filter((n) => match(n, p.rel, p.name, p.mono?.alias ?? ''))
            if (!names.length) return null
            return (
              <div key={p.dir}>
                <Row label={p.mono?.alias ?? (p.rel || 'root')} sub={p.mono?.alias ? `· ${p.rel}` : `· ${p.name}`} keys={{ project: folderKey(p.rel), everywhere: folderKey(p.rel) }} depth={0} />
                {names.map((n) => (
                  <Row key={n} label={n} keys={{ project: packageScriptKey(p.rel, n), everywhere: scriptKey(n) }} depth={1} />
                ))}
              </div>
            )
          })}
          {tools.filter((t) => t.kind !== 'mono').map(toolRows)}
          {!pkgs.length && !tools.length && (
            <div className="empty-note">
              <Icon name="refresh" size={12} /> Open the Actions view to scan this project first.
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
