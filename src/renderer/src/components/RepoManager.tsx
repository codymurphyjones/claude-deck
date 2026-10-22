import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { refNameError, type BranchInfo, type CurrentPr, type RemoteInfo, type RepoStatus, type StashInfo, type TagInfo } from '@shared/repo'
import type { CommitInfo, DiffFile } from '@shared/types'
import { api, bridge, errMsg } from '../api'
import { activeSession, askText, attempt, openSession, set, toast, useStore, type RepoDiffSource } from '../store'
import { Icon } from './Icon'
import { useRoots } from './Jobs'
import { DiffList } from './ReviewPane'
import { Modal, openMenu, openMenuAt, shortPath, Switch, useExclusive } from './ui'

// Repo manager: stage and commit, branches, history, stashes, tags, remotes and the
// current branch's pull request, for any project folder (not tied to a chat).

const STATUS_CHAR: Record<DiffFile['status'], [string, string]> = {
  modified: ['M', 'var(--warning)'],
  added: ['A', 'var(--success)'],
  deleted: ['D', 'var(--danger)'],
  renamed: ['R', 'var(--accent)'],
  untracked: ['U', 'var(--success)']
}

const filePath = (f: DiffFile): string => f.newPath || f.oldPath
const baseName = (p: string): string => p.split(/[\\/]/).pop() ?? p
const dirName = (p: string): string => p.split(/[\\/]/).slice(0, -1).join('/')

async function confirm(title: string, detail: string, ok: string): Promise<boolean> {
  return (await api.dialog.confirm(title, detail, [ok, 'Cancel'])) === 0
}

/** Ask for a ref name, re-prompting until it looks valid. */
async function askRefName(title: string, value = ''): Promise<string | null> {
  for (;;) {
    const n = await askText(title, value)
    if (n === null) return null
    const err = refNameError(n)
    if (!err) return n.trim()
    toast(err, 'error')
    value = n
  }
}

interface RepoData {
  status?: RepoStatus
  branches: BranchInfo[]
  commits: CommitInfo[]
  stashes: StashInfo[]
  tags: TagInfo[]
  remotes: RemoteInfo[]
  pr?: CurrentPr | null
}

/** A diff-viewer request without the repo (filled in by the view). */
type DiffRequest = RepoDiffSource extends infer T ? (T extends unknown ? Omit<T, 'cwd'> : never) : never

const EMPTY: RepoData = { branches: [], commits: [], stashes: [], tags: [], remotes: [] }

function useRepo(root?: string) {
  const [data, setData] = useState<RepoData>(EMPTY)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [limit, setLimit] = useState(40)
  const req = useRef(0)

  const load = useCallback(async () => {
    if (!root) return
    const n = ++req.current
    setLoading(true)
    try {
      const status = await api.repo.status(root)
      if (n !== req.current) return
      if (!status.info.isRepo) {
        setData({ ...EMPTY, status })
        return
      }
      const [branches, commits, stashes, tags, remotes] = await Promise.all([
        api.repo.branches(root),
        api.repo.log(root, { limit }).catch(() => []),
        api.repo.stashes(root),
        api.repo.tags(root),
        api.repo.remotes(root)
      ])
      if (n !== req.current) return
      setData((d) => ({ ...d, status, branches, commits, stashes, tags, remotes }))
      setError('')
      // The PR lookup goes over the network; fill it in when it arrives.
      if (status.info.ghAvailable && status.info.hasRemote && status.info.branch)
        void api.repo.currentPr(root).then((pr) => n === req.current && setData((d) => ({ ...d, pr })), () => undefined)
      else setData((d) => ({ ...d, pr: null }))
    } catch (e) {
      if (n === req.current) setError(errMsg(e))
    } finally {
      if (n === req.current) setLoading(false)
    }
  }, [root, limit])

  useEffect(() => {
    setData(EMPTY)
    void load()
  }, [load])

  // Refresh when Claude edits files and when the window regains focus.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(), 800)
    }
    const off = bridge.on('session:fileTouched', later)
    window.addEventListener('focus', later)
    return () => {
      off()
      window.removeEventListener('focus', later)
      if (t) clearTimeout(t)
    }
  }, [load])

  return { data, error, loading, load, more: () => setLimit((l) => l + 40) }
}

