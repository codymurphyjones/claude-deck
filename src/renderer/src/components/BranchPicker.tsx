import { useEffect, useMemo, useState } from 'react'
import { refNameError } from '@shared/repo'
import { api, errMsg } from '../api'
import { startableBranches } from '../branchActions'
import { attempt } from '../store'
import { Icon } from './Icon'
import { Modal } from './ui'

// "Branches +" on the Chats page: make a branch active by checking it out in Claude Deck's data
// folder. Searches local branches and origin's (fetched on open, so new remote branches show up);
// picking a remote one pulls it down as a local branch tracking it. A name that matches nothing can
// be created off the folder's branch.

export function BranchPicker({ root, onClose }: { root: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<{ current?: string; local: string[]; remote: string[] } | null>(null)
  const [fetching, setFetching] = useState(true)
  const [fetchError, setFetchError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    const load = (): Promise<void> => startableBranches(root).then((b) => void (live && setList(b)))
    void load()
    // Bring origin's branch list up to date, then show it (when there's a remote at all).
    void api.git
      .info(root)
      .then((g) => (g.hasRemote ? api.repo.fetch(root).then(load) : undefined))
      .catch((e) => live && setFetchError(errMsg(e)))
      .finally(() => live && setFetching(false))
    return () => {
      live = false
    }
  }, [root])

  const ql = q.trim().toLowerCase()
  const match = (b: string): boolean => !ql || b.toLowerCase().includes(ql)
  const local = useMemo(() => (list?.local ?? []).filter(match), [list, ql])
  const remote = useMemo(() => (list?.remote ?? []).filter(match), [list, ql])
  const exact = !!list && [...list.local, ...list.remote.map((r) => r.slice(r.indexOf('/') + 1)), list.current].includes(q.trim())
  const newName = q.trim() && !exact ? q.trim() : ''

  const activate = async (branch: string, from?: string): Promise<void> => {
    setBusy(true)
    const label = from ? branch : branch.includes('/') && list?.remote.includes(branch) ? branch.slice(branch.indexOf('/') + 1) : branch
    const ok = await attempt(() => api.worktree.checkoutBranch(root, branch, from ? { from } : undefined), `${label} is now active in Claude Deck`)
    setBusy(false)
    if (ok) onClose()
  }
  const createNew = (): void => {
    const bad = refNameError(newName)
    if (bad) return setFetchError(bad)
    void activate(newName, list?.current ?? 'HEAD')
  }

  return (
    <Modal title="Make a branch active" icon="branch" onClose={onClose}>
      <div className="modal-body branch-picker">
        <input
          className="input"
          autoFocus
          placeholder="Search local and origin branches, or type a new branch name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || busy) return
            const first = local[0] ?? remote[0]
            if (first) void activate(first)
            else if (newName) createNew()
          }}
        />
        <div className="muted" style={{ fontSize: 11.5 }}>
          Checked out in Claude Deck’s data folder, next to your folder’s branch{list?.current ? ` (${list.current})` : ''}, so chats can work toward it.
          {fetching ? ' Fetching origin…' : fetchError ? ` ${fetchError}` : ''}
        </div>
        <div className="branch-picker-list">
          {newName && (
            <button className="list-item" disabled={busy} onClick={createNew}>
              <Icon name="plus" size={13} />
              <span className="grow ellipsis">
                New branch <b className="mono">{newName}</b> off {list?.current ?? 'HEAD'}
              </span>
            </button>
          )}
          {local.length > 0 && <div className="section-label">Local</div>}
          {local.slice(0, 100).map((b) => (
            <button key={b} className="list-item" disabled={busy} onClick={() => void activate(b)}>
              <Icon name="branch" size={13} />
              <span className="grow ellipsis mono">{b}</span>
            </button>
          ))}
          {remote.length > 0 && <div className="section-label">On origin (pulled down when picked)</div>}
          {remote.slice(0, 100).map((b) => (
            <button key={b} className="list-item" disabled={busy} onClick={() => void activate(b)}>
              <Icon name="globe" size={13} />
              <span className="grow ellipsis mono">{b}</span>
            </button>
          ))}
          {list && !local.length && !remote.length && !newName && <div className="empty-note">{fetching ? 'Looking on origin…' : 'No other branches.'}</div>}
          {!list && <div className="empty-note">Loading branches…</div>}
        </div>
      </div>
    </Modal>
  )
}
