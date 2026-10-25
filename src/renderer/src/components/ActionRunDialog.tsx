import { useEffect, useMemo, useState } from 'react'
import { buildCommand, defaultValues, validateValues, type ActionDef, type ActionInput, type ActionValues, type ToolSet } from '@shared/actions'
import { api } from '../api'
import { attempt, openProcessTab, set, useStore } from '../store'
import { Icon } from './Icon'
import { Modal, Seg } from './ui'

// The run form of an action (a .mono command, a package-manager command): every input of its
// definition as a control, the exact command it will run, and for .mono its environments and steps.

const storeKey = (projectId: string, toolset: string, actionId: string): string => `deck.actionValues:${projectId}:${toolset}:${actionId}`

/** The values an action last ran with in this project, else its defaults. */
export function lastValues(projectId: string, toolset: string, def: ActionDef): ActionValues {
  try {
    const saved = JSON.parse(localStorage.getItem(storeKey(projectId, toolset, def.id)) ?? 'null') as ActionValues | null
    if (saved && !validateValues(def, saved)) return { ...defaultValues(def), ...saved }
  } catch {
    /* unreadable: defaults */
  }
  return defaultValues(def)
}

/** Run an action with `values`, remembering them for next time; its output opens in a tab. */
export async function runAction(projectId: string, set_: ToolSet, def: ActionDef, values: ActionValues): Promise<void> {
  localStorage.setItem(storeKey(projectId, set_.id, def.id), JSON.stringify(values))
  const p = await attempt(() => api.processes.runAction(projectId, set_.id, def.id, values), `Started ${set_.kind === 'mono' ? 'mono' : def.base[0]} ${def.name}`)
  if (p) openProcessTab(p.id)
}

export function openActionForm(projectId: string, toolset: string, actionId: string): void {
  set({ actionRun: { projectId, toolset, actionId } })
}

export function ActionRunDialog() {
  const req = useStore((s) => s.actionRun)
  const toolset = useStore((s) => (req ? s.tools[req.projectId]?.find((t) => t.id === req.toolset) : undefined))
  const def = toolset?.actions.find((a) => a.id === req?.actionId)
  if (!req || !toolset || !def) return null
  return <Form key={`${req.projectId}:${def.id}`} projectId={req.projectId} toolset={toolset} def={def} />
}

