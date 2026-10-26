import { memo, useEffect, useMemo, useState } from 'react'
import type { ChatItem, PermissionRequest } from '@shared/chat'
import { summarizeInput } from '@shared/chat'
import { lineDiff, type DiffLine } from '@shared/lineDiff'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { highlight, langFromPath } from './mdRender'
import { highlightDiffLines } from '../highlight'
import { useRenderVersion } from '../lazyRender'
import { Markdown, resolvePath } from './Markdown'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch'])

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>

const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v, null, 2))
const base = (p: string): string => p.split(/[\\/]/).pop() ?? p
const rel = (p: string, cwd: string): string => (p.toLowerCase().startsWith(cwd.toLowerCase()) ? p.slice(cwd.length).replace(/^[\\/]/, '') : p)
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')

const ICONS: Record<string, string> = {
  Read: 'file',
  Write: 'file',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'terminal',
  PowerShell: 'terminal',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'globe',
  WebSearch: 'globe',
  Task: 'sparkles',
  Skill: 'zap',
  AskUserQuestion: 'message',
  ExitPlanMode: 'list',
  EnterPlanMode: 'list',
  ToolSearch: 'search'
}

export function toolVerb(t: ToolItem): string {
  const done = t.status === 'done'
  switch (t.name) {
    case 'Read':
      return done ? 'Read' : 'Reading'
    case 'Write':
      return done ? 'Wrote' : 'Writing'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return done ? 'Edited' : 'Editing'
    case 'Bash':
    case 'PowerShell':
      return done ? 'Ran' : 'Running'
    case 'Grep':
    case 'Glob':
      return done ? 'Searched' : 'Searching'
    case 'WebSearch':
      return done ? 'Searched the web' : 'Searching the web'
    case 'WebFetch':
      return done ? 'Fetched' : 'Fetching'
    case 'Task':
      return done ? 'Agent finished' : 'Agent working'
    default:
      if (t.name.startsWith('mcp__deck-mesh__')) return 'Team'
      if (t.name.startsWith('mcp__')) return t.name.split('__').slice(1).join(' · ')
      return t.name
  }
}

/** One-line activity summary for a group of tool calls, e.g. "Read 3 files · Edited 2 files · Ran 1 command". */
export function summarizeTools(tools: ToolItem[]): string {
  const c: Record<string, number> = {}
  const bump = (k: string): void => void (c[k] = (c[k] ?? 0) + 1)
  for (const t of tools) {
    if (t.name === 'Read') bump('read')
    else if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t.name)) bump('edit')
    else if (t.name === 'Bash' || t.name === 'PowerShell') bump('cmd')
    else if (['Grep', 'Glob', 'ToolSearch'].includes(t.name)) bump('search')
    else if (t.name.startsWith('Web')) bump('web')
    else if (t.name === 'Task') bump('agent')
    else if (t.name.startsWith('mcp__deck-mesh__')) bump('team')
    else bump('other')
  }
  const parts: string[] = []
  const pl = (n: number, a: string, b: string): string => `${n} ${n === 1 ? a : b}`
  if (c.read) parts.push(`Read ${pl(c.read, 'file', 'files')}`)
  if (c.edit) parts.push(`Edited ${pl(c.edit, 'file', 'files')}`)
  if (c.cmd) parts.push(`Ran ${pl(c.cmd, 'command', 'commands')}`)
  if (c.search) parts.push(`${pl(c.search, 'search', 'searches')}`)
  if (c.web) parts.push(`${pl(c.web, 'web lookup', 'web lookups')}`)
  if (c.agent) parts.push(`${pl(c.agent, 'subagent', 'subagents')}`)
  if (c.team) parts.push(`${pl(c.team, 'team action', 'team actions')}`)
  if (c.other) parts.push(`${pl(c.other, 'other tool', 'other tools')}`)
  return parts.join(' · ')
}

