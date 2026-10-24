import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { numberHunkLines } from '@shared/diff'
import { isOpenPr, type CurrentPr } from '@shared/repo'
import type { CommitInfo, DiffFile, DiffView, GitInfo } from '@shared/types'
import { api, bridge, errMsg, type LiveSession } from '../api'
import { askText, attempt, set, toast, useStore } from '../store'
import { Icon } from './Icon'
import { Seg, useExclusive } from './ui'
import { useFind } from './FindBar'
import { loadProgressive, type ProgressiveLoad } from '../progressive'
import { highlightDiffLines, langForFile } from '../highlight'
import { LazyCtx, scrollParent, useLazyObserver, useLazyShown } from '../lazyMount'

/** Files with more diff lines than this are shown without highlighting. */
const HIGHLIGHT_MAX_LINES = 6000

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
  root,
  busy,
  onEdit
}: {
  files: DiffFile[]
  readOnly?: boolean
  /** An action is running: action buttons are disabled. */
  busy?: boolean
  view?: DiffView
  onAction?: (f: DiffFile, hunk: number | null, a: Action) => void
  comments?: Comment[]
  onComment?: (c: Comment) => void
  viewed?: string[]
  onToggleViewed?: (path: string) => void
  root?: string
  /** Show an Edit button per file (opens the in-app editor). */
  onEdit?: (path: string) => void
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [draft, setDraft] = useState<Draft | null>(null)
  const find = useFind()
  const listEl = useRef<HTMLDivElement | null>(null)
  const observe = useLazyObserver(() => scrollParent(listEl.current))
  // Find searches the DOM, so every file body renders while the find bar is open.
  const findOpen = find.bar !== null
  if (!files.length) return <div className="empty-note">No changes.</div>
  return (
    <div
      ref={(el) => {
        listEl.current = el
        return find.scope(el)
      }}
    >
      {find.bar}
      <LazyCtx.Provider value={observe}>
        {files.map((f, fi) => {
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
                {onEdit && f.status !== 'deleted' && !f.binary && (
                  <button
                    className="icon-btn sm"
                    title="Edit this file"
                    onClick={(e) => {
                      e.stopPropagation()
                      onEdit(path)
                    }}
                  >
                    <Icon name="edit" size={13} />
                  </button>
                )}
                {onToggleViewed && (
                  <label className="check" style={{ fontSize: 11.5 }} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={!!isViewed} onChange={() => onToggleViewed(path)} /> Viewed
                  </label>
                )}
                {!readOnly && onAction && (
                  <span className="row" style={{ gap: 2 }} onClick={(e) => e.stopPropagation()}>
                    {view !== 'staged' && (
                      <button className="icon-btn sm" title="Stage file" disabled={busy} onClick={() => onAction(f, null, 'stage')}>
                        <Icon name="plus" size={13} />
                      </button>
                    )}
                    {view === 'staged' && (
                      <button className="icon-btn sm" title="Unstage file" disabled={busy} onClick={() => onAction(f, null, 'unstage')}>
                        <Icon name="minus" size={13} />
                      </button>
                    )}
                    {view === 'unstaged' && (
                      <button className="icon-btn sm" title="Revert file" disabled={busy} onClick={() => onAction(f, null, 'revert')}>
                        <Icon name="undo" size={13} />
                      </button>
                    )}
                  </span>
                )}
              </div>
              {!isCollapsed && f.binary && <div className="empty-note">Binary file</div>}
              {!isCollapsed && !f.binary && (
                <LazyFileBody
                  eager={findOpen || fi < EAGER_FILES}
                  f={f}
                  path={path}
                  view={view}
                  readOnly={readOnly}
                  busy={busy}
                  onAction={onAction}
                  comments={comments}
                  onComment={onComment}
                  draft={draft}
                  setDraft={setDraft}
                />
              )}
            </div>
          )
        })}
      </LazyCtx.Provider>
    </div>
  )
}

/** Files at the top whose diffs render straight away; the rest render as they're scrolled near. */
const EAGER_FILES = 8

type Draft = Comment

type FileBodyProps = {
  f: DiffFile
  path: string
  view?: DiffView
  readOnly?: boolean
  busy?: boolean
  onAction?: (f: DiffFile, hunk: number | null, a: Action) => void
  comments?: Comment[]
  onComment?: (c: Comment) => void
  draft: Draft | null
  setDraft: (d: Draft | null) => void
}

/** A file's diff, as a placeholder of about its height until it comes near the visible area. */
function LazyFileBody(props: FileBodyProps & { eager: boolean }) {
  const { eager, ...rest } = props
  const [shown, ph] = useLazyShown(eager)
  if (shown) return <FileBody {...rest} />
  // Hunk header ≈ 24px, diff line = 18px (12px × 1.5).
  const height = props.f.hunks.reduce((h, k) => h + 24 + k.lines.length * 18, 0)
  return <div ref={ph} style={{ height }} />
}

