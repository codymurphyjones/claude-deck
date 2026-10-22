import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { Settings } from '@shared/types'
import { api, bridge } from '../api'

interface Entry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  el: HTMLDivElement
  opened: boolean
  webgl?: WebglAddon
  hydrated: boolean
  pending: string[] | null
  ro?: ResizeObserver
  host?: HTMLElement
  raf?: number
  lastSel: string
}

let currentOptions: { settings: Settings; theme: ITheme } | undefined
const entries = new Map<string, Entry>()

/** Hook for app-level key handling (shortcuts) — returns true if consumed. */
let keyInterceptor: ((e: KeyboardEvent) => boolean) | undefined
export function setKeyInterceptor(fn: (e: KeyboardEvent) => boolean): void {
  keyInterceptor = fn
}

bridge.on('pty:data', (id: string, data: string) => {
  const e = entries.get(id)
  if (!e) return
  if (e.pending) e.pending.push(data)
  else e.term.write(data)
})

bridge.on('term:read', (reqId: string, id: string, lines: number) => {
  void api.session.readResult(reqId, readLines(id, lines) ?? '')
})

async function pasteInto(id: string, term: Terminal): Promise<void> {
  const img = await api.clipboard.readImage()
  if (img) {
    const file = await api.fs.saveTempImage(img)
    term.paste(file + ' ')
    return
  }
  const text = await api.clipboard.readText()
  if (text) term.paste(text)
  void id
}

function create(id: string): Entry {
  const opts = currentOptions
  const el = document.createElement('div')
  el.className = 'xterm-host'
  const term = new Terminal({
    allowProposedApi: true,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontFamily: opts?.settings.codeFont,
    fontSize: opts?.settings.codeFontSize ?? 14,
    lineHeight: 1.2,
    scrollback: opts?.settings.scrollback ?? 10000,
    theme: opts?.theme,
    smoothScrollDuration: 80,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: false,
    minimumContrastRatio: 1,
    windowsPty: { backend: 'conpty' }
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  const uni = new Unicode11Addon()
  term.loadAddon(uni)
  term.unicode.activeVersion = '11'
  term.loadAddon(new WebLinksAddon((_ev, uri) => void api.shell.openExternal(uri)))

  term.onData((d) => bridge.write(id, d))
  term.onBinary((d) => bridge.write(id, d))
  term.onResize(({ cols, rows }) => bridge.resize(id, cols, rows))

  const entry: Entry = { term, fit, search, el, opened: false, hydrated: false, pending: [], lastSel: '' }
  term.onSelectionChange(() => {
    const sel = term.getSelection()
    if (sel && sel !== entry.lastSel && currentOptions?.settings.copyOnSelect) void api.clipboard.writeText(sel)
    entry.lastSel = sel
  })

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    if (keyInterceptor?.(e)) return false
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey
    if (ctrl && e.shiftKey && e.code === 'KeyC') {
      const sel = term.getSelection()
      if (sel) void api.clipboard.writeText(sel)
      return false
    }
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      void api.clipboard.writeText(term.getSelection())
      term.clearSelection()
      return false
    }
    if (ctrl && e.code === 'KeyV') {
      e.preventDefault()
      void pasteInto(id, term)
      return false
    }
    if (e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'Enter') {
      bridge.write(id, '\x1b\r')
      return false
    }
    return true
  })

  el.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    if (term.hasSelection()) {
      void api.clipboard.writeText(term.getSelection())
      term.clearSelection()
    } else void pasteInto(id, term)
  })

  entries.set(id, entry)
  return entry
}

export function ensureTerminal(id: string): Entry {
  return entries.get(id) ?? create(id)
}