function DiffView({ lines, lang, max = 400 }: { lines: DiffLine[]; lang?: string; max?: number }) {
  const shown = lines.slice(0, max)
  const html = useMemo(() => highlightDiffLines(shown.map((l) => l.t + l.s), lang), [lines, lang, max])
  return (
    <pre className="tool-diff">
      {shown.map((l, i) => (
        <span key={i} className={`d-line ${l.t === '+' ? 'd-add' : l.t === '-' ? 'd-del' : ''}`}>
          <span className="d-sign">{l.t}</span>
          <span dangerouslySetInnerHTML={{ __html: html[i] || ' ' }} />
        </span>
      ))}
      {lines.length > max && <span className="d-line d-hunk">… {lines.length - max} more lines</span>}
    </pre>
  )
}

function CodeView({ code, lang, maxLines = 400 }: { code: string; lang?: string; maxLines?: number }) {
  const lines = code.split('\n')
  const shown = lines.slice(0, maxLines).join('\n')
  const html = useMemo(() => highlight(shown, lang), [shown, lang])
  return (
    <pre className="tool-code">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      {lines.length > maxLines && <div className="muted">… {lines.length - maxLines} more lines</div>}
    </pre>
  )
}

/** Strip Read's "   12→" line-number gutter. */
function stripReadGutter(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[→\t]/, ''))
    .join('\n')
}

