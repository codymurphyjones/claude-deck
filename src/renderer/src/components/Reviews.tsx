import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { parseUnifiedDiff } from '@shared/diff'
import type { PullRequestDetail, PullRequestSummary } from '@shared/types'
import { api, errMsg } from '../api'
import { activeSession, attempt, openSession, set, toast, useStore } from '../store'
import { DiffList } from './ReviewPane'
import { Icon } from './Icon'
import { Modal, Seg, timeAgo } from './ui'

const usePr = create<{ cwd: string; number: number } | null>(() => null)

export function ReviewsView() {
  const projects = useStore((s) => s.library.projects)
  const pinned = useStore((s) => s.pinnedReviews)
  const [cwd, setCwd] = useState<string>(() => activeSession()?.root ?? projects[0]?.folders[0] ?? '')
  const [filter, setFilter] = useState<'review' | 'assigned' | 'authored' | 'all'>('review')
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null)
  const [err, setErr] = useState('')
  const [link, setLink] = useState('')

  const load = async (): Promise<void> => {
    if (!cwd) return
    setPrs(null)
    setErr('')
    try {
      setPrs(await api.gh.list(cwd, filter))
    } catch (e) {
      setErr(errMsg(e))
      setPrs([])
    }
  }
  useEffect(() => {
    void load()
  }, [cwd, filter])

  const openLink = (): void => {
    const m = /\/pull\/(\d+)/.exec(link) ?? /^#?(\d+)$/.exec(link.trim())
    if (m) usePr.setState({ cwd, number: +m[1] }, true)
    else toast('Paste a pull request URL or number', 'error')
  }

  return (
    <>
      <div className="sidebar-head">
        <span className="title">Code review</span>
        <button className="icon-btn sm" title="Refresh" onClick={load}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="col" style={{ padding: '0 10px 8px', gap: 6 }}>
        <select className="select" value={cwd} onChange={(e) => setCwd(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.folders[0]}>
              {p.name}
            </option>
          ))}
        </select>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            ['review', 'For me'],
            ['assigned', 'Assigned'],
            ['authored', 'Mine'],
            ['all', 'All']
          ]}
        />
        <input className="input" placeholder="Paste a PR link or number…" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openLink()} />
      </div>
      <div className="sidebar-body">
        {err && <div className="empty-note">{err}</div>}
        {prs === null && <div className="empty-note">Loading pull requests…</div>}
        {prs && !prs.length && !err && <div className="empty-note">No pull requests here.</div>}
        {prs &&
          [...prs]
            .sort((a, b) => Number(pinned.includes(`${b.repo}#${b.number}`)) - Number(pinned.includes(`${a.repo}#${a.number}`)))
            .map((p) => (
              <div key={p.number} className="list-item" style={{ alignItems: 'flex-start' }} onClick={() => usePr.setState({ cwd, number: p.number }, true)}>
                <Icon name="pr" size={14} style={{ marginTop: 2, color: p.isDraft ? 'var(--muted)' : 'var(--success)' }} />
                <div className="grow">
                  <div className="ellipsis">
                    {pinned.includes(`${p.repo}#${p.number}`) && <Icon name="pin" size={11} />} {p.title}
                  </div>
                  <div className="sub ellipsis">
                    #{p.number} · {p.author} · {timeAgo(Date.parse(p.updatedAt))}
                    {p.reviewDecision ? ` · ${p.reviewDecision.toLowerCase().replace('_', ' ')}` : ''}
                  </div>
                </div>
              </div>
            ))}
      </div>
      <PrModal />
    </>
  )
}

