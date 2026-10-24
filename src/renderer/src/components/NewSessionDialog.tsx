import { useEffect, useState } from 'react'
import { PROVIDER_IDS, PROVIDERS, type ProviderId } from '@shared/agent'
import type { GitInfo, LaunchOptions, MeshRole } from '@shared/types'
import { api } from '../api'
import { activeSession, openSession, set, useStore } from '../store'
import { Icon } from './Icon'
import { Modal, Seg, Switch } from './ui'

/** Provider picker shown wherever an agent is chosen. */
export function ProviderSeg({ value, onChange }: { value: ProviderId; onChange: (p: ProviderId) => void }) {
  return <Seg value={value} onChange={onChange} options={PROVIDER_IDS.map((p) => [p, PROVIDERS[p].label] as [ProviderId, string])} />
}

export function NewSessionDialog() {
  const pre = useStore((s) => s.newSession)
  const lib = useStore((s) => s.library)
  const templates = useStore((s) => s.settings.sessionTemplates)
  const home = useStore((s) => s.homedir)
  const defaultProvider = useStore((s) => s.settings.defaultProvider)
  const perChat = useStore((s) => s.settings.worktrees.perChat)
  const [provider, setProvider] = useState<ProviderId>(defaultProvider)
  const [cwd, setCwd] = useState('')
  const [where, setWhere] = useState<'local' | 'worktree'>('local')
  const [git, setGit] = useState<GitInfo | null>(null)
  const [branches, setBranches] = useState<string[]>([])
  const [baseRef, setBaseRef] = useState('')
  const [carry, setCarry] = useState(false)
  const [permanent, setPermanent] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [mode, setMode] = useState('')
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [role, setRole] = useState<MeshRole>('free')
  const [remote, setRemote] = useState(false)
  const [layout, setLayout] = useState<'tab' | 'split'>('tab')

  useEffect(() => {
    if (!pre) return
    const s = activeSession()
    setCwd(pre.cwd ?? s?.root ?? lib.recentFolders[0] ?? home)
    // Chats get their own worktree by default (Settings → Git & worktrees), merging back into the branch.
    setWhere(pre.worktree || perChat ? 'worktree' : 'local')
    setTemplateId(pre.templateId ?? '')
    setName('')
    setPrompt('')
    setCarry(false)
    setPermanent(false)
    setLayout('tab')
    setProvider(defaultProvider)
  }, [pre])

  useEffect(() => {
    if (!pre || !cwd) return
    let live = true
    void api.git.info(cwd).then((g) => {
      if (!live) return
      setGit(g)
      setBaseRef('')
      if (g.isRepo) {
        void api.git.branches(cwd).then((b) => live && setBranches(b))
        if (perChat || pre.worktree) setWhere('worktree')
      } else setWhere('local')
    })
    return () => {
      live = false
    }
  }, [cwd, pre])

  useEffect(() => {
    const t = templates.find((x) => x.id === templateId)
    if (!t) return
    if (t.provider) setProvider(t.provider)
    setModel(t.model ?? '')
    setEffort(t.effort ?? '')
    setMode(t.permissionMode ?? '')
    setRole(t.role ?? 'free')
    setRemote(!!t.remoteControl)
    if (t.useWorktree && git?.isRepo) setWhere('worktree')
    if (t.initialPrompt) setPrompt(t.initialPrompt)
  }, [templateId])

  if (!pre) return null
  const desc = PROVIDERS[provider]
  const pickProvider = (p: ProviderId): void => {
    if (p === provider) return
    setProvider(p)
    setModel('')
    setEffort('')
    setMode('')
  }
  const close = (): void => set({ newSession: false })
  const create = async (): Promise<void> => {
    if (!cwd) return
    const launch: LaunchOptions = {
      cwd,
      provider,
      name: name || undefined,
      model: model || undefined,
      effort: effort || undefined,
      permissionMode: mode || undefined,
      initialPrompt: prompt.trim() || undefined,
      role,
      remoteControl: (provider === 'claude' && remote) || undefined,
      templateId: templateId || undefined,
      quick: pre.quick,
      // The chat works on its own sub-branch off this branch and merges back into it.
      worktree: where === 'worktree' ? { target: baseRef || git?.branch || undefined, baseRef: !(baseRef || git?.branch) ? 'HEAD' : undefined, carryChanges: carry, permanent } : undefined,
      inPlace: where === 'local' || undefined
    }
    close()
    const s = activeSession()
    await openSession('agent', launch, layout === 'split' && s ? { mode: 'split', splitOf: s.id } : {})
  }
  return (
    <Modal
      title="New agent session"
      icon="plus"
      onClose={close}
      footer={
        <>
          <span className="muted grow" style={{ fontSize: 12 }}>
            Tip: drop a folder anywhere on the window to skip this.
          </span>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={create}>
            Start session
          </button>
        </>
      }
    >
      <div className="modal-body">
        <div className="row">
          <span className="muted">Agent</span>
          <ProviderSeg value={provider} onChange={pickProvider} />
        </div>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <label className="field grow">
            Folder
            <input className="input mono" autoFocus value={cwd} onChange={(e) => setCwd(e.target.value)} list="deck-recent" onKeyDown={(e) => e.key === 'Enter' && create()} />
            <datalist id="deck-recent">
              {[...lib.recentFolders, ...lib.projects.flatMap((p) => p.folders)].map((f, i) => (
                <option key={i} value={f} />
              ))}
            </datalist>
          </label>
          <button className="btn" onClick={async () => setCwd((await api.dialog.openFolder())[0] ?? cwd)}>
            <Icon name="folder-open" size={14} /> Browse
          </button>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <Seg
            value={where}
            onChange={(w) => git?.isRepo && setWhere(w)}
            options={[
              ['local', 'Local'],
              ['worktree', git?.isRepo === false ? 'Worktree (needs Git)' : 'Worktree']
            ]}
          />
          {git?.isRepo && (
            <span className="muted" style={{ fontSize: 12 }}>
              <Icon name="branch" size={11} /> {git.branch ?? 'detached'} {git.dirty ? `· ${git.dirty} changed` : ''}
            </span>
          )}
          <span className="grow" />
          <Seg
            value={layout}
            onChange={setLayout}
            options={[
              ['tab', 'New tab'],
              ['split', 'Split current']
            ]}
          />
        </div>
        {where === 'worktree' && (
          <div className="card col" style={{ boxShadow: 'none', padding: 12, gap: 10 }}>
            <label className="field">
              Work on branch
              <select className="select" value={baseRef} onChange={(e) => setBaseRef(e.target.value)}>
                <option value="">{git?.branch ? `${git.branch} (checked out)` : 'Current HEAD (detached)'}</option>
                {branches.map((b) => (
                  <option key={b}>{b}</option>
                ))}
              </select>
            </label>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
              The chat works in its own copy on a branch of its own, then <b>Merge into {baseRef || git?.branch || 'the branch'}</b> brings its work back.{' '}
              {!baseRef || baseRef === git?.branch ? 'This is the branch your folder has checked out, so your folder updates when you merge.' : 'Your folder isn’t on this branch, so it’s updated and pushed from Claude Deck’s copy.'}
            </div>
            <div className="row">
              <Switch on={carry} onChange={setCarry} />
              <span>Bring my uncommitted changes along</span>
            </div>
            <div className="row">
              <Switch on={permanent} onChange={setPermanent} />
              <span>Permanent worktree (never auto-deleted, can host many chats)</span>
            </div>
          </div>
        )}
        <div className="row">
          <label className="field grow">
            Template
            <select className="select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">None</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            Name
            <input className="input" value={name} placeholder={cwd.split(/[\\/]/).pop()} onChange={(e) => setName(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label className="field grow">
            Model
            <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
              {desc.models.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ width: 120 }}>
            Effort
            <select className="select" value={effort} onChange={(e) => setEffort(e.target.value)}>
              {desc.efforts.map((x) => (
                <option key={x} value={x}>
                  {x || 'Default'}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            Permissions
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
              {desc.permissionModes.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="field">
          First prompt (optional)
          <textarea className="textarea" rows={3} value={prompt} placeholder={`What should ${desc.label} do?`} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
          <label className="field" style={{ width: 200 }}>
            Team role
            <select className="select" value={role} onChange={(e) => setRole(e.target.value as MeshRole)}>
              <option value="free">Peer (awareness only)</option>
              <option value="lead">Lead</option>
              <option value="worker">Worker</option>
              <option value="driver">Driver</option>
              <option value="reviewer">Reviewer</option>
            </select>
          </label>
          {provider === 'claude' && (
            <div className="row" style={{ marginTop: 16 }}>
              <Switch on={remote} onChange={setRemote} />
              <span>Remote Control — continue from the Claude mobile app or web</span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