// ---------------------------------------------------------------- cards
export const ToolCard = memo(function ToolCard({
  item: t,
  cwd,
  dark,
  sessionId,
  childrenItems,
  defaultOpen
}: {
  item: ToolItem
  cwd: string
  dark: boolean
  sessionId: string
  childrenItems?: ChatItem[]
  defaultOpen?: boolean
}) {
  const pending = t.permission?.status === 'pending'
  const isEdit = ['Edit', 'MultiEdit', 'Write'].includes(t.name)
  const [open, setOpen] = useState<boolean>(defaultOpen ?? (isEdit || pending))
  useEffect(() => {
    if (pending) setOpen(true)
  }, [pending])
  // Re-resolve the file's language once the full highlight.js language set loads.
  useRenderVersion()

  if (t.name === 'AskUserQuestion') return <QuestionCard item={t} sessionId={sessionId} />
  if (t.name === 'ExitPlanMode') return <PlanCard item={t} sessionId={sessionId} cwd={cwd} dark={dark} />
  if (t.name === 'TodoWrite') return <TodoCard item={t} />
  if (t.name === 'CodexPlan') return <CodexPlanCard item={t} sessionId={sessionId} cwd={cwd} dark={dark} />

  const file = str(t.input.file_path || t.input.notebook_path)
  const target = file ? rel(file, cwd) : summarizeInput(t.name, t.input)
  const isMesh = t.name.startsWith('mcp__deck-mesh__')
  const icon = isMesh ? 'users' : (ICONS[t.name] ?? (t.name.startsWith('mcp__') ? 'zap' : 'code'))
  const running = t.status === 'running' || t.status === 'streaming'

  let stat: React.ReactNode = null
  let body: React.ReactNode = null
  const lang = file ? langFromPath(file) : undefined

  if (t.name === 'Edit' || t.name === 'MultiEdit') {
    const edits: { old_string?: string; new_string?: string }[] = t.name === 'MultiEdit' ? ((t.input.edits as never[]) ?? []) : [t.input as never]
    const lines = edits.flatMap((e, i) => [...(i ? [{ t: ' ' as const, s: '⋯' }] : []), ...lineDiff(str(e.old_string), str(e.new_string))])
    const add = lines.filter((l) => l.t === '+').length
    const del = lines.filter((l) => l.t === '-').length
    stat = (
      <span className="tool-stat">
        <span className="plus">+{add}</span> <span className="minus">−{del}</span>
      </span>
    )
    body = <DiffView lines={lines} lang={lang} />
  } else if (t.name === 'Write') {
    const content = str(t.input.content) || (t.partialInput ? tryPartial(t.partialInput, 'content') : '')
    stat = <span className="tool-stat muted">{content.split('\n').length} lines</span>
    body = <CodeView code={content} lang={lang} />
  } else if (t.name === 'Read') {
    stat = t.input.offset ? <span className="tool-stat muted">from line {str(t.input.offset)}</span> : null
    body = t.result ? <CodeView code={stripReadGutter(t.result)} lang={lang} maxLines={200} /> : null
  } else if (t.name === 'Bash' || t.name === 'PowerShell') {
    body = (
      <div className="tool-term">
        <div className="tool-cmd">
          <span className="prompt">{t.name === 'PowerShell' ? 'PS>' : '$'}</span> {str(t.input.command)}
        </div>
        {t.result !== undefined && <pre className={`tool-out ${t.status === 'error' ? 'err' : ''}`}>{stripAnsi(t.result).slice(0, 30_000) || '(no output)'}</pre>}
      </div>
    )
  } else if (t.name === 'Task') {
    body = (
      <div className="subagent">
        <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
          {str(t.input.prompt).slice(0, 400)}
        </div>
        {childrenItems?.map((c) =>
          c.kind === 'tool' ? (
            <div key={c.id} className="sub-step">
              <Icon name={ICONS[c.name] ?? 'code'} size={12} /> {toolVerb(c)} <span className="mono muted">{c.input.file_path ? rel(str(c.input.file_path), cwd) : summarizeInput(c.name, c.input)}</span>
            </div>
          ) : c.kind === 'text' ? (
            <div key={c.id} className="sub-text">
              <Markdown text={c.text} cwd={cwd} dark={dark} />
            </div>
          ) : null
        )}
        {t.result && (
          <details className="sub-result">
            <summary>Agent report</summary>
            <Markdown text={t.result} cwd={cwd} dark={dark} />
          </details>
        )}
      </div>
    )
  } else if (t.name === 'WebSearch' || t.name === 'WebFetch' || t.name === 'Grep' || t.name === 'Glob' || isMesh || t.result) {
    body = (
      <>
        {isMesh && Object.keys(t.input).length > 0 && <pre className="tool-out">{Object.entries(t.input).map(([k, v]) => `${k}: ${str(v)}`).join('\n')}</pre>}
        {t.result && <pre className={`tool-out ${t.status === 'error' ? 'err' : ''}`}>{stripAnsi(t.result).slice(0, 20_000)}</pre>}
      </>
    )
  } else if (Object.keys(t.input).length) {
    body = <pre className="tool-out hljs" dangerouslySetInnerHTML={{ __html: highlight(JSON.stringify(t.input, null, 2), 'json') }} />
  }

  return (
    <div className={`tool-card ${pending ? 'pending' : ''} ${t.status} ${isMesh ? 'mesh' : ''}`}>
      <div className="tool-head" onClick={() => body && setOpen(!open)}>
        <span className={`tool-icon ${running ? 'spin' : ''}`}>
          <Icon name={running ? 'refresh' : t.status === 'error' ? 'x' : t.status === 'denied' ? 'shield' : icon} size={13} />
        </span>
        <span className="tool-verb">{isMesh ? meshLabel(t) : toolVerb(t)}</span>
        {!isMesh && (
          <span
            className={`tool-target mono ${file ? 'link' : ''}`}
            title={file || target}
            onClick={(e) => {
              if (!file) return
              e.stopPropagation()
              void api.shell.openInEditor(resolvePath(file, cwd))
            }}
          >
            {file ? base(target) : target}
            {file && target !== base(target) && <span className="muted"> {target.slice(0, target.length - base(target).length).replace(/[\\/]$/, '')}</span>}
          </span>
        )}
        {stat}
        {t.status === 'denied' && <span className="badge err">denied</span>}
        {t.status === 'error' && <span className="badge err">error</span>}
        {body && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} style={{ marginLeft: 'auto', color: 'var(--muted)' }} />}
      </div>
      {open && body && <div className="tool-body">{body}</div>}
      {t.permission && <PermissionBar sessionId={sessionId} perm={t.permission} />}
    </div>
  )
})

