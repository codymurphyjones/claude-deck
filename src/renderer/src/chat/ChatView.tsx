import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatItem } from '@shared/chat'
import type { LiveSession } from '../api'
import { api } from '../api'
import { Icon } from '../components/Icon'
import { openMenu } from '../components/ui'
import { useFind } from '../components/FindBar'
import { toast, useStore } from '../store'
import { resolveTheme } from '../theme'
import { ensureChat, useChat } from './chatStore'
import { ChatComposer } from './ChatComposer'
import { Markdown } from './Markdown'
import { selectionToMarkdown } from './selectionMarkdown'
import { summarizeTools, ToolCard, type ToolItem } from './ToolCards'

type Block =
  | { type: 'user'; item: Extract<ChatItem, { kind: 'user' }> }
  | { type: 'text'; item: Extract<ChatItem, { kind: 'text' }> }
  | { type: 'thinking'; item: Extract<ChatItem, { kind: 'thinking' }> }
  | { type: 'tools'; id: string; tools: ToolItem[]; thinking: Extract<ChatItem, { kind: 'thinking' }>[] }
  | { type: 'special'; item: ToolItem }
  | { type: 'notice'; item: Extract<ChatItem, { kind: 'notice' }> }
  | { type: 'turn'; item: Extract<ChatItem, { kind: 'turn' }> }

const SPECIAL = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** Group the flat item stream into display blocks: consecutive tool calls become one activity group. */
function buildBlocks(items: ChatItem[]): { blocks: Block[]; children: Map<string, ChatItem[]> } {
  const children = new Map<string, ChatItem[]>()
  const blocks: Block[] = []
  let group: Extract<Block, { type: 'tools' }> | null = null
  for (const it of items) {
    if ('parent' in it && it.parent) {
      const list = children.get(it.parent) ?? []
      list.push(it)
      children.set(it.parent, list)
      continue
    }
    if (it.kind === 'tool' && !SPECIAL.has(it.name)) {
      if (!group) {
        group = { type: 'tools', id: `g-${it.id}`, tools: [], thinking: [] }
        blocks.push(group)
      }
      group.tools.push(it)
      continue
    }
    if (it.kind === 'thinking' && group) {
      group.thinking.push(it)
      continue
    }
    group = null
    if (it.kind === 'tool') blocks.push({ type: 'special', item: it })
    else if (it.kind === 'user') blocks.push({ type: 'user', item: it })
    else if (it.kind === 'text') blocks.push({ type: 'text', item: it })
    else if (it.kind === 'thinking') blocks.push({ type: 'thinking', item: it })
    else if (it.kind === 'notice') blocks.push({ type: 'notice', item: it })
    else if (it.kind === 'turn') blocks.push({ type: 'turn', item: it })
  }
  return { blocks, children }
}

const sameList = (a?: readonly unknown[], b?: readonly unknown[]): boolean => a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]))

/**
 * Blocks and the children map are rebuilt on every op, so compare what a block actually shows:
 * its items (by identity) and their subagent children. Unchanged blocks then skip rendering.
 */
function sameBlock(a: Block, b: Block, ca: Map<string, ChatItem[]>, cb: Map<string, ChatItem[]>): boolean {
  if (a.type === 'tools' || b.type === 'tools') {
    if (a.type !== 'tools' || b.type !== 'tools') return false
    return sameList(a.tools, b.tools) && sameList(a.thinking, b.thinking) && a.tools.every((t) => sameList(ca.get(t.id), cb.get(t.id)))
  }
  return a.type === b.type && a.item === b.item && (a.type !== 'special' || sameList(ca.get(a.item.id), cb.get(b.item.id)))
}

type BlockProps = {
  block: Block
  session: LiveSession
  dark: boolean
  children: Map<string, ChatItem[]>
  thinkingMode: 'collapsed' | 'expanded' | 'hidden'
  toolsMode: 'grouped' | 'expanded'
  isLast: boolean
  busy: boolean
}