/** Load the PTY's scrollback (after a reload or when moving windows), then go live. */
export async function hydrate(id: string): Promise<void> {
  const e = ensureTerminal(id)
  if (e.hydrated) return
  e.hydrated = true
  try {
    const buf = await api.session.buffer(id)
    // Live events queued while waiting were emitted before the snapshot was taken,
    // so they are already contained in it.
    e.pending = null
    if (buf) e.term.write(buf)
  } catch {
    const p = e.pending ?? []
    e.pending = null
    for (const d of p) e.term.write(d)
  }
}

/** Throw away the view and rebuild it from the PTY scrollback (after moving windows). */
export async function rehydrate(id: string): Promise<void> {
  const e = entries.get(id)
  if (!e) return hydrate(id)
  e.term.reset()
  e.hydrated = false
  e.pending = []
  await hydrate(id)
}

function scheduleFit(e: Entry): void {
  if (e.raf) cancelAnimationFrame(e.raf)
  e.raf = requestAnimationFrame(() => {
    e.raf = undefined
    if (!e.host || !e.el.isConnected || e.host.clientWidth < 20 || e.host.clientHeight < 20) return
    try {
      e.fit.fit()
    } catch {
      /* not measurable yet */
    }
  })
}

export function attach(id: string, host: HTMLElement): void {
  const e = ensureTerminal(id)
  if (e.host !== host) {
    e.ro?.disconnect()
    host.appendChild(e.el)
    e.host = host
    e.ro = new ResizeObserver(() => scheduleFit(e))
    e.ro.observe(host)
  }
  if (!e.opened) {
    e.term.open(e.el)
    e.opened = true
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        webgl.dispose()
        e.webgl = undefined
      })
      e.term.loadAddon(webgl)
      e.webgl = webgl
    } catch {
      /* DOM renderer fallback */
    }
  }
  scheduleFit(e)
}

export function detach(id: string, host: HTMLElement): void {
  const e = entries.get(id)
  if (!e || e.host !== host) return
  e.ro?.disconnect()
  e.ro = undefined
  e.host = undefined
}

export function refit(id: string): void {
  const e = entries.get(id)
  if (e) scheduleFit(e)
}

export function focusTerminal(id: string): void {
  entries.get(id)?.term.focus()
}

export function disposeTerminal(id: string): void {
  const e = entries.get(id)
  if (!e) return
  e.ro?.disconnect()
  e.webgl?.dispose()
  e.term.dispose()
  e.el.remove()
  entries.delete(id)
}

export function clearTerminal(id: string): void {
  entries.get(id)?.term.reset()
}

export function searchTerminal(id: string, q: string, dir: 'next' | 'prev' = 'next'): boolean {
  const e = entries.get(id)
  if (!e || !q) return false
  const deco = { matchOverviewRuler: '#d97757', activeMatchColorOverviewRuler: '#ffb86c', matchBackground: '#d9775755', activeMatchBackground: '#ffb86caa' }
  return dir === 'next' ? e.search.findNext(q, { decorations: deco }) : e.search.findPrevious(q, { decorations: deco })
}

export function clearSearch(id: string): void {
  entries.get(id)?.search.clearDecorations()
}

export function readLines(id: string, n: number): string | undefined {
  const e = entries.get(id)
  if (!e) return undefined
  const b = e.term.buffer.active
  const end = b.baseY + b.cursorY
  const out: string[] = []
  for (let i = Math.max(0, end - n + 1); i <= end; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  return out.join('\n').replace(/\n+$/, '')
}

export function getSelection(id: string): string {
  return entries.get(id)?.term.getSelection() ?? ''
}

export function applyTerminalOptions(settings: Settings, theme: ITheme): void {
  currentOptions = { settings, theme }
  for (const e of entries.values()) {
    const o = e.term.options
    if (o.fontFamily !== settings.codeFont) o.fontFamily = settings.codeFont
    if (o.fontSize !== settings.codeFontSize) o.fontSize = settings.codeFontSize
    if (o.scrollback !== settings.scrollback) o.scrollback = settings.scrollback
    o.theme = theme
    scheduleFit(e)
  }
}

export function hasTerminal(id: string): boolean {
  return entries.has(id)
}