function meshLabel(t: ToolItem): string {
  const tool = t.name.replace('mcp__deck-mesh__', '')
  const to = str(t.input.to || t.input.peer)
  switch (tool) {
    case 'mesh_send':
      return `Messaged ${to}`
    case 'mesh_reply':
      return 'Replied to a peer'
    case 'mesh_ask':
      return `Asked ${to}`
    case 'mesh_peers':
      return 'Checked who else is working here'
    case 'mesh_claim':
      return `Claimed ${((t.input.paths as string[]) ?? []).join(', ')}`
    case 'mesh_release':
      return 'Released file claims'
    case 'mesh_inbox':
      return 'Read team messages'
    case 'board_add':
      return 'Added tasks to the team board'
    case 'board_take':
      return 'Took a board task'
    case 'board_update':
      return `Updated task ${str(t.input.id)}`
    case 'board_list':
      return 'Checked the team board'
    case 'notes_set':
      return `Wrote team note “${str(t.input.key)}”`
    case 'notes_get':
      return 'Read team notes'
    case 'mesh_wait':
      return `Waiting for ${to}`
    case 'read_terminal':
      return `Read terminal ${str(t.input.target)}`
    default:
      return tool
  }
}

function tryPartial(partial: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(partial)
  if (!m) return ''
  try {
    return JSON.parse(`"${m[1]}"`)
  } catch {
    return m[1].replace(/\\n/g, '\n')
  }
}

// ---------------------------------------------------------------- permission
function suggestionLabel(perm: PermissionRequest): string | undefined {
  if (perm.sessionApproval) return 'Allow for this session'
  const s = perm.suggestions?.[0] as { type?: string; mode?: string; rules?: { toolName?: string; ruleContent?: string }[]; destination?: string } | undefined
  if (!s) return undefined
  if (s.type === 'setMode' && s.mode === 'acceptEdits') return 'Allow all edits this session'
  if (s.type === 'setMode') return `Switch to ${s.mode} mode`
  if (s.type === 'addRules' && s.rules?.[0]) {
    const r = s.rules[0]
    return `Always allow ${r.toolName}${r.ruleContent ? `(${r.ruleContent})` : ''}${s.destination === 'session' ? ' this session' : ''}`
  }
  return 'Always allow'
}