const sameBlockProps = (p: BlockProps, n: BlockProps): boolean =>
  p.session === n.session &&
  p.dark === n.dark &&
  p.thinkingMode === n.thinkingMode &&
  p.toolsMode === n.toolsMode &&
  p.isLast === n.isLast &&
  p.busy === n.busy &&
  sameBlock(p.block, n.block, p.children, n.children)

const fmtDur =(ms?: number): string => (!ms ? '' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`)
const fmtTok = (n?: number): string => (!n ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function ChatView({ session: s }: { session: LiveSession }) {
  const chat = useChat((st) => st[s.id])
  const settings = useStore((st) => st.settings)
  const dark = useStore((st) => resolveTheme(st.settings, st.systemDark).dark)
  const scrollRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const cfg = settings.chat
  const find = useFind({ searchRoot: () => scrollRef.current })

  useEffect(() => {
    void ensureChat(s.id)
  }, [s.id])

  const items = chat?.items ?? []
  const { blocks, children } = useMemo(() => buildBlocks(items), [items])
  const busy = !!chat?.meta.busy
  const last = items[items.length - 1]
  const streamingText = last?.kind === 'text' && last.streaming

  // Stick to the bottom while new content streams in, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    stick.current = atBottom
    setShowJump(!atBottom)
  }

  const jump = (): void => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    stick.current = true
    setShowJump(false)
  }

  const onContextMenu = (e: React.MouseEvent): void => {
    const sel = window.getSelection()
    const el = scrollRef.current
    if (!sel || sel.isCollapsed || !el || !sel.rangeCount || !sel.getRangeAt(0).intersectsNode(el)) return
    const text = sel.toString()
    if (!text.trim()) return
    // Convert now: clicking the menu can collapse the selection.
    const markdown = selectionToMarkdown(sel)
    const copy = (t: string, what: string): void => void api.clipboard.writeText(t).then(() => toast(`${what} copied`, 'success'))
    openMenu(e, [
      { label: 'Copy', icon: 'copy', hint: 'Ctrl+C', onClick: () => copy(text, 'Text') },
      { label: 'Copy as Markdown', icon: 'code', disabled: !markdown, onClick: () => copy(markdown, 'Markdown') }
    ])
  }

  return (
    <div ref={find.scope} className={`chat density-${cfg.density} width-${cfg.width}`} style={{ ['--chat-size' as string]: `${cfg.fontSize}px` }}>
      {find.bar}
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll} onContextMenu={onContextMenu}>
        <div className="chat-col">
          {!chat?.ready && <div className="chat-loading">Loading conversation…</div>}
          {chat?.ready && !items.length && <ChatEmpty session={s} />}
          {blocks.map((b, i) => (
            <BlockView key={'item' in b ? b.item.id : b.id} block={b} session={s} dark={dark} children={children} thinkingMode={cfg.thinking} toolsMode={cfg.tools} isLast={i === blocks.length - 1} busy={i === blocks.length - 1 && busy} />
          ))}
          {busy && !streamingText && <WorkingIndicator session={s} />}
          {s.status === 'exited' && (
            <div className="chat-ended">
              <Icon name="stop" size={14} /> Session ended{s.exitCode ? ` (code ${s.exitCode})` : ''}.
              <button className="btn sm primary" onClick={() => api.session.restart(s.id)}>
                <Icon name="refresh" size={12} /> Resume
              </button>
            </div>
          )}
          {s.status === 'waiting-auth' && (
            <div className="chat-ended">
              <Icon name="lock" size={14} /> Waiting for sign-in — this session starts automatically once you're signed in.
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button className="jump-latest" onClick={jump}>
          <Icon name="chevron-down" size={14} /> Latest
        </button>
      )}
      <ChatComposer session={s} meta={chat?.meta} />
    </div>
  )
}

const BlockView = memo(function BlockView({
  block: b,
  session: s,
  dark,
  children,
  thinkingMode,
  toolsMode,
  isLast,
  busy
}: BlockProps) {
  switch (b.type) {
    case 'user':
      return <UserMessage item={b.item} cwd={s.cwd} dark={dark} />
    case 'text':
      return (
        <div className="msg-assistant">
          <Markdown text={b.item.text} streaming={b.item.streaming} cwd={s.cwd} dark={dark} />
          {!b.item.streaming && (
            <div className="msg-actions">
              <button className="icon-btn sm" title="Copy markdown" onClick={() => api.clipboard.writeText(b.item.text)}>
                <Icon name="copy" size={12} />
              </button>
            </div>
          )}
        </div>
      )
    case 'thinking':
      return thinkingMode === 'hidden' ? null : <Thinking item={b.item} defaultOpen={thinkingMode === 'expanded'} cwd={s.cwd} dark={dark} />
    case 'tools':
      return <ToolGroup group={b} session={s} dark={dark} children={children} expanded={toolsMode === 'expanded'} active={isLast && busy} thinkingMode={thinkingMode} />
    case 'special':
      return <ToolCard item={b.item} cwd={s.cwd} dark={dark} sessionId={s.id} />
    case 'notice':
      return (
        <div className={`chat-notice ${b.item.level}`}>
          <Icon name={b.item.level === 'error' ? 'x' : b.item.level === 'mesh' ? 'users' : b.item.level === 'warn' ? 'hand' : 'bell'} size={12} />
          <span style={{ whiteSpace: 'pre-wrap' }}>{b.item.text}</span>
        </div>
      )
    case 'turn':
      return (
        <div className={`turn-footer ${b.item.error ? 'err' : ''}`}>
          {b.item.error ? <Icon name="x" size={11} /> : <Icon name="check" size={11} />}
          {b.item.error && <span>{b.item.error}</span>}
          {fmtDur(b.item.durationMs) && <span>{fmtDur(b.item.durationMs)}</span>}
          {b.item.inputTokens ? <span>{fmtTok(b.item.inputTokens)} in</span> : null}
          {b.item.outputTokens ? <span>{fmtTok(b.item.outputTokens)} out</span> : null}
        </div>
      )
  }
}, sameBlockProps)

function UserMessage({ item, cwd, dark }: { item: Extract<ChatItem, { kind: 'user' }>; cwd: string; dark: boolean }) {
  if (item.injected) {
    const fromMesh = item.text.startsWith('[Claude Deck mesh]')
    return (
      <div className="msg-injected">
        <Icon name={fromMesh ? 'users' : 'clock'} size={12} />
        <div className="grow">
          <Markdown text={item.text.replace(/^\[(Claude Deck mesh|Claude Deck|Scheduled[^\]]*)\]\s*/, '')} cwd={cwd} dark={dark} />
        </div>
      </div>
    )
  }
  return (
    <div className={`msg-user ${item.queued ? 'queued' : ''}`}>
      {item.images?.length ? (
        <div className="msg-images">
          {item.images.map((src, i) => (
            <img key={i} src={src} />
          ))}
        </div>
      ) : null}
      <div className="msg-user-text">{item.text}</div>
      {item.queued && <div className="queued-tag">Queued — sends when Claude finishes the current step</div>}
    </div>
  )
}

function Thinking({ item, defaultOpen, cwd, dark }: { item: Extract<ChatItem, { kind: 'thinking' }>; defaultOpen: boolean; cwd: string; dark: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!item.text && !item.streaming) return null
  return (
    <div className={`thinking ${item.streaming ? 'live' : ''}`}>
      <button className="thinking-head" onClick={() => setOpen(!open)}>
        <Icon name="sparkles" size={12} /> {item.streaming ? 'Thinking…' : 'Thought process'}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
      </button>
      {open && item.text && (
        <div className="thinking-body">
          <Markdown text={item.text} streaming={item.streaming} cwd={cwd} dark={dark} />
        </div>
      )}
    </div>
  )
}

function ToolGroup({
  group,
  session: s,
  dark,
  children,
  expanded,
  active,
  thinkingMode
}: {
  group: Extract<Block, { type: 'tools' }>
  session: LiveSession
  dark: boolean
  children: Map<string, ChatItem[]>
  expanded: boolean
  active: boolean
  thinkingMode: 'collapsed' | 'expanded' | 'hidden'
}) {
  const hasPending = group.tools.some((t) => t.permission?.status === 'pending')
  const running = group.tools.some((t) => t.status === 'running' || t.status === 'streaming')
  const [open, setOpen] = useState(expanded || active)
  const wasActive = useRef(active)
  useEffect(() => {
    // Expand while Claude works; collapse into a summary once the step is done.
    if (active || hasPending) setOpen(true)
    else if (wasActive.current && !expanded) setOpen(false)
    wasActive.current = active
  }, [active, hasPending, expanded])
  const edits = group.tools.filter((t) => ['Edit', 'MultiEdit', 'Write'].includes(t.name))
  const errors = group.tools.filter((t) => t.status === 'error' || t.status === 'denied').length
  return (
    <div className={`tool-group ${open ? 'open' : ''} ${hasPending ? 'pending' : ''}`}>
      <button className="tool-group-head" onClick={() => setOpen(!open)}>
        <span className={`tg-dot ${running ? 'running' : errors ? 'err' : 'ok'}`} />
        <span className="tg-summary">{summarizeTools(group.tools)}</span>
        {errors > 0 && <span className="badge err">{errors} failed</span>}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} style={{ color: 'var(--muted)', marginLeft: 'auto' }} />
      </button>
      {open ? (
        <div className="tool-group-body">
          {thinkingMode !== 'hidden' &&
            group.thinking.map((th) => <Thinking key={th.id} item={th} defaultOpen={thinkingMode === 'expanded'} cwd={s.cwd} dark={dark} />)}
          {group.tools.map((t) => (
            <ToolCard key={t.id} item={t} cwd={s.cwd} dark={dark} sessionId={s.id} childrenItems={children.get(t.id)} />
          ))}
        </div>
      ) : (
        edits.length > 0 && (
          <div className="tg-files">
            {edits.map((t) => (
              <Fragment key={t.id}>
                <span className="tg-file mono">{String(t.input.file_path ?? '').split(/[\\/]/).pop()}</span>
              </Fragment>
            ))}
          </div>
        )
      )}
    </div>
  )
}

function WorkingIndicator({ session: s }: { session: LiveSession }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const since = Math.max(0, Math.round((now - (s.lastActivity || now)) / 1000))
  return (
    <div className="working">
      <span className="working-orb" />
      <span className="shimmer">{s.status === 'needs-input' ? 'Waiting for you' : 'Claude is working'}</span>
      <span className="muted">{since > 2 ? `${since}s` : ''}</span>
    </div>
  )
}

function ChatEmpty({ session: s }: { session: LiveSession }) {
  const ideas = [
    ['Explain this codebase', 'Give me a concise tour of this codebase: architecture, key modules, and how data flows. Include a mermaid diagram.'],
    ['Find bugs', 'Look for likely bugs or risky code in this project and rank them by severity.'],
    ['Write tests', 'Find the least-tested important code here and write good tests for it.'],
    ['Plan a feature', 'I want to add a feature. Interview me briefly, then propose a plan.']
  ]
  return (
    <div className="chat-empty">
      <span className="brand-mark" style={{ width: 42, height: 42, borderRadius: 12 }}>
        <Icon name="sparkles" size={22} />
      </span>
      <h2>What should we build in {s.cwd.split(/[\\/]/).pop()}?</h2>
      <div className="chat-ideas">
        {ideas.map(([t, p]) => (
          <button key={t} className="idea" onClick={() => api.chat.send(s.id, p)}>
            <b>{t}</b>
            <span>{p}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