function PrModal() {
  const target = usePr()
  const pinned = useStore((s) => s.pinnedReviews)
  const [pr, setPr] = useState<PullRequestDetail | null>(null)
  const [tab, setTab] = useState<'summary' | 'changes' | 'checks'>('summary')
  const [body, setBody] = useState('')
  const [viewed, setViewed] = useState<string[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!target) return
    setPr(null)
    setErr('')
    setTab('summary')
    api.gh.detail(target.cwd, target.number).then(setPr, (e) => setErr(errMsg(e)))
  }, [target])
  const key = pr ? `${pr.repo}#${pr.number}` : ''
  useEffect(() => {
    if (key) void api.library.viewedFiles(`${key}@${pr?.headRefName}`).then(setViewed)
  }, [key])
  const files = useMemo(() => (pr ? parseUnifiedDiff(pr.diff) : []), [pr])
  if (!target) return null
  const close = (): void => usePr.setState(null, true)
  const submit = async (kind: 'approve' | 'request-changes' | 'comment'): Promise<void> => {
    if (!pr) return
    if (await attempt(() => api.gh.review(target.cwd, pr.number, kind, body), kind === 'approve' ? 'Approved' : 'Review submitted')) setBody('')
  }
  const reviewWithClaude = async (): Promise<void> => {
    if (!pr) return
    close()
    await openSession('agent', {
      cwd: target.cwd,
      name: `Review #${pr.number}`,
      initialPrompt: `Review pull request #${pr.number} ("${pr.title}") in ${pr.repo}. Use \`gh pr view ${pr.number}\` and \`gh pr diff ${pr.number}\`. Look for correctness bugs, security issues and missing tests. Present findings ranked by severity with file:line references, and draft review comments, but do not post anything until I confirm.${useStore.getState().settings.reviewInstructions ? `\n\nReview guidelines:\n${useStore.getState().settings.reviewInstructions}` : ''}`
    })
  }
  const fixCheck = (name: string, url?: string): void => {
    close()
    const s = activeSession()
    const prompt = `The CI check "${name}" is failing on PR #${pr?.number}${url ? ` (${url})` : ''}. Inspect the failure (e.g. \`gh run view --log-failed\`), find the root cause, and fix it.`
    if (s?.kind === 'agent') set({ composerFor: s.id, composerPrefill: prompt })
    else void openSession('agent', { cwd: target.cwd, initialPrompt: prompt })
  }
  const toggleViewed = (f: string): void => {
    const next = viewed.includes(f) ? viewed.filter((x) => x !== f) : [...viewed, f]
    setViewed(next)
    void api.library.viewedFiles(`${key}@${pr?.headRefName}`, next)
  }
  return (
    <Modal
      wide
      icon="pr"
      title={pr ? `#${pr.number} ${pr.title}` : `Pull request #${target.number}`}
      onClose={close}
      footer={
        pr && (
          <>
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => api.library.pinReview(key, !pinned.includes(key)).then((p) => set({ pinnedReviews: p }))}>
              <Icon name="pin" size={13} /> {pinned.includes(key) ? 'Unpin' : 'Pin'}
            </button>
            <button className="btn" onClick={() => api.shell.openExternal(pr.url)}>
              <Icon name="external" size={13} /> GitHub
            </button>
            <button className="btn" onClick={reviewWithClaude}>
              <Icon name="sparkles" size={13} /> Review with Claude
            </button>
            <button className="btn" onClick={() => openSession('agent', { cwd: target.cwd, extraArgs: ['--from-pr', String(pr.number)], name: `PR #${pr.number}` }).then(close)}>
              <Icon name="history" size={13} /> Linked chat
            </button>
          </>
        )
      }
    >
      {err && <div className="empty-note">{err}</div>}
      {!pr && !err && <div className="empty-note">Loading…</div>}
      {pr && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div className="row" style={{ padding: '0 18px 10px' }}>
            <Seg
              value={tab}
              onChange={setTab}
              options={[
                ['summary', 'Summary'],
                ['changes', `Changes (${pr.files.length})`],
                ['checks', `Checks (${pr.checks.length})`]
              ]}
            />
            <span className="muted">
              {pr.author} wants to merge <code>{pr.headRefName}</code> into <code>{pr.baseRefName}</code>
            </span>
          </div>
          <div style={{ flex: 1, overflow: 'auto', borderTop: '1px solid var(--border)' }}>
            {tab === 'summary' && (
              <div className="col selectable" style={{ padding: 18, gap: 12 }}>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{pr.body || <span className="muted">No description.</span>}</div>
                {pr.reviews.length > 0 && <div className="section-label">Reviews</div>}
                {pr.reviews.map((r, i) => (
                  <div key={i} className="msg">
                    <div className="meta">
                      <b>{r.author}</b> <span className="badge">{r.state.toLowerCase()}</span>
                    </div>
                    {r.body}
                  </div>
                ))}
                {pr.comments.length > 0 && <div className="section-label">Comments</div>}
                {pr.comments.map((c, i) => (
                  <div key={i} className="msg">
                    <div className="meta">
                      <b>{c.author}</b> {timeAgo(Date.parse(c.createdAt))}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div>
                  </div>
                ))}
                <div className="section-label">Your review</div>
                <textarea className="textarea" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Leave a comment (Markdown)…" />
                <div className="row">
                  <button className="btn" onClick={() => attempt(() => api.gh.comment(target.cwd, pr.number, body), 'Comment posted').then(() => setBody(''))} disabled={!body.trim()}>
                    Comment now
                  </button>
                  <span className="grow" />
                  <button className="btn" onClick={() => submit('comment')}>
                    Submit as comment
                  </button>
                  <button className="btn danger" onClick={() => submit('request-changes')} disabled={!body.trim()}>
                    Request changes
                  </button>
                  <button className="btn primary" onClick={() => submit('approve')}>
                    Approve
                  </button>
                </div>
              </div>
            )}
            {tab === 'changes' && <DiffList files={files} readOnly viewed={viewed} onToggleViewed={toggleViewed} />}
            {tab === 'checks' && (
              <div style={{ padding: 10 }}>
                {!pr.checks.length && <div className="empty-note">No checks reported.</div>}
                {pr.checks.map((c, i) => {
                  const failed = /fail|error|timed_out|cancel/i.test(c.conclusion)
                  return (
                    <div key={i} className="list-item">
                      <Icon name={failed ? 'x' : /success|pass/i.test(c.conclusion) ? 'check' : 'clock'} size={14} style={{ color: failed ? 'var(--danger)' : 'var(--success)' }} />
                      <span className="grow ellipsis">{c.name}</span>
                      <span className="sub">{(c.conclusion || c.status).toLowerCase()}</span>
                      {c.url && (
                        <button className="icon-btn sm" onClick={() => api.shell.openExternal(c.url!)}>
                          <Icon name="external" size={13} />
                        </button>
                      )}
                      {failed && (
                        <button className="btn sm" onClick={() => fixCheck(c.name, c.url)}>
                          Fix
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