export function PermissionBar({ sessionId, perm }: { sessionId: string; perm: PermissionRequest }) {
  const [feedback, setFeedback] = useState<string | null>(null)
  if (perm.status !== 'pending')
    return (
      <div className={`perm-done ${perm.status}`}>
        <Icon name={perm.status === 'allowed' ? 'check' : 'x'} size={12} /> {perm.status === 'allowed' ? 'Allowed' : 'Denied'}
      </div>
    )
  const respond = (allow: boolean, always?: boolean, message?: string): void => void api.chat.permission(sessionId, perm.requestId, { allow, always, message })
  const always = suggestionLabel(perm)
  return (
    <div className="perm-bar">
      <div className="perm-q">
        <Icon name="shield" size={14} /> Allow Claude to {perm.toolName === 'Bash' || perm.toolName === 'PowerShell' ? 'run this command' : perm.toolName.startsWith('mcp__') ? `use ${perm.toolName.split('__').pop()}` : `use ${perm.toolName}`}
        {perm.description ? <span className="muted"> — {perm.description}</span> : null}?
      </div>
      {feedback === null ? (
        <div className="perm-actions">
          <button className="btn sm primary" autoFocus onClick={() => respond(true)}>
            Allow
          </button>
          {always && (
            <button className="btn sm" onClick={() => respond(true, true)}>
              {always}
            </button>
          )}
          <button className="btn sm" onClick={() => respond(false)}>
            Deny
          </button>
          <button className="btn sm ghost" onClick={() => setFeedback('')}>
            Deny with feedback…
          </button>
          {/* Switching mode also approves every waiting prompt the new mode covers (see setPermissionMode). */}
          {EDIT_TOOLS.has(perm.toolName) && (
            <button className="btn sm ghost" title="Switch to Accept edits — approves this and any further edits" onClick={() => void api.chat.setMode(sessionId, 'acceptEdits')}>
              Accept all edits
            </button>
          )}
          <button className="btn sm ghost danger" title="Switch to Bypass permissions — approves this and everything after it" onClick={() => void api.chat.setMode(sessionId, 'bypassPermissions')}>
            Bypass from here
          </button>
        </div>
      ) : (
        <div className="perm-actions">
          <input className="input" autoFocus placeholder="Tell Claude what to do instead" value={feedback} onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && respond(false, false, feedback)} />
          <button className="btn sm primary" onClick={() => respond(false, false, feedback)}>
            Send
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- AskUserQuestion
interface Question {
  question: string
  header?: string
  options: { label: string; description?: string }[]
  multiSelect?: boolean
}

function QuestionCard({ item: t, sessionId }: { item: ToolItem; sessionId: string }) {
  const questions = (t.input.questions as Question[]) ?? []
  const pending = t.permission?.status === 'pending'
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})
  const answered = (t.result ?? '').match(/"([^"]+)"="([^"]*)"/g)?.map((x) => x.split('"="')[1]?.replace(/"$/, '')) ?? []
  const submit = (): void => {
    if (!t.permission) return
    const out: Record<string, string> = {}
    for (const q of questions) {
      const picks = [...(answers[q.question] ?? []), ...(other[q.question]?.trim() ? [other[q.question].trim()] : [])]
      out[q.question] = picks.join(', ')
    }
    void api.chat.permission(sessionId, t.permission.requestId, { allow: true, updatedInput: { ...t.input, answers: out } })
  }
  const complete = questions.every((q) => (answers[q.question]?.length ?? 0) > 0 || other[q.question]?.trim())
  return (
    <div className={`question-card ${pending ? 'pending' : ''}`}>
      {questions.map((q, qi) => (
        <div key={qi} className="q-block">
          {q.header && <div className="q-header">{q.header}</div>}
          <div className="q-text">{q.question}</div>
          <div className="q-options">
            {q.options.map((o) => {
              const on = (answers[q.question] ?? []).includes(o.label) || (!pending && answered[qi] === o.label)
              return (
                <button
                  key={o.label}
                  className={`q-opt ${on ? 'on' : ''}`}
                  disabled={!pending}
                  onClick={() =>
                    setAnswers((a) => {
                      const cur = a[q.question] ?? []
                      return { ...a, [q.question]: q.multiSelect ? (cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label]) : [o.label] }
                    })
                  }
                >
                  <b>{o.label}</b>
                  {o.description && <span>{o.description}</span>}
                </button>
              )
            })}
          </div>
          {pending && <input className="input" placeholder="Other…" value={other[q.question] ?? ''} onChange={(e) => setOther((x) => ({ ...x, [q.question]: e.target.value }))} />}
        </div>
      ))}
      {pending ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn sm ghost" onClick={() => t.permission && api.chat.permission(sessionId, t.permission.requestId, { allow: false, message: 'The user skipped these questions.' })}>
            Skip
          </button>
          <button className="btn sm primary" disabled={!complete} onClick={submit}>
            Answer
          </button>
        </div>
      ) : (
        t.result && <div className="muted" style={{ fontSize: 12 }}>Answered</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- ExitPlanMode
function PlanCard({ item: t, sessionId, cwd, dark }: { item: ToolItem; sessionId: string; cwd: string; dark: boolean }) {
  const pending = t.permission?.status === 'pending'
  const [fb, setFb] = useState<string | null>(null)
  const approve = (mode?: string): void => {
    if (!t.permission) return
    void api.chat.permission(sessionId, t.permission.requestId, { allow: true })
    if (mode) setTimeout(() => void api.chat.setMode(sessionId, mode), 300)
  }
  return (
    <div className={`plan-card ${pending ? 'pending' : ''}`}>
      <div className="plan-head">
        <Icon name="list" size={14} /> Plan
        {!pending && t.permission && <span className={`badge ${t.permission.status === 'allowed' ? 'ok' : 'err'}`}>{t.permission.status === 'allowed' ? 'approved' : 'changes requested'}</span>}
      </div>
      <Markdown text={str(t.input.plan)} cwd={cwd} dark={dark} />
      {pending &&
        (fb === null ? (
          <div className="row" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn sm ghost" onClick={() => setFb('')}>
              Keep planning…
            </button>
            <button className="btn sm" onClick={() => approve('default')}>
              Approve, ask before edits
            </button>
            <button className="btn sm primary" onClick={() => approve('acceptEdits')}>
              Approve & auto-accept edits
            </button>
          </div>
        ) : (
          <div className="row">
            <input className="input" autoFocus placeholder="What should change in the plan?" value={fb} onChange={(e) => setFb(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && t.permission && api.chat.permission(sessionId, t.permission.requestId, { allow: false, message: fb })} />
            <button className="btn sm primary" onClick={() => t.permission && api.chat.permission(sessionId, t.permission.requestId, { allow: false, message: fb || 'Keep planning.' })}>
              Send
            </button>
          </div>
        ))}
    </div>
  )
}

// ---------------------------------------------------------------- TodoWrite (Claude) / turn plan (Codex)
/** The agent's to-do list for the work: each step and where it stands. */
function TodoCard({ item: t }: { item: ToolItem }) {
  const todos = (Array.isArray(t.input.todos) ? t.input.todos : []) as { content?: string; activeForm?: string; status?: string }[]
  const done = todos.filter((x) => x.status === 'completed').length
  return (
    <div className="todo-card" data-testid="todo-card">
      <div className="todo-head">
        <Icon name="list" size={13} />
        <span className="grow">To-do</span>
        <span className="muted">
          {done}/{todos.length}
        </span>
      </div>
      {typeof t.input.explanation === 'string' && t.input.explanation && <div className="muted todo-note">{t.input.explanation}</div>}
      {todos.map((x, i) => (
        <div key={i} className={`todo-row ${x.status ?? 'pending'}`}>
          <span className="todo-box">{x.status === 'completed' ? <Icon name="check" size={11} /> : x.status === 'in_progress' ? <span className="dot working" /> : null}</span>
          <span className="grow">{x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- Codex plan (plan mode)
/**
 * Codex's plan from plan mode. Codex doesn't ask for approval of a plan (Claude's ExitPlanMode does),
 * so approving here switches the chat to workspace edits and asks it to implement the plan.
 */
function CodexPlanCard({ item: t, sessionId, cwd, dark }: { item: ToolItem; sessionId: string; cwd: string; dark: boolean }) {
  const [started, setStarted] = useState(false)
  const streaming = t.status === 'running'
  const implement = async (): Promise<void> => {
    setStarted(true)
    await api.chat.setMode(sessionId, 'acceptEdits')
    await api.session.sendPrompt(sessionId, 'Implement the plan above.')
  }
  return (
    <div className={`plan-card ${!streaming && !started ? 'pending' : ''}`} data-testid="codex-plan">
      <div className="plan-head">
        <Icon name="list" size={14} />
        <span className="grow">{streaming ? 'Planning…' : 'Plan'}</span>
      </div>
      <Markdown text={String(t.input.plan ?? '')} streaming={streaming} cwd={cwd} dark={dark} />
      {!streaming && (
        <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
          {started ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Implementing (switched to workspace edits)
            </span>
          ) : (
            <button className="btn sm primary" onClick={() => void implement()}>
              Implement this plan
            </button>
          )}
        </div>
      )}
    </div>
  )
}