function FileBody({ f, path, view, readOnly, busy, onAction, comments, onComment, draft, setDraft }: FileBodyProps) {
  // Per hunk: highlighted HTML for each line's content (without its +/- prefix).
  const html = useMemo(() => {
    const n = f.hunks.reduce((k, h) => k + h.lines.length, 0)
    const lang = n > HIGHLIGHT_MAX_LINES ? 'plaintext' : langForFile(f.newPath || f.oldPath)
    return f.hunks.map((h) => highlightDiffLines(h.lines, lang))
  }, [f])
  return (
    <>
      {f.hunks.map((h, hi) => {
          const nums = numberHunkLines(h)
          return (
            <div key={hi} className="diff-hunk">
              <div className="diff-hunk-head">
                <span className="ellipsis">{h.header}</span>
                {!readOnly && onAction && f.status !== 'untracked' && (
                  <span className="actions">
                    {view !== 'staged' && (
                      <button className="btn sm" disabled={busy} onClick={() => onAction(f, hi, 'stage')}>
                        Stage
                      </button>
                    )}
                    {view === 'staged' && (
                      <button className="btn sm" disabled={busy} onClick={() => onAction(f, hi, 'unstage')}>
                        Unstage
                      </button>
                    )}
                    {view === 'unstaged' && (
                      <button className="btn sm danger" disabled={busy} onClick={() => onAction(f, hi, 'revert')}>
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
                        <span className="no" data-find-skip>{o ?? ''}</span>
                        <span className="no" data-find-skip>{n ?? ''}</span>
                        <span className="code hljs">
                          {l[0]}
                          <span dangerouslySetInnerHTML={{ __html: html[hi]?.[li] ?? '' }} />
                        </span>
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
    </>
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
  const [amend, setAmend] = useState(false)
  const [busy, setBusy] = useState('')
  const reqRef = useRef(0)
  const loadRef = useRef<ProgressiveLoad | undefined>(undefined)
  const [acting, exclusive] = useExclusive()
  const editing = useStore((s) => !!s.editorFile && !!s.editorFile.locked)

  useEffect(() => () => loadRef.current?.cancel(), [])

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
      // Files render as they arrive. The first batch replaces what's shown, so a refresh
      // doesn't blank the list while it reloads.
      loadRef.current?.cancel()
      const pl = loadProgressive<DiffFile>(
        (id) => api.load.gitDiff(id, repo, view, { ref: view === 'lastTurn' ? session?.turnSnapshot : ref, base: b }),
        (batch, first) => req === reqRef.current && setFiles((cur) => (first ? batch : [...(cur ?? []), ...batch]))
      )
      loadRef.current = pl
      const r = await pl.done
      if (req === reqRef.current && !r.records) setFiles([])
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

  // One action at a time, held until the reload shows the result, so a double-click can't
  // stage (or revert) the same change twice.
  const act = (f: DiffFile, hunk: number | null, a: Action): Promise<void> =>
    exclusive(async () => {
      if (!repo) return
      if (a === 'revert' && (await api.dialog.confirm(`Revert ${hunk === null ? 'all changes in' : 'this hunk of'} ${f.newPath}?`, 'This discards the changes from your working tree.', ['Revert', 'Cancel'])) !== 0) return
      try {
        if (hunk === null) await api.git.applyFile(repo, f, a)
        else await api.git.applyHunk(repo, f, hunk, a)
      } catch (e) {
        toast(errMsg(e), 'error')
      }
      await load()
    })

  const all = (a: Action): Promise<void> =>
    exclusive(async () => {
      if (!repo) return
      if (a === 'revert' && (await api.dialog.confirm('Revert ALL uncommitted changes?', 'Tracked changes are discarded and untracked files are deleted. This cannot be undone.', ['Revert all', 'Cancel'])) !== 0) return
      await attempt(() => api.git.applyAll(repo, a))
      await load()
    })

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
    if (!repo) return
    // Amend with an empty message keeps the last commit's message (no -m / --no-edit).
    if (!amend && !msg.trim()) return toast('Write a commit message first', 'error')
    // Only what's staged is committed; nothing is staged automatically. (Amend may just reword.)
    if (!info?.staged && !(amend && msg.trim())) return toast('Stage the changes to commit first', 'error')
    setBusy(push ? 'push' : 'commit')
    const ok = await attempt(() => api.git.commit(repo, msg, { amend }), amend ? 'Commit amended' : 'Committed')
    // An amended commit replaces one that may already be on the remote.
    if (ok !== undefined && push) await attempt(() => (amend ? api.repo.push(repo, { force: true }) : api.git.push(repo)), 'Pushed')
    if (ok !== undefined) {
      setMsg('')
      setAmend(false)
    }
    setBusy('')
    void load()
  }
  const canCommit = amend ? !!info?.staged || !!msg.trim() : !!info?.staged

  // Nothing left to commit but local commits to publish (e.g. Commit was pressed instead of
  // Commit & push): the Commit button becomes Push.
  const pushReady = !!info?.hasRemote && info.tracked === 0 && !msg.trim() && !amend && ((info.ahead ?? 0) > 0 || (!info.upstream && info.branch !== info.defaultBranch))
  const doPush = async (): Promise<void> => {
    if (!repo) return
    setBusy('push')
    await attempt(() => api.git.push(repo), 'Pushed')
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

  // The branch's PR, looked up with gh over the network: only when the repo or branch changes, when
  // Claude finishes a turn (it may have opened one), and after creating one; not on every reload.
  // undefined = not known yet, so neither Create PR nor the PR link shows.
  const [pr, setPr] = useState<CurrentPr | null | undefined>(undefined)
  const prReq = useRef(0)
  const prKey = info?.isRepo && info.ghAvailable && info.hasRemote && info.branch ? `${repo}\n${info.branch}` : ''
  const loadPr = useCallback(async () => {
    const n = ++prReq.current
    if (!repo || !prKey) return setPr(null)
    const r = await api.repo.currentPr(repo).catch(() => null)
    if (n === prReq.current) setPr(r)
  }, [repo, prKey])
  useEffect(() => {
    setPr(undefined)
    void loadPr()
  }, [loadPr])
  useEffect(() => {
    if (session?.status === 'idle') void loadPr()
  }, [session?.status])
  const openPr = pr && isOpenPr(pr) ? pr : undefined

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
    void loadPr()
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
          onChange={(v) => (editing ? toast('Close the file editor before switching tabs', 'error') : setView(v))}
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
              <button className="btn sm" disabled={acting} onClick={() => all('stage')}>
                Stage all
              </button>
              <button className="btn sm danger" disabled={acting} onClick={() => all('revert')}>
                Revert all
              </button>
            </>
          )}
          {view === 'staged' && (
            <button className="btn sm" disabled={acting} onClick={() => all('unstage')}>
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
          <DiffList files={files} view={view} onAction={view === 'unstaged' || view === 'staged' ? act : undefined} busy={acting} comments={comments}
            onComment={(c) => setComments((cs) => [...cs, c])}
            root={repo}
            // An editor already open over the content area is re-targeted rather than remounted, so its unsaved edits survive.
            onEdit={(p) => set((s) => ({ editorFile: { path: `${repo}/${p}`, locked: s.editorFile ? s.editorFile.locked : true } }))}
          />
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
        <textarea className="textarea" rows={2} style={{ minHeight: 54 }} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={amend ? "Leave empty to keep the last commit's message" : 'Commit message'} onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && void doCommit(false)} />
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          <button className="btn sm" onClick={generate} disabled={!!busy}>
            <Icon name="wand" size={12} /> {busy === 'gen' ? 'Drafting…' : 'Draft'}
          </button>
          <label className="check" style={{ fontSize: 12 }} title="Add the staged changes to the last commit instead of making a new one. With an empty message, the last commit's message is kept.">
            <input type="checkbox" checked={amend} onChange={(e) => setAmend(e.target.checked)} /> Amend
          </label>
          <span className="grow" />
          {pushReady ? (
            <button className="btn sm primary" onClick={doPush} disabled={!!busy} title={info?.upstream ? `Push ${info.ahead} commit(s) to ${info.upstream}` : `Publish ${info?.branch}`}>
              <Icon name="upload" size={12} /> {busy === 'push' ? 'Pushing…' : `Push${info?.ahead ? ` ↑${info.ahead}` : ''}`}
            </button>
          ) : (
            <button className="btn sm" onClick={() => doCommit(false)} disabled={!!busy || !canCommit} title={!canCommit ? 'Stage changes to commit them' : amend ? 'Amend the last commit' : `Commit ${info?.staged} staged file(s)`}>
              {amend ? 'Amend' : 'Commit'}
            </button>
          )}
          <button className="btn sm" onClick={() => doCommit(true)} disabled={!!busy || !info?.hasRemote || !canCommit} title={!canCommit ? 'Stage changes to commit them' : amend ? 'Amend the last commit and force-push (with lease)' : `Commit ${info?.staged} staged file(s) and push`}>
            <Icon name="upload" size={12} /> {amend ? 'Amend & force push' : 'Commit & push'}
          </button>
          {openPr ? (
            <button className="btn sm" onClick={() => api.shell.openExternal(openPr.url)} title={`Open pull request #${openPr.number}: ${openPr.title}`}>
              <Icon name="pr" size={12} /> PR #{openPr.number}
              {openPr.isDraft ? ' (draft)' : ''}
            </button>
          ) : (
            <button
              className="btn sm primary"
              onClick={createPr}
              // Wait until the lookup says there's no open PR (gh missing or no remote resolves to null at once).
              disabled={!!busy || !info?.ghAvailable || !info?.hasRemote || pr === undefined}
              title={!info?.ghAvailable ? 'Install the GitHub CLI (gh) to create PRs' : pr === undefined ? 'Checking for an existing pull request…' : 'Push and open a pull request'}
            >
              <Icon name="pr" size={12} /> {busy === 'pr' ? 'Creating…' : 'Create PR'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
