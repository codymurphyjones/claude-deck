import { useEffect, useRef, useState } from 'react'
import { api, type LiveSession } from '../api'
import { activeSession, askText, focusSessionTab, set, toast, useStore, type RightPanel as Panel } from '../store'
import { browserUrl } from '@shared/agentTools'
import { registerBrowser } from '../browserControl'
import { FilesPanel } from './FilesPanel'
import { Icon } from './Icon'
import { ReviewPane } from './ReviewPane'
import { TeamPanel } from './TeamPanel'
import { Seg } from './ui'

const TITLES: Record<Exclude<Panel, null>, [string, string]> = {
  review: ['Review', 'branch'],
  files: ['Files', 'file'],
  team: ['Team', 'users'],
  browser: ['Browser', 'globe'],
  timeline: ['Timeline', 'activity']
}

export function RightPanel({ panel }: { panel: Exclude<Panel, null> }) {
  const width = useStore((s) => s.rightWidth)
  const session = useStore(() => activeSession())
  // A chat's terminal pane (e.g. a worktree's setup shell) counts as the chat.
  const parent = useStore((s) => (session?.kind === 'shell' && session.launch.parentId ? s.sessions[session.launch.parentId] : undefined))
  const owner = parent ?? session
  const agentSession = owner?.kind === 'agent' ? owner : undefined
  const startDrag = (e: React.MouseEvent): void => {
    const x0 = e.clientX
    const w0 = width
    const move = (ev: MouseEvent): void => set({ rightWidth: Math.max(300, Math.min(window.innerWidth - 400, w0 - (ev.clientX - x0))) })
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const [title, icon] = TITLES[panel]
  return (
    <div className="right" style={{ width }}>
      <div className="resizer left" onMouseDown={startDrag} />
      <div className="right-head">
        <Icon name={icon} size={15} style={{ color: 'var(--accent)' }} />
        <span className="grow ellipsis">
          {title}
          {agentSession && panel !== 'timeline' && <span className="muted" style={{ fontWeight: 400 }}> · {agentSession.name}</span>}
        </span>
        {(Object.keys(TITLES) as Exclude<Panel, null>[])
          .filter((p) => p !== panel)
          .map((p) => (
            <button key={p} className="icon-btn sm" title={TITLES[p][0]} onClick={() => set({ rightPanel: p })}>
              <Icon name={TITLES[p][1]} size={14} />
            </button>
          ))}
        <button className="icon-btn sm" title="Close panel" onClick={() => set({ rightPanel: null })}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="right-body">
        {panel === 'review' && <ReviewPane session={agentSession} />}
        {panel === 'files' && <FilesPanel session={agentSession} />}
        {panel === 'team' && <TeamPanel session={agentSession} />}
        {panel === 'browser' && <BrowserPane session={agentSession} />}
        {panel === 'timeline' && <TimelinePanel />}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ browser
type WebviewEl = HTMLElement & {
  src: string
  getURL: () => string
  loadURL: (url: string) => Promise<void>
  goBack: () => void
  goForward: () => void
  reload: () => void
  canGoBack: () => boolean
  executeJavaScript: (code: string) => Promise<unknown>
  getWebContentsId: () => number
}

const PICKER = `(() => new Promise((resolve) => {
  const box = document.createElement('div');
  Object.assign(box.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', border: '2px solid #d97757', background: 'rgba(217,119,87,.12)', borderRadius: '3px', transition: 'all .05s' });
  document.body.appendChild(box);
  let cur = null;
  const sel = (el) => { if (!el || el === document.body) return 'body'; if (el.id) return '#' + CSS.escape(el.id); const p = el.parentElement; const tag = el.tagName.toLowerCase(); const cls = [...el.classList].slice(0,2).map(c => '.' + CSS.escape(c)).join(''); const idx = p ? [...p.children].filter(c => c.tagName === el.tagName).indexOf(el) : 0; return (p ? sel(p) + ' > ' : '') + tag + cls + (idx > 0 ? ':nth-of-type(' + (idx+1) + ')' : ''); };
  const move = (e) => { cur = e.target; const r = cur.getBoundingClientRect(); Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' }); };
  const done = (e) => { e.preventDefault(); e.stopPropagation(); cleanup(); const r = cur.getBoundingClientRect(); resolve({ selector: sel(cur), text: (cur.innerText || '').slice(0, 300), html: cur.outerHTML.slice(0, 600), rect: { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.top)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) } }); };
  const esc = (e) => { if (e.key === 'Escape') { cleanup(); resolve(null); } };
  const cleanup = () => { box.remove(); document.removeEventListener('mousemove', move, true); document.removeEventListener('click', done, true); document.removeEventListener('keydown', esc, true); };
  document.addEventListener('mousemove', move, true); document.addEventListener('click', done, true); document.addEventListener('keydown', esc, true);
}))()`

function BrowserPane({ session }: { session?: LiveSession }) {
  // The webview's `src` is only its first page; later pages load with loadURL(), which (unlike
  // re-setting `src`) also reloads when asked for the page that's already showing.
  const [initialUrl] = useState(() => localStorageGet('deck:browserUrl') ?? 'http://localhost:3000')
  const [input, setInput] = useState(initialUrl)
  const [picking, setPicking] = useState(false)
  const ref = useRef<WebviewEl | null>(null)
  /** Resolves once the webview can take loadURL() (after its first dom-ready). */
  const ready = useRef<Promise<void> | null>(null)
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    ready.current = new Promise((resolve) => wv.addEventListener('dom-ready', () => resolve(), { once: true }))
    const onNav = (): void => {
      setInput(wv.getURL())
      localStorageSet('deck:browserUrl', wv.getURL())
    }
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNav)
    return () => {
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNav)
    }
  }, [])
  /** Load typed input (scheme-less hosts get http/https); resolves when it has loaded or failed. */
  const go = async (u: string): Promise<void> => {
    const wv = ref.current
    if (!wv) return
    const full = browserUrl(u)
    setInput(full)
    await ready.current
    // Rejects on load failures (and ERR_ABORTED when a redirect supersedes it); the page shows them.
    await wv.loadURL(full).catch(() => undefined)
  }

  // Console output since the last navigation, and a handle for the agent's open_browser tool.
  const consoleLog = useRef<string[]>([])
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const LEVEL = ['log', 'warning', 'error', 'debug']
    const onConsole = (e: Event): void => {
      const c = e as Event & { level: number | string; message: string; line?: number; sourceId?: string }
      const level = typeof c.level === 'number' ? (LEVEL[c.level] ?? 'log') : c.level
      const where = c.sourceId ? ` (${c.sourceId.split('/').pop()}${c.line ? `:${c.line}` : ''})` : ''
      consoleLog.current = [...consoleLog.current, `[${level}] ${c.message}${where}`].slice(-200)
    }
    const onStart = (): void => {
      consoleLog.current = []
    }
    wv.addEventListener('console-message', onConsole)
    wv.addEventListener('did-start-navigation', onStart)
    const off = registerBrowser({
      url: () => wv.getURL(),
      navigate: (u) => Promise.race([go(u), new Promise<void>((resolve) => setTimeout(resolve, 20_000))]),
      text: async () => String(await wv.executeJavaScript(`document.title + '\\n\\n' + (document.body ? document.body.innerText : '')`).catch((e) => `Could not read the page: ${e}`)),
      console: () => consoleLog.current,
      screenshot: async () => {
        const r = wv.getBoundingClientRect()
        return api.window.capturePageRegion(wv.getWebContentsId(), { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) })
      }
    })
    return () => {
      off()
      wv.removeEventListener('console-message', onConsole)
      wv.removeEventListener('did-start-navigation', onStart)
    }
  }, [])
  const comment = async (): Promise<void> => {
    const wv = ref.current
    if (!wv || !session) return toast('Open a Claude session to send comments to', 'error')
    setPicking(true)
    const picked = (await wv.executeJavaScript(PICKER).catch(() => null)) as null | { selector: string; text: string; html: string; rect: { x: number; y: number; width: number; height: number } }
    setPicking(false)
    if (!picked) return
    const note = await askText('Comment for Claude about this element', '', { multiline: true, placeholder: 'e.g. Make this button match the primary style and fix the misaligned icon' })
    if (!note) return
    let shot = ''
    try {
      shot = await api.window.capturePageRegion(wv.getWebContentsId(), picked.rect)
    } catch {
      /* screenshot optional */
    }
    const prompt = `Feedback on the page ${wv.getURL()}:\nElement: \`${picked.selector}\`${picked.text ? `\nVisible text: "${picked.text.replace(/\s+/g, ' ').slice(0, 200)}"` : ''}\nHTML: ${picked.html.replace(/\s+/g, ' ').slice(0, 400)}${shot ? `\nScreenshot of the element: ${shot}` : ''}\n\n${note}`
    await api.session.sendPrompt(session.id, prompt)
    toast('Comment sent to Claude', 'success')
  }
  const screenshot = async (): Promise<void> => {
    const wv = ref.current
    if (!wv || !session) return
    const r = wv.getBoundingClientRect()
    const file = await api.window.capturePageRegion(wv.getWebContentsId(), { x: 0, y: 0, width: Math.round(r.width), height: Math.round(r.height) })
    await api.session.sendPrompt(session.id, `Here is a screenshot of ${wv.getURL()}: ${file}\n\n`, 'steer')
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="row" style={{ padding: 6, gap: 4, borderBottom: '1px solid var(--border)' }}>
        <button className="icon-btn sm" onClick={() => ref.current?.goBack()}>
          <Icon name="chevron-left" size={14} />
        </button>
        <button className="icon-btn sm" onClick={() => ref.current?.goForward()}>
          <Icon name="chevron-right" size={14} />
        </button>
        <button className="icon-btn sm" onClick={() => ref.current?.reload()}>
          <Icon name="refresh" size={14} />
        </button>
        <input className="input" style={{ height: 26 }} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go(input)} />
        <button className={`icon-btn sm ${picking ? 'on' : ''}`} title="Comment on an element (sends selector + screenshot to Claude)" onClick={comment}>
          <Icon name="crosshair" size={14} />
        </button>
        <button className="icon-btn sm" title="Send a screenshot to Claude" onClick={screenshot}>
          <Icon name="image" size={14} />
        </button>
        <button className="icon-btn sm" title="Open in your browser" onClick={() => api.shell.openExternal(ref.current?.getURL() || browserUrl(input))}>
          <Icon name="external" size={14} />
        </button>
      </div>
      <webview ref={ref as never} src={initialUrl} style={{ flex: 1, background: '#fff' }} partition="persist:deck-preview" />
    </div>
  )
}

