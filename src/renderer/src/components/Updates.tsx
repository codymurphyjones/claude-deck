import { useEffect, useState } from 'react'
import type { ReleaseInfo, Settings, UpdateState } from '@shared/types'
import { api, errMsg } from '../api'
import { Markdown } from '../chat/Markdown'
import { attempt, set, useStore } from '../store'
import { Icon } from './Icon'
import { Seg, Switch, timeAgo } from './ui'
import { resolveTheme } from '../theme'

const STATUS_TEXT: Record<UpdateState['status'], string> = {
  idle: 'Not checked yet',
  disabled: 'Updates are off',
  checking: 'Checking for updates…',
  none: "You're up to date",
  available: 'An update is available',
  downloading: 'Downloading update…',
  ready: 'Update ready — restart to install',
  held: 'Auto-update paused (you rolled back)',
  error: 'Update check failed'
}

/** "Restart to update" banner shown in the main area. */
export function UpdateBanner() {
  const st = useStore((s) => s.updateState)
  if (!st || st.status !== 'ready') return null
  return (
    <div className="banner">
      <Icon name="download" />
      <div className="grow">
        <b>Claude Deck {st.available}</b> is ready. <span className="muted">Restart to update — your sessions resume afterwards.</span>
      </div>
      <button className="btn primary sm" onClick={() => api.update.install()}>
        Restart now
      </button>
      <button className="btn sm ghost" onClick={() => set({ updateState: { ...st, status: 'available' } })}>
        Later
      </button>
    </div>
  )
}