function Section({ title, count, open, onToggle, actions, children }: { title: string; count?: number; open: boolean; onToggle: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="section-label repo-section" onClick={onToggle}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className="grow">
          {title}
          {count !== undefined && <span className="muted"> {count}</span>}
        </span>
        {actions && (
          <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </div>
      {open && children}
    </>
  )
}

// ------------------------------------------------------------------ sidebar view
export function RepoView() {
  const roots = useRoots()
  const home = useStore((s) => s.homedir)
  const stored = useStore((s) => s.repoRoot)
  const root = stored && roots.includes(stored) ? stored : (activeSession()?.root ?? roots[0])
  const { data, error, loading, load, more } = useRepo(root)
  const [open, setOpen] = useState<Record<string, boolean>>({ conflicts: true, staged: true, changes: true, branches: true, commits: true })
  const [busy, setBusy] = useState('')
  const [staging, exclusive] = useExclusive()
  const [msg, setMsg] = useState('')
  const [amend, setAmend] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [showRemote, setShowRemote] = useState(false)
  const toggle = (k: string) => () => setOpen((o) => ({ ...o, [k]: !o[k] }))

  const st = data.status
  const gi = st?.info

  /** Run a git action with a busy label, toast its result, then refresh. */
  const run = async <T,>(label: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(label)
    const r = await attempt(fn, ok)
    setBusy('')
    await load()
    return r
  }
  const diff = (src: DiffRequest): void => set({ repoDiff: { ...src, cwd: root! } as RepoDiffSource })

  if (!root)
    return (
      <>
        <div className="sidebar-head">
          <span className="title">Repository</span>
        </div>
        <div className="sidebar-body">
          <div className="empty-note">Open a project to manage its repository.</div>
        </div>
      </>
    )

  const staged = st?.staged ?? []
  const unstaged = st?.unstaged ?? []
  const local = data.branches.filter((b) => !b.remote)
  const remote = data.branches.filter((b) => b.remote)
  const match = (b: BranchInfo): boolean => !branchFilter || b.name.toLowerCase().includes(branchFilter.toLowerCase())
  const origin = data.remotes.find((r) => r.name === 'origin') ?? data.remotes[0]

  const commit = async (push: boolean): Promise<void> => {
    if (!msg.trim()) return toast('Write a commit message first', 'error')
    if (!staged.length && !unstaged.length && !amend) return toast('Nothing to commit', 'error')
    const ok = await run('commit', () => api.git.commit(root, msg, { all: !staged.length, amend }), amend ? 'Commit amended' : 'Committed')
    if (ok === undefined) return
    setMsg('')
    setAmend(false)
    if (push) await run('push', () => api.repo.push(root, { force: amend }), 'Pushed')
  }

  const createPr = async (): Promise<void> => {
    if (gi?.branch && gi.branch === gi.defaultBranch) {
      const name = await askRefName('You are on the default branch. Create a branch for this PR:', `feature/${Date.now().toString(36)}`)
      if (!name || (await run('branch', () => api.repo.createBranch(root, name))) === undefined) return
    }
    if ((await run('push', () => api.repo.push(root))) === undefined) return
    const url = await run('pr', () => api.git.createPr(root, {}), 'Pull request created')
    if (url) void api.shell.openExternal(url)
  }

  const branchMenu = (e: React.MouseEvent, b: BranchInfo): void => {
    const cur = gi?.branch
    openMenu(
      e,
      b.remote
        ? [
            { label: 'Check out as local branch', icon: 'branch', onClick: () => run('checkout', () => api.repo.checkout(root, b.name, true), `Switched to ${b.name.slice(b.name.indexOf('/') + 1)}`) },
            { label: 'New branch from here…', icon: 'plus', onClick: () => void newBranch(b.name) },
            ...(cur ? [{ label: `Merge into ${cur}`, icon: 'fork', onClick: () => void mergeInto(b.name) }, { label: `Rebase ${cur} onto this`, icon: 'refresh', onClick: () => void rebaseOnto(b.name) }] : []),
            { label: `Compare ${cur ?? 'HEAD'} with this`, icon: 'eye', onClick: () => diff({ kind: 'compare', base: b.name, title: `${cur ?? 'HEAD'} vs ${b.name}` }) },
            { separator: true },
            { label: 'Delete remote branch', icon: 'trash', danger: true, onClick: () => void deleteBranch(b) }
          ]
        : [
            { label: 'Check out', icon: 'branch', disabled: b.current, onClick: () => run('checkout', () => api.repo.checkout(root, b.name), `Switched to ${b.name}`) },
            { label: 'New branch from here…', icon: 'plus', onClick: () => void newBranch(b.name) },
            ...(cur && !b.current
              ? [
                  { label: `Merge into ${cur}`, icon: 'fork', onClick: () => void mergeInto(b.name) },
                  { label: `Rebase ${cur} onto this`, icon: 'refresh', onClick: () => void rebaseOnto(b.name) },
                  { label: `Compare ${cur} with this`, icon: 'eye', onClick: () => diff({ kind: 'compare', base: b.name, title: `${cur} vs ${b.name}` }) }
                ]
              : []),
            ...(b.current && gi?.hasRemote ? [{ label: b.upstream ? 'Push' : 'Publish branch', icon: 'upload', onClick: () => run('push', () => api.repo.push(root), 'Pushed') }] : []),
            { label: 'Rename…', icon: 'edit', onClick: () => void renameBranch(b) },
            { label: 'Copy name', icon: 'copy', onClick: () => api.clipboard.writeText(b.name) },
            { separator: true },
            { label: 'Delete', icon: 'trash', danger: true, disabled: b.current, onClick: () => void deleteBranch(b) }
          ]
    )
  }

  const newBranch = async (from?: string): Promise<void> => {
    const name = await askRefName(from ? `New branch from ${from}` : `New branch from ${gi?.branch ?? 'HEAD'}`)
    if (name) await run('branch', () => api.repo.createBranch(root, name, { from }), `Switched to new branch ${name}`)
  }
  const mergeInto = async (name: string): Promise<void> => {
    await run('merge', () => api.repo.merge(root, name), `Merged ${name}`)
  }
  const rebaseOnto = async (name: string): Promise<void> => {
    if (await confirm(`Rebase ${gi?.branch} onto ${name}?`, 'Your commits are replayed on top of it. Uncommitted changes are stashed and restored.', 'Rebase'))
      await run('rebase', () => api.repo.rebase(root, name), `Rebased onto ${name}`)
  }
  const renameBranch = async (b: BranchInfo): Promise<void> => {
    const to = await askRefName(`Rename ${b.name}`, b.name)
    if (to && to !== b.name) await run('rename', () => api.repo.renameBranch(root, b.name, to), 'Branch renamed')
  }
  const deleteBranch = async (b: BranchInfo): Promise<void> => {
    if (b.remote) {
      if (await confirm(`Delete ${b.name} on the remote?`, 'This removes the branch for everyone.', 'Delete')) await run('delete', () => api.repo.deleteBranch(root, b.name, { remote: true }), 'Remote branch deleted')
      return
    }
    if (!(await confirm(`Delete branch ${b.name}?`, '', 'Delete'))) return
    setBusy('delete')
    try {
      await api.repo.deleteBranch(root, b.name)
      toast('Branch deleted', 'success')
    } catch (e) {
      // Not fully merged: offer a force delete.
      if (/not fully merged/i.test(errMsg(e)) && (await confirm(`${b.name} is not fully merged.`, 'Delete it anyway? Its unmerged commits will be lost.', 'Force delete')))
        await attempt(() => api.repo.deleteBranch(root, b.name, { force: true }), 'Branch deleted')
      else if (!/not fully merged/i.test(errMsg(e))) toast(errMsg(e), 'error')
    }
    setBusy('')
    void load()
  }

  const commitMenu = (e: React.MouseEvent, c: CommitInfo): void =>
    openMenu(e, [
      { label: 'View changes', icon: 'eye', onClick: () => diff({ kind: 'commit', ref: c.sha, title: `${c.short} ${c.subject}` }) },
      { label: 'Copy SHA', icon: 'copy', onClick: () => api.clipboard.writeText(c.sha) },
      { separator: true },
      { label: 'New branch from here…', icon: 'branch', onClick: () => void newBranch(c.sha) },
      { label: 'Tag this commit…', icon: 'flag', onClick: () => void newTag(c.sha) },
      { label: 'Check out (detached)', icon: 'target', onClick: () => run('checkout', () => api.repo.commitAction(root, c.sha, 'checkout'), `Checked out ${c.short}`) },
      { label: 'Cherry-pick onto current branch', icon: 'plus', onClick: () => run('pick', () => api.repo.commitAction(root, c.sha, 'cherry-pick'), 'Cherry-picked') },
      { label: 'Revert (new commit)', icon: 'undo', onClick: () => run('revert', () => api.repo.commitAction(root, c.sha, 'revert'), 'Reverted') },
      { separator: true },
      { label: 'Reset branch here (keep changes staged)', icon: 'undo', onClick: () => void reset(c, 'reset-soft') },
      { label: 'Reset branch here (keep changes)', icon: 'undo', onClick: () => void reset(c, 'reset-mixed') },
      { label: 'Reset branch here (discard changes)', icon: 'trash', danger: true, onClick: () => void reset(c, 'reset-hard') }
    ])
  const reset = async (c: CommitInfo, mode: 'reset-soft' | 'reset-mixed' | 'reset-hard'): Promise<void> => {
    const hard = mode === 'reset-hard'
    if (await confirm(`Reset ${gi?.branch ?? 'HEAD'} to ${c.short}?`, hard ? 'Commits after it and ALL uncommitted changes are discarded. This cannot be undone.' : 'Commits after it are undone; their changes stay in your working tree.', hard ? 'Discard and reset' : 'Reset'))
      await run('reset', () => api.repo.commitAction(root, c.sha, mode), `Reset to ${c.short}`)
  }

  const newTag = async (ref?: string): Promise<void> => {
    const name = await askRefName(ref ? `Tag ${ref.slice(0, 7)}` : `Tag ${gi?.branch ?? 'HEAD'}`, 'v')
    if (!name) return
    const message = await askText('Tag message (optional; makes an annotated tag)', '')
    if (message === null) return
    await run('tag', () => api.repo.createTag(root, name, { ref, message }), `Tagged ${name}`)
  }
  const tagMenu = (e: React.MouseEvent, t: TagInfo): void =>
    openMenu(e, [
      { label: 'View changes', icon: 'eye', onClick: () => diff({ kind: 'commit', ref: t.name, title: t.name }) },
      { label: 'Push tag', icon: 'upload', disabled: !origin, onClick: () => run('push', () => api.repo.pushTag(root, t.name, origin?.name), `Pushed ${t.name}`) },
      { label: 'Check out (detached)', icon: 'target', onClick: () => run('checkout', () => api.repo.commitAction(root, t.name, 'checkout'), `Checked out ${t.name}`) },
      { label: 'New branch from tag…', icon: 'branch', onClick: () => void newBranch(t.name) },
      { label: 'Copy name', icon: 'copy', onClick: () => api.clipboard.writeText(t.name) },
      { separator: true },
      { label: 'Delete locally', icon: 'trash', danger: true, onClick: () => run('tag', () => api.repo.deleteTag(root, t.name), 'Tag deleted') },
      ...(origin
        ? [{ label: `Delete on ${origin.name}`, icon: 'trash', danger: true, onClick: async () => (await confirm(`Delete tag ${t.name} on ${origin.name}?`, '', 'Delete')) && run('tag', () => api.repo.deleteTag(root, t.name, origin.name), 'Remote tag deleted') }]
        : [])
    ])

  const stash = async (): Promise<void> => {
    const message = await askText('Stash message (optional)', '')
    if (message !== null) await run('stash', () => api.repo.stashSave(root, message, { untracked: true }), 'Changes stashed')
  }
  const stashAct = async (s: StashInfo, action: 'apply' | 'pop' | 'drop'): Promise<void> => {
    if (action === 'drop' && !(await confirm(`Drop stash "${s.message}"?`, 'Its changes are lost.', 'Drop'))) return
    await run('stash', () => api.repo.stashAction(root, s.index, action), action === 'drop' ? 'Stash dropped' : 'Stash applied')
  }

  // One stage/unstage/discard at a time, held until the refresh shows the result.
  const fileAct = (f: DiffFile, action: 'stage' | 'unstage' | 'revert'): Promise<void> =>
    exclusive(async () => {
      if (action === 'revert' && !(await confirm(`Discard changes to ${filePath(f)}?`, f.status === 'untracked' ? 'The file is deleted.' : 'This cannot be undone.', 'Discard'))) return
      await run('file', () => api.git.applyFile(root, f, action))
    })
  const allAct = (action: 'stage' | 'unstage' | 'revert'): Promise<void> =>
    exclusive(async () => {
      if (action === 'revert' && !(await confirm('Discard ALL changes?', 'Tracked changes are reverted and untracked files deleted. This cannot be undone.', 'Discard all'))) return
      await run('all', () => api.git.applyAll(root, action))
    })

  const fileRow = (f: DiffFile, view: 'staged' | 'unstaged') => {
    const p = filePath(f)
    const [ch, color] = STATUS_CHAR[f.status]
    return (
      <div
        key={view + p}
        className="list-item repo-file"
        title={p}
        onClick={() => diff({ kind: 'working', view, path: p, title: p })}
        onContextMenu={(e) =>
          openMenu(e, [
            { label: 'View diff', icon: 'eye', onClick: () => diff({ kind: 'working', view, path: p, title: p }) },
            { label: 'Open in editor', icon: 'code', onClick: () => api.shell.openInEditor(`${root}/${p}`) },
            view === 'unstaged' ? { label: 'Stage', icon: 'plus', onClick: () => void fileAct(f, 'stage') } : { label: 'Unstage', icon: 'minus', onClick: () => void fileAct(f, 'unstage') },
            ...(view === 'unstaged' ? [{ separator: true }, { label: 'Discard changes', icon: 'undo', danger: true, onClick: () => void fileAct(f, 'revert') }] : [])
          ])
        }
      >
        <b className="repo-status" style={{ color }}>
          {ch}
        </b>
        <span className="ellipsis grow">
          {baseName(p)} <span className="muted">{dirName(p)}</span>
        </span>
        <span className="actions">
          <button className="icon-btn sm" title="Open in editor" onClick={(e) => (e.stopPropagation(), void api.shell.openInEditor(`${root}/${p}`))}>
            <Icon name="code" size={12} />
          </button>
          {view === 'unstaged' && (
            <button className="icon-btn sm" title="Discard changes" disabled={staging} onClick={(e) => (e.stopPropagation(), void fileAct(f, 'revert'))}>
              <Icon name="undo" size={12} />
            </button>
          )}
          <button className="icon-btn sm" title={view === 'unstaged' ? 'Stage' : 'Unstage'} disabled={staging} onClick={(e) => (e.stopPropagation(), void fileAct(f, view === 'unstaged' ? 'stage' : 'unstage'))}>
            <Icon name={view === 'unstaged' ? 'plus' : 'minus'} size={12} />
          </button>
        </span>
      </div>
    )
  }

  const branchRow = (b: BranchInfo) => (
    <div
      key={b.name}
      className={`list-item ${b.current ? 'active' : ''}`}
      style={{ alignItems: 'flex-start' }}
      onDoubleClick={() => !b.current && run('checkout', () => api.repo.checkout(root, b.name, b.remote), `Switched to ${b.name}`)}
      onClick={(e) => branchMenu(e, b)}
      onContextMenu={(e) => branchMenu(e, b)}
      title="Click for actions · double-click to check out"
    >
      <Icon name={b.current ? 'check' : b.remote ? 'cloud' : 'branch'} size={13} style={{ marginTop: 2, color: b.current ? 'var(--accent)' : 'var(--muted)' }} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis" style={{ fontWeight: b.current ? 650 : 500 }}>
          {b.name}
          {b.ahead > 0 && <span className="muted"> ↑{b.ahead}</span>}
          {b.behind > 0 && <span className="muted"> ↓{b.behind}</span>}
          {b.gone && <span className="badge warn" style={{ marginLeft: 6 }}>gone</span>}
        </div>
        <div className="sub ellipsis">
          {b.date} · {b.subject}
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Repository</span>
        {loading && <span className="dot working" title="Refreshing" />}
        <button className="icon-btn sm" title="Fetch all remotes" disabled={!!busy || !gi?.hasRemote} onClick={() => run('fetch', () => api.repo.fetch(root), 'Fetched')}>
          <Icon name="download" size={14} />
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={() => void load()}>
          <Icon name="refresh" size={14} />
        </button>
        <button
          className="icon-btn sm"
          title="More"
          onClick={(e) =>
            openMenu(e, [
              { label: 'Pull (rebase)', icon: 'download', disabled: !gi?.upstream, onClick: () => run('pull', () => api.repo.pull(root, 'rebase'), 'Pulled') },
              { label: 'Pull (merge)', icon: 'download', disabled: !gi?.upstream, onClick: () => run('pull', () => api.repo.pull(root, 'merge'), 'Pulled') },
              { label: 'Push', icon: 'upload', disabled: !gi?.hasRemote, onClick: () => run('push', () => api.repo.push(root), 'Pushed') },
              {
                label: 'Force push (with lease)',
                icon: 'upload',
                danger: true,
                disabled: !gi?.hasRemote,
                onClick: async () => (await confirm(`Force push ${gi?.branch}?`, 'Overwrites the remote branch (refused if someone else pushed since your last fetch).', 'Force push')) && run('push', () => api.repo.push(root, { force: true }), 'Pushed')
              },
              { label: 'Push all tags', icon: 'flag', disabled: !gi?.hasRemote, onClick: () => run('push', () => api.repo.push(root, { tags: true }), 'Tags pushed') },
              { separator: true },
              { label: 'New branch…', icon: 'branch', onClick: () => void newBranch() },
              { label: 'Stash changes…', icon: 'archive', onClick: () => void stash() },
              { label: 'New tag…', icon: 'flag', onClick: () => void newTag() },
              { separator: true },
              ...(origin?.webUrl ? [{ label: 'Open on the web', icon: 'globe', onClick: () => api.shell.openExternal(origin.webUrl!) }] : []),
              { label: 'Reveal in Explorer', icon: 'folder-open', onClick: () => api.shell.openPath(root) },
              { label: 'New chat here', icon: 'message', onClick: () => openSession('claude', { cwd: root }) }
            ])
          }
        >
          <Icon name="more" size={14} />
        </button>
      </div>
      <div className="sidebar-body">
        {roots.length > 1 && (
          <select className="select" style={{ width: '100%', margin: '4px 0 6px' }} value={root} onChange={(e) => set({ repoRoot: e.target.value })}>
            {roots.map((r) => (
              <option key={r} value={r}>
                {shortPath(r, home)}
              </option>
            ))}
          </select>
        )}
        {error && <div className="empty-note" style={{ color: 'var(--danger)' }}>{error}</div>}
        {gi && !gi.isRepo && (
          <div className="empty-note">
            <span className="mono">{shortPath(root, home)}</span> is not a Git repository.
            <div style={{ marginTop: 10 }}>
              <button className="btn sm primary" onClick={() => run('init', () => api.repo.init(root), 'Repository initialized')}>
                Initialize repository
              </button>
            </div>
          </div>
        )}
        {gi?.isRepo && (
          <>
            <div className="card repo-head">
              <div className="row" style={{ gap: 6 }}>
                <button
                  className="btn sm grow"
                  style={{ justifyContent: 'flex-start', minWidth: 0 }}
                  title="Switch branch"
                  onClick={(e) =>
                    openMenuAt(e.currentTarget, [
                      ...local.filter((b) => !b.current).slice(0, 15).map((b) => ({ label: b.name, icon: 'branch', hint: b.date, onClick: () => run('checkout', () => api.repo.checkout(root, b.name), `Switched to ${b.name}`) })),
                      { separator: true },
                      { label: 'New branch…', icon: 'plus', onClick: () => void newBranch() }
                    ])
                  }
                >
                  <Icon name="branch" size={12} />
                  <span className="ellipsis">{gi.branch ?? 'detached HEAD'}</span>
                  <Icon name="chevron-down" size={11} />
                </button>
                {gi.upstream ? (
                  <button className="btn sm" title={`Sync with ${gi.upstream} (pull, then push)`} disabled={!!busy} onClick={async () => (await run('pull', () => api.repo.pull(root), 'Pulled')) !== undefined && gi.ahead ? run('push', () => api.repo.push(root), 'Pushed') : undefined}>
                    <Icon name="refresh" size={12} /> {gi.behind ? `↓${gi.behind} ` : ''}
                    {gi.ahead ? `↑${gi.ahead}` : ''}
                    {!gi.ahead && !gi.behind && 'Sync'}
                  </button>
                ) : (
                  gi.hasRemote &&
                  gi.branch && (
                    <button className="btn sm" title="Push this branch and track it" disabled={!!busy} onClick={() => run('push', () => api.repo.push(root), 'Branch published')}>
                      <Icon name="upload" size={12} /> Publish
                    </button>
                  )
                )}
              </div>
              {data.pr ? (
                <div className="row repo-pr" onClick={() => api.shell.openExternal(data.pr!.url)} title="Open the pull request">
                  <Icon name="pr" size={13} style={{ color: 'var(--accent)' }} />
                  <span className="ellipsis grow">
                    #{data.pr.number} {data.pr.title}
                  </span>
                  {data.pr.isDraft && <span className="badge">draft</span>}
                  {data.pr.checks !== 'none' && <span className={`badge ${data.pr.checks === 'pass' ? 'ok' : data.pr.checks === 'fail' ? 'err' : 'warn'}`}>checks {data.pr.checks}</span>}
                  {data.pr.reviewDecision && <span className="badge">{data.pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}</span>}
                </div>
              ) : (
                gi.ghAvailable &&
                gi.hasRemote &&
                data.pr === null &&
                gi.branch && (
                  <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void createPr()}>
                    <Icon name="pr" size={12} /> {busy === 'pr' ? 'Creating…' : 'Create pull request'}
                  </button>
                )
              )}
              {st?.operation && (
                <div className="repo-op">
                  <div>
                    <b>{st.operation}</b> in progress{st.conflicted.length ? ` · ${st.conflicted.length} conflict${st.conflicted.length > 1 ? 's' : ''}` : ''}
                  </div>
                  <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    <button className="btn sm primary" disabled={!!busy || st.conflicted.length > 0} title={st.conflicted.length ? 'Resolve and mark every conflict first' : undefined} onClick={() => run('op', () => api.repo.resolveOperation(root, 'continue'), 'Continued')}>
                      Continue
                    </button>
                    <button className="btn sm danger" disabled={!!busy} onClick={async () => (await confirm(`Abort the ${st.operation}?`, 'The branch goes back to how it was before it started.', 'Abort')) && run('op', () => api.repo.resolveOperation(root, 'abort'), 'Aborted')}>
                      Abort
                    </button>
                    {st.conflicted.length > 0 && (
                      <button
                        className="btn sm"
                        onClick={() =>
                          openSession('claude', {
                            cwd: root,
                            name: 'Resolve conflicts',
                            initialPrompt: `A git ${st.operation} stopped with conflicts in:\n${st.conflicted.map((f) => `- ${f}`).join('\n')}\n\nResolve each conflict, keeping the intent of both sides; ask me if a choice is unclear. Then \`git add\` the resolved files, but do not continue or commit the ${st.operation}.`
                          })
                        }
                      >
                        <Icon name="sparkles" size={12} /> Resolve with Claude
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="col repo-commit">
              <textarea
                className="textarea"
                rows={2}
                value={msg}
                placeholder={staged.length ? `Message (commit ${staged.length} staged)` : unstaged.length ? `Message (commit all ${unstaged.length})` : 'Message'}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void commit(false)}
              />
              <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                <button className="btn sm" title="Draft a message with Claude" disabled={!!busy || (!staged.length && !unstaged.length)} onClick={async () => {
                  setBusy('gen')
                  const m = await attempt(() => api.git.generateCommitMessage(root))
                  setBusy('')
                  if (m) setMsg(m)
                }}>
                  <Icon name="wand" size={12} /> {busy === 'gen' ? 'Drafting…' : 'Draft'}
                </button>
                <label className="row" style={{ gap: 6, fontSize: 12 }} title="Replace the last commit instead of making a new one">
                  <Switch
                    on={amend}
                    onChange={async (v) => {
                      setAmend(v)
                      if (v && !msg.trim()) setMsg((await attempt(() => api.repo.lastMessage(root))) ?? '')
                    }}
                  />
                  Amend
                </label>
                <span className="grow" />
                <button className="btn sm primary" disabled={!!busy || !msg.trim()} onClick={() => void commit(false)}>
                  {busy === 'commit' ? 'Committing…' : amend ? 'Amend' : 'Commit'}
                </button>
                <button
                  className="icon-btn sm"
                  title="More commit options"
                  onClick={(e) =>
                    openMenuAt(e.currentTarget, [
                      { label: amend ? 'Amend & force push' : 'Commit & push', icon: 'upload', disabled: !gi.hasRemote || !msg.trim(), onClick: () => void commit(true) },
                      { label: 'Stage all', icon: 'plus', onClick: () => void allAct('stage') },
                      { label: 'Unstage all', icon: 'minus', onClick: () => void allAct('unstage') },
                      { label: 'Undo last commit (keep changes)', icon: 'undo', disabled: !data.commits[1], onClick: () => data.commits[1] && void reset(data.commits[1], 'reset-soft') }
                    ])
                  }
                >
                  <Icon name="chevron-down" size={12} />
                </button>
              </div>
            </div>

            {st!.conflicted.length > 0 && (
              <Section title="Conflicts" count={st!.conflicted.length} open={open.conflicts} onToggle={toggle('conflicts')}>
                {st!.conflicted.map((p) => (
                  <div key={p} className="list-item repo-file" title={p} onClick={() => api.shell.openInEditor(`${root}/${p}`)}>
                    <b className="repo-status" style={{ color: 'var(--danger)' }}>!</b>
                    <span className="ellipsis grow">
                      {baseName(p)} <span className="muted">{dirName(p)}</span>
                    </span>
                    <span className="actions" style={{ opacity: 1 }}>
                      <button className="btn sm" title="Stage the resolved file" onClick={(e) => (e.stopPropagation(), void run('resolve', () => api.repo.markResolved(root, p), 'Marked resolved'))}>
                        Resolved
                      </button>
                    </span>
                  </div>
                ))}
              </Section>
            )}

            <Section
              title="Staged"
              count={staged.length}
              open={open.staged}
              onToggle={toggle('staged')}
              actions={
                staged.length > 0 && (
                  <>
                    <button className="icon-btn sm" title="View all staged changes" onClick={() => diff({ kind: 'working', view: 'staged', title: 'Staged changes' })}>
                      <Icon name="eye" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Unstage all" disabled={staging} onClick={() => void allAct('unstage')}>
                      <Icon name="minus" size={12} />
                    </button>
                  </>
                )
              }
            >
              {!staged.length && <div className="empty-note repo-empty">Stage files to commit only part of your changes.</div>}
              {staged.map((f) => fileRow(f, 'staged'))}
            </Section>

            <Section
              title="Changes"
              count={unstaged.length}
              open={open.changes}
              onToggle={toggle('changes')}
              actions={
                unstaged.length > 0 && (
                  <>
                    <button className="icon-btn sm" title="View all changes" onClick={() => diff({ kind: 'working', view: 'unstaged', title: 'Changes' })}>
                      <Icon name="eye" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Stash changes" onClick={() => void stash()}>
                      <Icon name="archive" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Discard all" disabled={staging} onClick={() => void allAct('revert')}>
                      <Icon name="undo" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Stage all" disabled={staging} onClick={() => void allAct('stage')}>
                      <Icon name="plus" size={12} />
                    </button>
                  </>
                )
              }
            >
              {!unstaged.length && <div className="empty-note repo-empty">Working tree clean.</div>}
              {unstaged.map((f) => fileRow(f, 'unstaged'))}
            </Section>

            <Section
              title="Branches"
              count={local.length}
              open={open.branches}
              onToggle={toggle('branches')}
              actions={
                <button className="icon-btn sm" title="New branch" onClick={() => void newBranch()}>
                  <Icon name="plus" size={12} />
                </button>
              }
            >
              {data.branches.length > 8 && <input className="input repo-filter" value={branchFilter} placeholder="Filter branches" onChange={(e) => setBranchFilter(e.target.value)} />}
              {local.filter(match).map(branchRow)}
              {remote.length > 0 && (
                <div className="list-item muted" style={{ fontSize: 12 }} onClick={() => setShowRemote((v) => !v)}>
                  <Icon name={showRemote ? 'chevron-down' : 'chevron-right'} size={12} /> Remote branches ({remote.length})
                </div>
              )}
              {(showRemote || (branchFilter && remote.some(match))) && remote.filter(match).map(branchRow)}
            </Section>

            <Section title="Commits" open={open.commits} onToggle={toggle('commits')}>
              {!data.commits.length && <div className="empty-note repo-empty">No commits yet.</div>}
              {data.commits.map((c) => (
                <div key={c.sha} className="list-item" style={{ alignItems: 'flex-start' }} title={`${c.sha}\n${c.subject}`} onClick={() => diff({ kind: 'commit', ref: c.sha, title: `${c.short} ${c.subject}` })} onContextMenu={(e) => commitMenu(e, c)}>
                  <Icon name="target" size={12} style={{ marginTop: 3, color: 'var(--muted)' }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">{c.subject}</div>
                    <div className="sub ellipsis">
                      <span className="mono">{c.short}</span> · {c.author} · {c.date}
                    </div>
                    {c.refs && (
                      <div className="row" style={{ gap: 3, flexWrap: 'wrap', marginTop: 2 }}>
                        {c.refs.map((r) => (
                          <span key={r} className={`badge ${r.startsWith('tag: ') ? 'warn' : 'accent'}`}>
                            {r.replace(/^tag: /, '')}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <span className="actions">
                    <button className="icon-btn sm" title="More" onClick={(e) => (e.stopPropagation(), commitMenu(e, c))}>
                      <Icon name="more" size={12} />
                    </button>
                  </span>
                </div>
              ))}
              {data.commits.length >= 40 && data.commits.length % 40 === 0 && (
                <button className="btn sm ghost" style={{ margin: '4px 6px' }} onClick={more}>
                  Load more
                </button>
              )}
            </Section>

            <Section
              title="Stashes"
              count={data.stashes.length}
              open={!!open.stashes}
              onToggle={toggle('stashes')}
              actions={
                <button className="icon-btn sm" title="Stash changes" disabled={!staged.length && !unstaged.length} onClick={() => void stash()}>
                  <Icon name="plus" size={12} />
                </button>
              }
            >
              {!data.stashes.length && <div className="empty-note repo-empty">Stash changes to set them aside without committing.</div>}
              {data.stashes.map((s) => (
                <div key={s.ref} className="list-item" onClick={() => diff({ kind: 'stash', index: s.index, title: `${s.ref}: ${s.message}` })}>
                  <Icon name="archive" size={12} style={{ color: 'var(--muted)' }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">{s.message || s.ref}</div>
                    <div className="sub">
                      {s.ref} · {s.date}
                    </div>
                  </div>
                  <span className="actions">
                    <button className="icon-btn sm" title="Apply (keep stash)" onClick={(e) => (e.stopPropagation(), void stashAct(s, 'apply'))}>
                      <Icon name="check" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Pop (apply and drop)" onClick={(e) => (e.stopPropagation(), void stashAct(s, 'pop'))}>
                      <Icon name="upload" size={12} />
                    </button>
                    <button className="icon-btn sm" title="Drop" onClick={(e) => (e.stopPropagation(), void stashAct(s, 'drop'))}>
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                </div>
              ))}
            </Section>

            <Section
              title="Tags"
              count={data.tags.length}
              open={!!open.tags}
              onToggle={toggle('tags')}
              actions={
                <button className="icon-btn sm" title="New tag" onClick={() => void newTag()}>
                  <Icon name="plus" size={12} />
                </button>
              }
            >
              {data.tags.slice(0, 100).map((t) => (
                <div key={t.name} className="list-item" onClick={(e) => tagMenu(e, t)} onContextMenu={(e) => tagMenu(e, t)}>
                  <Icon name="flag" size={12} style={{ color: 'var(--muted)' }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">{t.name}</div>
                    <div className="sub ellipsis">
                      <span className="mono">{t.sha}</span> · {t.date}
                      {t.subject && ` · ${t.subject}`}
                    </div>
                  </div>
                </div>
              ))}
            </Section>

            <Section title="Remotes" count={data.remotes.length} open={!!open.remotes} onToggle={toggle('remotes')}>
              {!data.remotes.length && <div className="empty-note repo-empty">No remotes. Add one with <span className="mono">git remote add origin &lt;url&gt;</span>.</div>}
              {data.remotes.map((r) => (
                <div key={r.name} className="list-item" title={r.url} onClick={() => r.webUrl && api.shell.openExternal(r.webUrl)}>
                  <Icon name="cloud" size={12} style={{ color: 'var(--muted)' }} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">{r.name}</div>
                    <div className="sub ellipsis mono">{r.url}</div>
                  </div>
                  {r.webUrl && (
                    <span className="actions">
                      <Icon name="external" size={12} />
                    </span>
                  )}
                </div>
              ))}
            </Section>
          </>
        )}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ diff viewer
export function RepoDiffDialog() {
  const src = useStore((s) => s.repoDiff)
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [error, setError] = useState('')
  const [onlyPath, setOnlyPath] = useState<string | undefined>()
  const [acting, exclusive] = useExclusive()

  const load = useCallback(async () => {
    if (!src) return
    setError('')
    try {
      const f =
        src.kind === 'working'
          ? await api.git.diff(src.cwd, src.view, {})
          : src.kind === 'commit'
            ? await api.git.diff(src.cwd, 'commit', { ref: src.ref })
            : src.kind === 'stash'
              ? await api.repo.stashDiff(src.cwd, src.index)
              : await api.repo.compare(src.cwd, src.base)
      setFiles(f)
    } catch (e) {
      setError(errMsg(e))
      setFiles([])
    }
  }, [src])

  useEffect(() => {
    setFiles(null)
    setOnlyPath(src ? src.path : undefined)
    void load()
  }, [load])

  if (!src) return null
  const close = (): void => set({ repoDiff: false })
  const shown = files?.filter((f) => !onlyPath || filePath(f) === onlyPath) ?? null
  const working = src.kind === 'working'

  const act = (f: DiffFile, hunk: number | null, a: 'stage' | 'unstage' | 'revert'): Promise<void> =>
    exclusive(async () => {
      if (a === 'revert' && !(await confirm(`Discard ${hunk === null ? 'all changes in' : 'this hunk of'} ${filePath(f)}?`, 'This cannot be undone.', 'Discard'))) return
      try {
        if (hunk === null) await api.git.applyFile(src.cwd, f, a)
        else await api.git.applyHunk(src.cwd, f, hunk, a)
      } catch (e) {
        toast(errMsg(e), 'error')
      }
      await load()
    })
  const applyShown = (a: 'stage' | 'unstage'): Promise<void> =>
    exclusive(async () => {
      await Promise.all(shown!.map((f) => api.git.applyFile(src.cwd, f, a))).catch((e) => toast(errMsg(e), 'error'))
      await load()
    })
  const add = shown?.reduce((n, f) => n + f.additions, 0) ?? 0
  const del = shown?.reduce((n, f) => n + f.deletions, 0) ?? 0

  return (
    <Modal
      wide
      className="repo-diff"
      icon="eye"
      title={
        <span className="row" style={{ gap: 8, minWidth: 0 }}>
          <span className="ellipsis">{src.title}</span>
          {shown && (
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              {shown.length} file{shown.length === 1 ? '' : 's'} · <span style={{ color: 'var(--success)' }}>+{add}</span> <span style={{ color: 'var(--danger)' }}>-{del}</span>
            </span>
          )}
        </span>
      }
      onClose={close}
      footer={
        <>
          {onlyPath && files && files.length > 1 && (
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => setOnlyPath(undefined)}>
              Show all {files.length} files
            </button>
          )}
          {working && src.view === 'unstaged' && shown && shown.length > 0 && (
            <button className="btn" disabled={acting} onClick={() => void applyShown('stage')}>
              <Icon name="plus" size={13} /> Stage {onlyPath ? 'file' : 'all'}
            </button>
          )}
          {working && src.view === 'staged' && shown && shown.length > 0 && (
            <button className="btn" disabled={acting} onClick={() => void applyShown('unstage')}>
              <Icon name="minus" size={13} /> Unstage {onlyPath ? 'file' : 'all'}
            </button>
          )}
          <button className="btn primary" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="repo-diff-body">
        {error && <div className="empty-note" style={{ color: 'var(--danger)' }}>{error}</div>}
        {shown === null ? (
          <div className="empty-note">Loading diff…</div>
        ) : (
          <DiffList files={shown} view={working ? src.view : undefined} readOnly={!working} onAction={working ? act : undefined} busy={acting} root={src.cwd} />
        )}
      </div>
    </Modal>
  )
}
