import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { numberHunkLines } from '@shared/diff'
import type { CommitInfo, DiffFile, DiffView, GitInfo } from '@shared/types'
import { api, bridge, errMsg, type LiveSession } from '../api'
import { askText, attempt, toast, useStore } from '../store'
import { Icon } from './Icon'
import { Seg } from './ui'

interface Comment {
  file: string
  line: number
  code: string
  text: string
}

type Action = 'stage' | 'unstage' | 'revert'

const STATUS_CHAR: Record<DiffFile['status'], [string, string]> = {
  modified: ['M', 'var(--warning)'],
  added: ['A', 'var(--success)'],
  deleted: ['D', 'var(--danger)'],
  renamed: ['R', 'var(--accent)'],
  untracked: ['U', 'var(--success)']
}

export function DiffList({
  files,
  readOnly,
  view,
  onAction,
  comments,
  onComment,
  viewed,
  onToggleViewed,
  root
}: {
  files: DiffFile[]
  readOnly?: boolean
  view?: DiffView
  onAction?: (f: DiffFile, hunk: number | null, a: Action) => void
  comments?: Comment[]
  onComment?: (c: Comment) => void
  viewed?: string[]
  onToggleViewed?: (path: string) => void
  root?: string
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState<{ file: string; line: number; code: string; text: string } | null>(null)
  if (!files.length) return <div className="empty-note">No changes.</div>
  return (
    <div>
      {files.map((f) => {
        const path = f.newPath || f.oldPath
        const isViewed = viewed?.includes(path)
        const isCollapsed = collapsed[path] ?? isViewed ?? false
        const [ch, color] = STATUS_CHAR[f.status]
        return (
          <div key={path} className="diff-file">
            <div className="diff-file-head" onClick={() => setCollapsed((c) => ({ ...c, [path]: !isCollapsed }))}>
              <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={13} style={{ color: 'var(--muted)' }} />
              <b style={{ color, width: 12, fontFamily: 'var(--code-font)', fontSize: 12 }}>{ch}</b>
              <span
                className="fname grow ellipsis"
                title={root ? `${path} — click to open in editor` : path}
                onClick={(e) => {
                  if (!root) return
                  e.stopPropagation()
                  void api.shell.openInEditor(`${root}/${path}`)
                }}
                style={root ? { cursor: 'var(--cursor)' } : undefined}
              >
                {f.status === 'renamed' ? `${f.oldPath} → ${f.newPath}` : path}
              </span>
              <span style={{ color: 'var(--success)', fontSize: 11.5 }}>+{f.additions}</span>
              <span style={{ color: 'var(--danger)', fontSize: 11.5 }}>-{f.deletions}</span>
              {onToggleViewed && (
                <label className="check" style={{ fontSize: 11.5 }} onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={!!isViewed} onChange={() => onToggleViewed(path)} /> Viewed
                </label>
              )}
              {!readOnly && onAction && (
                <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                  {view !== 'staged' && (
                    <button className="icon-btn sm" title="Stage file" onClick={() => onAction(f, null, 'stage')}>
                      <Icon name="plus" size={13} />
                    </button>
                  )}
                  {view === 'staged' && (
                    <button className="icon-btn sm" title="Unstage file" onClick={() => onAction(f, null, 'unstage')}>
                      <Icon name="minus" size={13} />
                    </button>
                  )}
                  {view === 'unstaged' && (
                    <button className="icon-btn sm" title="Revert file" onClick={() => onAction(f, null, 'revert')}>
                      <Icon name="undo" size={13} />
                    </button>
                  )}
                </span>
              )}
            </div>
            {!isCollapsed && f.binary && <div className="empty-note">Binary file</div>}
            {!isCollapsed &&
              f.hunks.map((h, hi) => {
                const nums = numberHunkLines(h)
                return (
                  <div key={hi} className="diff-hunk">
                    <div className="diff-hunk-head">
                      <span className="ellipsis">{h.header}</span>
                      {!readOnly && onAction && f.status !== 'untracked' && (
                        <span className="actions">
                          {view !== 'staged' && (
                            <button className="btn sm" onClick={() => onAction(f, hi, 'stage')}>
                              Stage
                            </button>
                          )}
                          {view === 'staged' && (
                            <button className="btn sm" onClick={() => onAction(f, hi, 'unstage')}>
                              Unstage
                            </button>
                          )}
                          {view === 'unstaged' && (
                            <button className="btn sm danger" onClick={() => onAction(f, hi, 'revert')}>
                              Revert
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="diff-lines">
                      {h.lines.map((l, li) => {
                        const [o, n] = nums[li]
                        const kind = l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : ''
                        const lineNo = n ?? o ?? 0
                        const lineComments = comments?.filter((c) => c.file === path && c.line === lineNo && kind !== 'del') ?? []
                        return (
                          <Fragment key={li}>
                            <div className={`dl ${kind}`}>
                              {onComment && kind !== 'del' && l[0] !== '\\' && (
                                <button className="plus" title="Comment on this line" onClick={() => setDraft({ file: path, line: lineNo, code: l.slice(1), text: '' })}>
                                  +
                                </button>
                              )}
                              <span className="no">{o ?? ''}</span>
                              <span className="no">{n ?? ''}</span>
                              <span className="code">{l}</span>
                            </div>
                            {lineComments.map((c, ci) => (
                              <div key={ci} className="inline-comment">
                                <Icon name="message" size={12} style={{ color: 'var(--accent)' }} /> {c.text}
                              </div>
                            ))}
                            {draft && draft.file === path && draft.line === lineNo && kind !== 'del' && (
                              <div className="inline-comment col">
                                <textarea
                                  className="textarea"
                                  autoFocus
                                  rows={3}
                                  value={draft.text}
                                  placeholder="Feedback for Claude on this line…"
                                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft.text.trim()) {
                                      onComment!(draft)
                                      setDraft(null)
                                    }
                                    if (e.key === 'Escape') setDraft(null)
                                  }}
                                />
                                <div className="row" style={{ justifyContent: 'flex-end' }}>
                                  <button className="btn sm" onClick={() => setDraft(null)}>
                                    Cancel
                                  </button>
                                  <button
                                    className="btn sm primary"
                                    disabled={!draft.text.trim()}
                                    onClick={() => {
                                      onComment!(draft)
                                      setDraft(null)
                                    }}
                                  >
                                    Add comment
                                  </button>
                                </div>
                              </div>
                            )}
                          </Fragment>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

export function ReviewPane({ session }: { session?: LiveSession }) {
  const projects = useStore((s) => s.library.projects)
  const [repo, setRepo] = useState<string | undefined>(session?.root)
  const [view, setView] = useState<DiffView>('unstaged')
  const [files, setFiles] = useState<DiffFile[] | null>(null)
  const [info, setInfo] = useState<GitInfo | null>(null)
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [ref, setRef] = useState<string>('HEAD')
  const [base, setBase] = useState<string>('')
  const [error, setError] = useState('')
  const [comments, setComments] = useState<Comment[]>([])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState('')
  const reqRef = useRef(0)

  const repos = useMemo(() => {
    const p = projects.find((x) => x.id === session?.projectId)
    return [...new Set([session?.root, ...(p?.folders ?? [])].filter(Boolean) as string[])]
  }, [session?.root, session?.projectId, projects])

  useEffect(() => setRepo(session?.root), [session?.root])

  const load = useCallback(async () => {
    if (!repo) return
    const req = ++reqRef.current
    setError('')
    try {
      const gi = await api.git.info(repo)
      if (req !== reqRef.current) return
      setInfo(gi)
      if (!gi.isRepo) {
        setFiles([])
        return
      }
      const b = base || gi.defaultBranch || 'main'
      if (!base) setBase(b)
      const d = await api.git.diff(repo, view, { ref: view === 'lastTurn' ? session?.turnSnapshot : ref, base: b })
      if (req === reqRef.current) setFiles(d)
      if (view === 'commit' && !commits.length) setCommits(await api.git.commits(repo))
    } catch (e) {
      if (req === reqRef.current) {
        setError(errMsg(e))
        setFiles([])
      }
    }
  }, [repo, view, ref, base, session?.turnSnapshot, commits.length])

  useEffect(() => {
    setFiles(null)
    void load()
  }, [load])

  // Refresh as Claude edits files.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = bridge.on('session:fileTouched', () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void load(), 600)
    })
    return () => {
      off()
      if (t) clearTimeout(t)
    }
  }, [load])
  useEffect(() => {
    if (session?.status === 'idle') void load()
  }, [session?.status])

  const act = async (f: DiffFile, hunk: number | null, a: Action): Promise<void> => {
    if (!repo) return
    if (a === 'revert' && (await api.dialog.confirm(`Revert ${hunk === null ? 'all changes in' : 'this hunk of'} ${f.newPath}?`, 'This discards the changes from your working tree.', ['Revert', 'Cancel'])) !== 0) return
    try {
      if (hunk === null) await api.git.applyFile(repo, f, a)
      else await api.git.applyHunk(repo, f, hunk, a)
    } catch (e) {
      toast(errMsg(e), 'error')
    }
    void load()
  }

  const all = async (a: Action): Promise<void> => {
    if (!repo) return
    if (a === 'revert' && (await api.dialog.confirm('Revert ALL uncommitted changes?', 'Tracked changes are discarded and untracked files are deleted. This cannot be undone.', ['Revert all', 'Cancel'])) !== 0) return
    await attempt(() => api.git.applyAll(repo, a))
    void load()
  }

  const sendComments = (): void => {
    if (!session || !comments.length) return
    const text =
      'Please address these review comments on your changes:\n\n' +
      comments.map((c, i) => `${i + 1}. ${c.file}:${c.line} — ${c.text}\n   > ${c.code.trim()}`).join('\n') +
      '\n\nMake the changes, then summarize what you did for each comment.'
    void api.session.sendPrompt(session.id, text)
    setComments([])
    toast(`Sent ${comments.length} comment(s) to ${session.name}`, 'success')
  }

  const doCommit = async (push: boolean): Promise<void> => {
    if (!repo || !msg.trim()) return toast('Write a commit message first', 'error')
    setBusy(push ? 'push' : 'commit')
    const staged = view === 'staged' ? files?.length : (await api.git.diff(repo, 'staged', {})).length
    const ok = await attempt(() => api.git.commit(repo, msg, { all: !staged }), 'Committed')
    if (ok !== undefined && push) await attempt(() => api.git.push(repo), 'Pushed')
    if (ok !== undefined) setMsg('')
    setBusy('')
    void load()
  }

  const generate = async (): Promise<void> => {
    if (!repo) return
    setBusy('gen')
    const m = await attempt(() => api.git.generateCommitMessage(repo))
    if (m) setMsg(m)
    setBusy('')
  }

  const createPr = async (): Promise<void> => {
    if (!repo) return
    setBusy('pr')
    if (info?.branch && info.branch === info.defaultBranch) {
      const name = await askText('You are on the default branch. Create a branch for this PR:', `claude/${Date.now().toString(36)}`)
      if (!name) return setBusy('')
      if ((await attempt(() => api.git.createBranch(repo, name))) === undefined) return setBusy('')
    }
    await attempt(() => api.git.push(repo))
    const url = await attempt(() => api.git.createPr(repo, { draft: false }))
    setBusy('')
    if (url) {
      toast('Pull request created', 'success')
      void api.shell.openExternal(url)
    }
    void load()
  }

  if (!session) return <div className="empty-note">Open a session to review its changes.</div>
  if (info && !info.isRepo)
    return (
      <div className="empty-note">
        <b>{repo}</b> is not a Git repository.
        <div style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => api.session.sendPrompt(session.id, 'Initialize a git repository here with a sensible .gitignore and make an initial commit.')}>
            Ask Claude to set up Git
          </button>
        </div>
      </div>
    )

  const totalAdd = files?.reduce((n, f) => n + f.additions, 0) ?? 0
  const totalDel = files?.reduce((n, f) => n + f.deletions, 0) ?? 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="col" style={{ padding: '8px 10px', gap: 6, borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 6 }}>
          {repos.length > 1 ? (
            <select className="select" style={{ flex: 1 }} value={repo} onChange={(e) => setRepo(e.target.value)}>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r.split(/[\\/]/).pop()}
                </option>
              ))}
            </select>
          ) : (
            <span className="grow ellipsis mono" style={{ fontSize: 12 }} title={repo}>
              {repo?.split(/[\\/]/).pop()}
            </span>
          )}
          {info?.branch && (
            <span className="badge">
              <Icon name="branch" size={11} /> {info.branch}
              {info.ahead ? ` ↑${info.ahead}` : ''}
              {info.behind ? ` ↓${info.behind}` : ''}
            </span>
          )}
          <button className="icon-btn sm" title="Pull (rebase)" onClick={() => repo && attempt(() => api.git.pull(repo), 'Pulled').then(load)}>
            <Icon name="download" size={14} />
          </button>
          <button className="icon-btn sm" title="Refresh" onClick={load}>
            <Icon name="refresh" size={14} />
          </button>
        </div>
        <Seg
          value={view}
          onChange={setView}
          options={[
            ['unstaged', 'Unstaged'],
            ['staged', 'Staged'],
            ['lastTurn', 'Last turn'],
            ['branch', 'Branch'],
            ['commit', 'Commit']
          ]}
        />
        {view === 'commit' && (
          <select className="select" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="HEAD">HEAD</option>
            {commits.map((c) => (
              <option key={c.sha} value={c.sha}>
                {c.short} {c.subject} — {c.author}, {c.date}
              </option>
            ))}
          </select>
        )}
        {view === 'branch' && (
          <div className="row">
            <span className="muted">Compared with</span>
            <input className="input" style={{ height: 26 }} value={base} onChange={(e) => setBase(e.target.value)} onBlur={load} />
          </div>
        )}
        {view === 'lastTurn' && !session.turnSnapshot && <div className="muted" style={{ fontSize: 12 }}>Changes since the start of Claude's latest turn appear here once a turn begins.</div>}
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 12 }}>
            {files?.length ?? 0} files · <span style={{ color: 'var(--success)' }}>+{totalAdd}</span> <span style={{ color: 'var(--danger)' }}>-{totalDel}</span>
          </span>
          <span className="grow" />
          {view === 'unstaged' && (
            <>
              <button className="btn sm" onClick={() => all('stage')}>
                Stage all
              </button>
              <button className="btn sm danger" onClick={() => all('revert')}>
                Revert all
              </button>
            </>
          )}
          {view === 'staged' && (
            <button className="btn sm" onClick={() => all('unstage')}>
              Unstage all
            </button>
          )}
          <button className="btn sm" title="Ask Claude to review these changes" onClick={() => api.session.sendPrompt(session.id, view === 'branch' ? `/review Review the changes on this branch compared with ${base}.` : '/review')}>
            <Icon name="sparkles" size={12} /> Review
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {error && <div className="empty-note">{error}</div>}
        {files === null ? (
          <div className="empty-note">Loading diff…</div>
        ) : (
          <DiffList files={files} view={view} onAction={view === 'unstaged' || view === 'staged' ? act : undefined} comments={comments} onComment={(c) => setComments((cs) => [...cs, c])} root={repo} />
        )}
      </div>
      {comments.length > 0 && (
        <div className="row" style={{ padding: '8px 10px', borderTop: '1px solid var(--border)', background: 'var(--accent-soft)' }}>
          <Icon name="message" size={14} />
          <span className="grow">
            {comments.length} comment{comments.length > 1 ? 's' : ''} for Claude
          </span>
          <button className="btn sm ghost" onClick={() => setComments([])}>
            Discard
          </button>
          <button className="btn sm primary" onClick={sendComments}>
            <Icon name="send" size={12} /> Send to {session.name}
          </button>
        </div>
      )}
      <div className="col" style={{ padding: 10, borderTop: '1px solid var(--border)', gap: 6 }}>
        <textarea className="textarea" rows={2} style={{ minHeight: 54 }} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Commit message" onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && void doCommit(false)} />
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={generate} disabled={!!busy}>
            <Icon name="wand" size={12} /> {busy === 'gen' ? 'Drafting…' : 'Draft'}
          </button>
          <span className="grow" />
          <button className="btn sm" onClick={() => doCommit(false)} disabled={!!busy}>
            Commit
          </button>
          <button className="btn sm" onClick={() => doCommit(true)} disabled={!!busy || !info?.hasRemote}>
            <Icon name="upload" size={12} /> Commit & push
          </button>
          <button className="btn sm primary" onClick={createPr} disabled={!!busy || !info?.ghAvailable || !info?.hasRemote} title={info?.ghAvailable ? 'Push and open a pull request' : 'Install the GitHub CLI (gh) to create PRs'}>
            <Icon name="pr" size={12} /> {busy === 'pr' ? 'Creating…' : 'Create PR'}
          </button>
        </div>
      </div>
    </div>
  )
}