export function UpdatesSection({ s, update }: { s: Settings; update: (p: Partial<Settings>) => void }) {
  const st = useStore((x) => x.updateState)
  const [releases, setReleases] = useState<ReleaseInfo[] | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [showDev, setShowDev] = useState(s.updates.channel === 'latest')
  const dark = useStore((x) => resolveTheme(x.settings, x.systemDark).dark)
  const u = s.updates
  const set2 = (patch: Partial<Settings['updates']>): void => update({ updates: { ...u, ...patch } })

  useEffect(() => {
    api.update.releases().then(setReleases, (e) => setErr(errMsg(e)))
  }, [])

  const current = st?.current
  const prev = u.previousVersion ? releases?.find((r) => r.version === u.previousVersion) : undefined
  const shown = (releases ?? []).filter((r) => showDev || !r.prerelease)

  const install = async (r: ReleaseInfo): Promise<void> => {
    const older = current && r.version !== current
    const ok = await api.dialog.confirm(
      `Install Claude Deck ${r.version}?`,
      `Claude Deck will close, install ${r.version} and reopen. Running sessions stop (conversations are saved and can be resumed).${older ? '\n\nIf this is an older version, automatic updates will pause until you resume them here.' : ''}`,
      ['Install', 'Cancel']
    )
    if (ok === 0) await attempt(() => api.update.installVersion(r))
  }

  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="grow">
          <div style={{ fontSize: 15, fontWeight: 650 }}>Claude Deck {current}</div>
          <div className={st?.status === 'error' ? '' : 'muted'} style={{ color: st?.status === 'error' ? 'var(--danger)' : undefined, fontSize: 12.5, marginTop: 3 }}>
            {st ? STATUS_TEXT[st.status] : '…'}
            {st?.status === 'downloading' && st.progress !== undefined ? ` ${st.progress}%` : ''}
            {st?.available && (st.status === 'available' || st.status === 'ready') ? ` (${st.available})` : ''}
            {st?.error && st.status !== 'disabled' ? ` — ${st.error}` : ''}
            {st?.status === 'disabled' && st.error ? ` — ${st.error}` : ''}
            {st?.checkedAt ? ` · checked ${timeAgo(st.checkedAt)} ago` : ''}
          </div>
        </div>
        {st?.status === 'ready' ? (
          <button className="btn primary" onClick={() => api.update.install()}>
            Restart to update
          </button>
        ) : st?.status === 'available' ? (
          <button className="btn primary" onClick={() => api.update.download()}>
            Download {st.available}
          </button>
        ) : (
          <button className="btn" onClick={() => api.update.check()} disabled={st?.status === 'checking' || st?.status === 'disabled'}>
            <Icon name="refresh" size={13} /> Check now
          </button>
        )}
      </div>

      {u.heldVersion && (
        <div className="banner warn" style={{ borderRadius: 10, border: '1px solid var(--border)' }}>
          <Icon name="pause" />
          <div className="grow">
            Auto-update is paused because you switched to <b>{u.heldVersion}</b>. Resume when a fixed version is out.
          </div>
          <button className="btn sm primary" onClick={() => api.update.releaseHold()}>
            Resume updates
          </button>
        </div>
      )}

      <div className="setting">
        <div className="label">
          <span>Update channel</span>
          <span className="desc">Stable follows tagged releases. Latest follows every build merged to master — newest features, occasionally rough.</span>
        </div>
        <div className="control">
          <Seg
            value={u.channel}
            onChange={(channel) => {
              set2({ channel })
              setShowDev(channel === 'latest')
            }}
            options={[
              ['stable', 'Stable'],
              ['latest', 'Latest (master)']
            ]}
          />
        </div>
      </div>
      <div className="setting">
        <div className="label">
          <span>Download and install updates automatically</span>
          <span className="desc">Updates download in the background and install when you restart (or when you click “Restart now”).</span>
        </div>
        <div className="control">
          <Switch on={u.auto} onChange={(auto) => set2({ auto })} />
        </div>
      </div>

      <h3>Version manager</h3>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        Updated into something broken? Install any earlier version below — it downloads straight from GitHub Releases and installs over the current one, keeping your settings and history.
      </div>
      {prev && prev.version !== current && (
        <div className="card row" style={{ boxShadow: 'none', padding: '10px 12px' }}>
          <Icon name="undo" />
          <div className="grow">
            Roll back to the version you had before: <b>{prev.version}</b>
          </div>
          <button className="btn sm primary" onClick={() => install(prev)}>
            Roll back
          </button>
        </div>
      )}
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={showDev} onChange={(e) => setShowDev(e.target.checked)} /> Show master builds
        </label>
        <span className="grow" />
        <button className="btn sm ghost" onClick={() => api.update.releases().then(setReleases, (e) => setErr(errMsg(e)))}>
          <Icon name="refresh" size={12} /> Refresh
        </button>
      </div>
      {err && <div className="empty-note">{err}</div>}
      {!releases && !err && <div className="empty-note">Loading versions from GitHub…</div>}
      {releases && !shown.length && <div className="empty-note">No published versions yet.</div>}
      {shown.map((r) => (
        <div key={r.tag} className="card" style={{ boxShadow: 'none', padding: '10px 12px' }}>
          <div className="row">
            <Icon name={r.prerelease ? 'branch' : 'flag'} size={14} style={{ color: r.prerelease ? 'var(--muted)' : 'var(--accent)' }} />
            <b>{r.version}</b>
            {r.prerelease ? <span className="badge">master build</span> : <span className="badge accent">release</span>}
            {r.version === current && <span className="badge ok">installed</span>}
            {r.version === u.heldVersion && <span className="badge warn">pinned</span>}
            <span className="muted" style={{ fontSize: 12 }}>{new Date(r.publishedAt).toLocaleDateString()}</span>
            <span className="grow" />
            {r.notes && (
              <button className="btn sm ghost" onClick={() => setOpen(open === r.tag ? null : r.tag)}>
                {open === r.tag ? 'Hide notes' : 'Notes'}
              </button>
            )}
            <button className="icon-btn sm" title="Open on GitHub" onClick={() => api.shell.openExternal(r.url)}>
              <Icon name="external" size={13} />
            </button>
            <button className="btn sm" disabled={r.version === current} onClick={() => install(r)}>
              {current && r.version !== current ? 'Install' : 'Installed'}
            </button>
          </div>
          {open === r.tag && (
            <div style={{ marginTop: 8, fontSize: 13 }}>
              <Markdown text={r.notes} cwd="" dark={dark} />
            </div>
          )}
        </div>
      ))}
    </>
  )
}