function localStorageGet(k: string): string | undefined {
  try {
    return localStorage.getItem(k) ?? undefined
  } catch {
    return undefined
  }
}
function localStorageSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}

// ------------------------------------------------------------------ timeline
function TimelinePanel() {
  const events = useStore((s) => s.timeline)
  const [filter, setFilter] = useState<'all' | 'prompts' | 'edits' | 'agent' | 'mesh' | 'attention'>('all')
  const list = [...events]
    .reverse()
    .filter((e) =>
      filter === 'all'
        ? true
        : filter === 'prompts'
          ? e.type === 'prompt' || e.type === 'stop'
          : filter === 'edits'
            ? e.type === 'edit' || e.type === 'tool'
            : filter === 'agent'
              ? e.type === 'agent'
            : filter === 'mesh'
              ? e.type === 'mesh'
              : e.type === 'permission'
    )
    .slice(0, 400)
  const icon: Record<string, string> = { prompt: 'message', tool: 'terminal', edit: 'edit', permission: 'hand', stop: 'check', mesh: 'users', start: 'play', exit: 'stop', agent: 'sparkles' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
        <Seg
          value={filter}
          onChange={setFilter}
          options={[
            ['all', 'All'],
            ['prompts', 'Turns'],
            ['edits', 'Edits'],
            ['agent', 'AI actions'],
            ['mesh', 'Team'],
            ['attention', 'Attention']
          ]}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {!list.length && <div className="empty-note">Everything your sessions do — prompts, edits, commands, permission requests and team messages — streams here.</div>}
        {list.map((e) => (
          <div key={e.id} className="tl-item" onClick={() => focusSessionTab(e.sessionId)} style={{ cursor: 'var(--cursor)' }}>
            <span className="when">{new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            <Icon name={icon[e.type] ?? 'more'} size={13} style={{ marginTop: 2, color: e.type === 'permission' ? 'var(--warning)' : 'var(--muted)' }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <b>{e.sessionName}</b> <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.text}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