function Form({ projectId, toolset, def }: { projectId: string; toolset: ToolSet; def: ActionDef }) {
  const [values, setValues] = useState<ActionValues>(() => lastValues(projectId, toolset.id, def))
  const [showSteps, setShowSteps] = useState(false)
  const [showEnv, setShowEnv] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const close = (): void => set({ actionRun: undefined })
  const put = (k: string, v: string | boolean): void => setValues((x) => ({ ...x, [k]: v }))
  useEffect(() => setConfirming(false), [values])

  const invalid = validateValues(def, values)
  const command = useMemo(() => {
    try {
      return { text: buildCommand(def, values) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [def, values])
  const prod = !!(def.env && values[def.env.prodKey])
  const envVars = def.env ? Object.entries(prod ? def.env.prod : def.env.dev) : []
  const inputs = def.inputs.filter((i) => i.key !== def.env?.prodKey)

  const run = async (): Promise<void> => {
    if (invalid || !command.text) return
    if (def.danger && !confirming) return setConfirming(true)
    close()
    await runAction(projectId, toolset, def, values)
  }

  return (
    <Modal
      title={def.title}
      icon={toolset.kind === 'mono' ? 'layers' : 'zap'}
      onClose={close}
      wide
      footer={
        <>
          <button className="btn" disabled={!command.text} onClick={() => command.text && void attempt(() => api.clipboard.writeText(command.text!), 'Command copied')} title="Copy the command">
            <Icon name="copy" size={13} /> Copy command
          </button>
          <span className="grow" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className={`btn ${def.danger ? 'danger' : 'primary'}`} disabled={!!invalid || !command.text} onClick={() => void run()}>
            <Icon name="play" size={12} /> {confirming ? 'Run it — are you sure?' : 'Run'}
          </button>
        </>
      }
    >
      <div className="modal-body action-form">
        {def.description && <div className="muted">{def.description}</div>}
        <div className="action-command" data-testid="action-command">
          <span className="muted">{toolset.rel || 'root'} $</span> <span className="mono selectable">{command.text ?? ''}</span>
          {(invalid || command.error) && <div className="action-error">{invalid ?? command.error}</div>}
        </div>

        {inputs.length > 0 && (
          <div className="action-inputs">
            {inputs.map((i) => (
              <InputRow key={i.key} input={i} value={values[i.key]} onChange={(v) => put(i.key, v)} toolset={toolset} values={values} />
            ))}
          </div>
        )}
        {def.extraArgs && (
          <label className="field">
            Extra arguments <span className="muted">{def.extraArgs === 'dashdash' ? '(passed after --, to the script)' : '(appended as typed)'}</span>
            <input className="input mono" value={String(values.__extra ?? '')} placeholder="--watch --verbose" onChange={(e) => put('__extra', e.target.value)} />
          </label>
        )}

        {def.env && (
          <div className="action-section">
            <div className="row" style={{ gap: 8 }}>
              <span className="action-label">Environment</span>
              <Seg
                value={prod ? 'prod' : 'dev'}
                onChange={(v) => put(def.env!.prodKey, v === 'prod')}
                options={[
                  ['dev', 'Development'],
                  ['prod', `Production (${def.inputs.find((i) => i.key === def.env!.prodKey)?.cli.flag ?? '--prod'})`]
                ]}
              />
              <span className="grow" />
              <button className="btn sm ghost" onClick={() => setShowEnv((v) => !v)}>
                <Icon name={showEnv ? 'chevron-down' : 'chevron-right'} size={11} /> {envVars.length} variable{envVars.length === 1 ? '' : 's'}
              </button>
            </div>
            {showEnv && envVars.length > 0 && (
              <div className="action-env">
                {envVars.map(([k, v]) => (
                  <div key={k} className="mono">
                    <b>{k}</b>=<span className="muted">{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {!def.env && def.inputs.some((i) => i.key === '__prod') && (
          <FlagRow input={def.inputs.find((i) => i.key === '__prod')!} value={!!values.__prod} onChange={(v) => put('__prod', v)} />
        )}

        {def.steps && (def.steps.pre.length > 0 || def.steps.main.length > 0) && (
          <div className="action-section">
            <button className="btn sm ghost" onClick={() => setShowSteps((v) => !v)}>
              <Icon name={showSteps ? 'chevron-down' : 'chevron-right'} size={11} /> What it runs ({def.steps.pre.length + def.steps.main.length} step{def.steps.pre.length + def.steps.main.length === 1 ? '' : 's'})
            </button>
            {showSteps && (
              <ol className="action-steps">
                {def.steps.pre.map((s, i) => (
                  <li key={`p${i}`} className="mono">
                    <span className="badge">before</span> {s}
                  </li>
                ))}
                {def.steps.main.map((s, i) => (
                  <li key={`m${i}`} className="mono">
                    <span className="badge accent">{i === def.steps!.main.length - 1 ? 'runs' : 'background'}</span> {s}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {toolset.notes?.map((n) => (
          <div key={n} className="banner warn">
            {n}
          </div>
        ))}
        {confirming && <div className="banner warn">This is a destructive command. Press Run again to go ahead.</div>}
      </div>
    </Modal>
  )
}

function FlagRow({ input: i, value, onChange }: { input: ActionInput; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="action-flag" title={i.description}>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span>{i.label}</span>
      <span className="mono muted">
        {i.cli.flag}
        {i.short ? ` (${i.short})` : ''}
      </span>
      {i.description && <span className="muted action-desc">{i.description}</span>}
    </label>
  )
}

/** One input as the control that fits it: checkbox, segmented choice, dropdown, or text with suggestions. */
function InputRow({ input: i, value, onChange, toolset, values }: { input: ActionInput; value: string | boolean | undefined; onChange: (v: string | boolean) => void; toolset: ToolSet; values: ActionValues }) {
  if (i.kind === 'flag') return <FlagRow input={i} value={!!value} onChange={onChange} />
  const where = i.cli.positional ? 'argument' : i.cli.asFlag ? '--<value>' : i.cli.before ? i.cli.before.join(' ') : `${i.cli.flag ?? ''}${i.short ? ` (${i.short})` : ''}`
  const label = (
    <span className="action-label">
      {i.label}
      {i.required && <span className="action-req"> *</span>} <span className="mono muted">{where}</span>
    </span>
  )
  const v = value === undefined ? '' : String(value)
  if (i.kind === 'choice' && i.choices) {
    const short = i.choices.length <= 4 && i.choices.every((c) => c.length <= 14) && (i.required || i.default !== undefined)
    return (
      <div className="action-row" title={i.description}>
        {label}
        {short ? (
          <Seg value={v} onChange={onChange} options={i.choices.map((c) => [c, c === i.default ? `${c} (default)` : c] as [string, string])} />
        ) : (
          <select className="select" value={v} onChange={(e) => onChange(e.target.value)}>
            {!i.required && <option value="">{i.default !== undefined ? '' : '—'}</option>}
            {i.choices.map((c) => (
              <option key={c} value={c}>
                {c}
                {c === i.default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        )}
        {i.description && <span className="muted action-desc">{i.description}</span>}
      </div>
    )
  }
  // Text, with suggestions from the project (workspaces, scripts, dependencies).
  const workspace = String(values.workspace ?? values.filter ?? '')
  const suggestions =
    i.suggest === 'workspaces'
      ? toolset.context.workspaces.map((w) => w.name)
      : i.suggest === 'scripts'
        ? (toolset.context.workspaces.find((w) => w.name === workspace)?.scripts ?? toolset.context.scripts)
        : i.suggest === 'dependencies'
          ? toolset.context.dependencies
          : []
  const listId = suggestions.length ? `sugg-${i.key}` : undefined
  return (
    <div className="action-row" title={i.description}>
      {label}
      <input className="input mono" value={v} list={listId} placeholder={i.placeholder ?? (i.default !== undefined ? `${i.default} (default)` : '')} onChange={(e) => onChange(e.target.value)} />
      {listId && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {i.description && <span className="muted action-desc">{i.description}</span>}
    </div>
  )
}
