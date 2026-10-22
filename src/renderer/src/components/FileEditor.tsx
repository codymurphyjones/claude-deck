import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorSelection, EditorState, Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab, redo, selectAll, undo } from '@codemirror/commands'
import { findNext, findPrevious, gotoLine, openSearchPanel } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageForPath } from '@shared/languages'
import { extractSymbols, type SymbolInfo, type SymbolKind } from '@shared/symbols'
import { api, bridge, errMsg } from '../api'
import { loadLanguage } from '../cmLanguage'
import { activeSession, askText, set, toast, useStore } from '../store'
import { resolveTheme } from '../theme'
import { Icon } from './Icon'
import { openMenuAt, type MenuItem } from './ui'

// Full-screen text editor over the content area: Notepad's features (file, edit, find/replace,
// go to, time/date, word wrap, zoom, status bar, line endings) plus a symbol outline.

const PREFS_KEY = 'deck.fileEditor'
interface Prefs {
  wrap: boolean
  zoom: number
  status: boolean
  symbols: boolean
}
const DEFAULT_PREFS: Prefs = { wrap: false, zoom: 100, status: true, symbols: true }

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_PREFS
  }
}

const KIND_ICON: Record<SymbolKind, [string, string]> = {
  class: ['C', 'var(--t-yellow)'],
  interface: ['I', 'var(--t-cyan)'],
  type: ['T', 'var(--t-cyan)'],
  enum: ['E', 'var(--t-orange)'],
  function: ['ƒ', 'var(--t-blue)'],
  method: ['m', 'var(--t-blue)'],
  variable: ['v', 'var(--t-magenta)'],
  module: ['M', 'var(--t-green)'],
  heading: ['#', 'var(--accent)'],
  selector: ['{', 'var(--t-orange)'],
  target: ['◎', 'var(--t-green)'],
  key: ['k', 'var(--t-cyan)']
}

const baseName = (p?: string): string => (p ? (p.split(/[\\/]/).pop() ?? p) : 'Untitled')
const isMac = navigator.platform.startsWith('Mac')
const mod = isMac ? '⌘' : 'Ctrl+'

interface DocMeta {
  path?: string
  eol: 'CRLF' | 'LF'
  bom: boolean
}

export function FileEditor() {
  const req = useStore((s) => s.editorFile)
  if (!req) return null
  return <EditorOverlay initialPath={req.path} />
}

function EditorOverlay({ initialPath }: { initialPath?: string }) {
  const dark = useStore((s) => resolveTheme(s.settings, s.systemDark).dark)
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const comps = useRef({ lang: new Compartment(), wrap: new Compartment(), zoom: new Compartment(), theme: new Compartment() })
  const [meta, setMeta] = useState<DocMeta>({ eol: navigator.platform.startsWith('Win') ? 'CRLF' : 'LF', bom: false })
  const metaRef = useRef(meta)
  metaRef.current = meta
  const [dirty, setDirty] = useState(false)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const [stale, setStale] = useState(false)
  const [langName, setLangName] = useState('Plain Text')
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0, chars: 0, lines: 1 })
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [symFilter, setSymFilter] = useState('')
  const [picker, setPicker] = useState(false)

  const updatePrefs = (p: Partial<Prefs>): void =>
    setPrefs((cur) => {
      const next = { ...cur, ...p }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        /* per-viewer convenience only */
      }
      return next
    })

  const refreshSymbols = useCallback(() => {
    const v = view.current
    if (!v) return
    const text = v.state.doc.toString()
    const lang = metaRef.current.path ? languageForPath(metaRef.current.path, text.slice(0, 200).split('\n', 1)[0]) : undefined
    setSymbols(extractSymbols(text, lang))
  }, [])
  const symTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  // ---------------------------------------------------------------- editor setup
  const zoomTheme = (zoom: number) => EditorView.theme({ '&': { fontSize: `${(13 * zoom) / 100}px` }, '.cm-content, .cm-gutters': { fontFamily: 'var(--code-font)' } })
  const editorTheme = (d: boolean) => [
    ...(d ? [oneDark] : []),
    EditorView.theme({ '&': { backgroundColor: 'var(--bg)', height: '100%' }, '.cm-scroller': { overflow: 'auto' }, '.cm-gutters': { backgroundColor: 'var(--panel)', borderRight: '1px solid var(--border)' } })
  ]

  // The handlers below are read through refs so the keymap (built once) always calls the latest.
  const actions = useRef<Record<string, () => unknown>>({})
  const bind = (key: string, name: string, shift?: string) => ({ key, shift: shift ? () => (void actions.current[shift]?.(), true) : undefined, run: () => (void actions.current[name]?.(), true), preventDefault: true })

  useEffect(() => {
    if (!host.current) return
    const c = comps.current
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          Prec.highest(
            keymap.of([
              bind('Mod-s', 'save', 'saveAs'),
              bind('Mod-o', 'open'),
              bind('Mod-n', 'newFile'),
              bind('Mod-p', 'print'),
              bind('Mod-w', 'close'),
              bind('Mod-g', 'goto'),
              bind('Mod-h', 'replace'),
              bind('F5', 'timeDate'),
              bind('Alt-z', 'toggleWrap'),
              bind('Mod-Shift-o', 'symbolPicker'),
              bind('Mod-=', 'zoomIn'),
              bind('Mod-+', 'zoomIn'),
              bind('Mod--', 'zoomOut'),
              bind('Mod-0', 'zoomReset')
            ])
          ),
          basicSetup,
          keymap.of([indentWithTab]),
          c.lang.of([]),
          c.wrap.of(prefs.wrap ? EditorView.lineWrapping : []),
          c.zoom.of(zoomTheme(prefs.zoom)),
          c.theme.of(editorTheme(dark)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setDirty(true)
              clearTimeout(symTimer.current)
              symTimer.current = setTimeout(refreshSymbols, 400)
            }
            if (u.docChanged || u.selectionSet) {
              const s = u.state
              const r = s.selection.main
              const line = s.doc.lineAt(r.head)
              setCursor({ line: line.number, col: r.head - line.from + 1, sel: r.to - r.from, chars: s.doc.length, lines: s.doc.lines })
            }
          })
        ]
      })
    })
    view.current = v
    v.focus()
    return () => {
      clearTimeout(symTimer.current)
      v.destroy()
    }
    // Built once; preferences and theme are applied through compartments below.
  }, [])

  useEffect(() => view.current?.dispatch({ effects: comps.current.wrap.reconfigure(prefs.wrap ? EditorView.lineWrapping : []) }), [prefs.wrap])
  useEffect(() => view.current?.dispatch({ effects: comps.current.zoom.reconfigure(zoomTheme(prefs.zoom)) }), [prefs.zoom])
  useEffect(() => view.current?.dispatch({ effects: comps.current.theme.reconfigure(editorTheme(dark)) }), [dark])

  // ---------------------------------------------------------------- documents
  const setDoc = useCallback(
    async (text: string, m: DocMeta) => {
      const v = view.current
      if (!v) return
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: EditorSelection.cursor(0), scrollIntoView: true })
      setMeta(m)
      metaRef.current = m
      setDirty(false)
      setStale(false)
      refreshSymbols()
      const lang = m.path ? await loadLanguage(m.path, text.slice(0, 200).split('\n', 1)[0]) : undefined
      if (view.current !== v) return
      v.dispatch({ effects: comps.current.lang.reconfigure(lang?.support ?? []) })
      setLangName(lang?.name ?? 'Plain Text')
    },
    [refreshSymbols]
  )

  const readInto = useCallback(
    async (p: string): Promise<boolean> => {
      try {
        const f = await api.fs.readFile(p)
        if (f.binary) {
          toast(`${baseName(p)} is binary or too large to edit here`, 'error')
          return false
        }
        const bom = f.content.startsWith('﻿')
        const raw = bom ? f.content.slice(1) : f.content
        await setDoc(raw.replace(/\r\n?/g, '\n'), { path: p, eol: /\r\n/.test(raw) ? 'CRLF' : raw.includes('\n') ? 'LF' : metaRef.current.eol, bom })
        return true
      } catch (e) {
        toast(errMsg(e), 'error')
        return false
      }
    },
    [setDoc]
  )

  // Opened (or re-targeted from the Files panel) with a path.
  useEffect(() => {
    if (!initialPath || initialPath === metaRef.current.path) return
    void (async () => {
      if (await actions.current.confirmDiscard()) await readInto(initialPath)
    })()
  }, [initialPath, readInto])

  // Changes on disk (e.g. Claude editing the open file).
  useEffect(
    () =>
      bridge.on('session:fileTouched', (ev: { path: string }) => {
        const p = metaRef.current.path
        if (!p || ev.path.toLowerCase() !== p.toLowerCase()) return
        if (dirtyRef.current) setStale(true)
        else void readInto(p)
      }),
    [readInto]
  )

  const text = (): string => view.current?.state.doc.toString() ?? ''

  const writeTo = async (p: string): Promise<boolean> => {
    const m = metaRef.current
    const body = m.eol === 'CRLF' ? text().replace(/\n/g, '\r\n') : text()
    try {
      await api.fs.writeFile(p, (m.bom ? '﻿' : '') + body)
    } catch (e) {
      toast(errMsg(e), 'error')
      return false
    }
    if (p !== m.path) {
      const lang = await loadLanguage(p)
      view.current?.dispatch({ effects: comps.current.lang.reconfigure(lang?.support ?? []) })
      setLangName(lang?.name ?? 'Plain Text')
    }
    setMeta({ ...m, path: p })
    metaRef.current = { ...m, path: p }
    setDirty(false)
    setStale(false)
    refreshSymbols()
    toast(`Saved ${baseName(p)}`, 'success')
    return true
  }
  const saveAs = async (): Promise<boolean> => {
    const p = await api.dialog.saveFile(metaRef.current.path ?? baseName(metaRef.current.path) + '.txt')
    return p ? writeTo(p) : false
  }
  const save = async (): Promise<boolean> => (metaRef.current.path ? writeTo(metaRef.current.path) : saveAs())

  /** true when it is fine to replace/close the current document. */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    const r = await api.dialog.confirm(`Save changes to ${baseName(metaRef.current.path)}?`, undefined, ['Save', "Don't save", 'Cancel'])
    if (r === 0) return save()
    return r === 1
  }

  // ---------------------------------------------------------------- edit helpers
  const withView = (fn: (v: EditorView) => unknown) => (): void => {
    const v = view.current
    if (!v) return
    fn(v)
    v.focus()
  }
  const selection = (v: EditorView): string => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)
  const insert = (v: EditorView, s: string): void => v.dispatch(v.state.replaceSelection(s), { scrollIntoView: true })
  const jump = (line: number): void => {
    const v = view.current
    if (!v) return
    const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)))
    v.dispatch({ selection: EditorSelection.cursor(l.from), effects: EditorView.scrollIntoView(l.from, { y: 'center' }) })
    v.focus()
  }

  const print = (): void => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
    document.body.appendChild(frame)
    const d = frame.contentDocument!
    d.open()
    d.write(`<!doctype html><title>${baseName(metaRef.current.path)}</title><style>body{margin:16px}pre{font:11px/1.45 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-word}</style><pre></pre>`)
    d.close()
    d.querySelector('pre')!.textContent = text()
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
    setTimeout(() => frame.remove(), 1000)
  }

  const askClaude = async (): Promise<void> => {
    const s = activeSession()
    const v = view.current
    if (!s || s.kind !== 'claude' || !v) return void toast('Open a Claude chat first', 'error')
    const p = metaRef.current.path
    if (!p) return void toast('Save the file first so Claude can find it', 'error')
    const r = v.state.selection.main
    const snippet = selection(v)
    const note = await askText(snippet ? 'What should Claude change about the selection?' : `What should Claude change in ${baseName(p)}?`, '', { multiline: true })
    if (!note) return
    if (dirtyRef.current && !(await save())) return
    const where = snippet ? ` (lines ${v.state.doc.lineAt(r.from).number}-${v.state.doc.lineAt(r.to).number})` : ''
    await api.session.sendPrompt(s.id, `In ${p}${where}${snippet ? `, regarding this part:\n\n${snippet.slice(0, 2000)}\n\n` : ': '}${note}`)
    toast(`Sent to ${s.name}`, 'success')
  }

  actions.current = {
    confirmDiscard,
    newFile: async () => (await confirmDiscard()) && setDoc('', { eol: metaRef.current.eol, bom: false }),
    open: async () => {
      if (!(await confirmDiscard())) return
      const p = await api.dialog.openFile()
      if (p) await readInto(p)
    },
    save,
    saveAs,
    reload: async () => {
      const p = metaRef.current.path
      if (p && (await confirmDiscard())) await readInto(p)
    },
    print,
    close: async () => (await confirmDiscard()) && set({ editorFile: false }),
    undo: withView(undo),
    redo: withView(redo),
    cut: withView((v) => {
      const s = selection(v)
      if (!s) return
      void api.clipboard.writeText(s)
      insert(v, '')
    }),
    copy: withView((v) => {
      const s = selection(v)
      if (s) void api.clipboard.writeText(s)
    }),
    paste: async () => {
      const t = await api.clipboard.readText()
      withView((v) => insert(v, t))()
    },
    del: withView((v) => insert(v, '')),
    find: withView(openSearchPanel),
    replace: withView((v) => {
      openSearchPanel(v)
      // Focus the replace field (the panel opens with the search field focused).
      setTimeout(() => (v.dom.querySelector('.cm-search input[name=replace]') as HTMLInputElement | null)?.focus(), 0)
    }),
    findNext: withView(findNext),
    findPrevious: withView(findPrevious),
    goto: withView(gotoLine),
    selectAll: withView(selectAll),
    timeDate: withView((v) => insert(v, new Date().toLocaleString())),
    toggleWrap: () => updatePrefs({ wrap: !prefs.wrap }),
    zoomIn: () => updatePrefs({ zoom: Math.min(400, prefs.zoom + 10) }),
    zoomOut: () => updatePrefs({ zoom: Math.max(50, prefs.zoom - 10) }),
    zoomReset: () => updatePrefs({ zoom: 100 }),
    symbolPicker: () => {
      refreshSymbols()
      setPicker(true)
    },
    askClaude
  }
  const a = actions.current

  // ---------------------------------------------------------------- menus
  const item = (label: string, icon: string, run: () => unknown, hint?: string, disabled?: boolean): MenuItem => ({ label, icon, hint, disabled, onClick: () => void run() })
  const menus: Record<string, () => MenuItem[]> = {
    File: () => [
      item('New', 'plus', a.newFile, `${mod}N`),
      item('Open…', 'folder-open', a.open, `${mod}O`),
      item('Save', 'download', a.save, `${mod}S`),
      item('Save as…', 'download', a.saveAs, `${mod}Shift+S`),
      item('Reload from disk', 'refresh', a.reload, undefined, !meta.path),
      { separator: true },
      item('Print…', 'file', a.print, `${mod}P`),
      item('Open in external editor', 'code', () => meta.path && api.shell.openInEditor(meta.path), undefined, !meta.path),
      item('Reveal in folder', 'folder-open', () => meta.path && api.shell.openPath(meta.path.replace(/[\\/][^\\/]*$/, '')), undefined, !meta.path),
      { separator: true },
      item('Close editor', 'x', a.close, `${mod}W`)
    ],
    Edit: () => [
      item('Undo', 'undo', a.undo, `${mod}Z`),
      item('Redo', 'undo', a.redo, `${mod}Y`),
      { separator: true },
      item('Cut', 'copy', a.cut, `${mod}X`),
      item('Copy', 'copy', a.copy, `${mod}C`),
      item('Paste', 'copy', a.paste, `${mod}V`),
      item('Delete', 'trash', a.del, 'Del'),
      { separator: true },
      item('Find…', 'search', a.find, `${mod}F`),
      item('Find next', 'search', a.findNext, 'F3'),
      item('Find previous', 'search', a.findPrevious, 'Shift+F3'),
      item('Replace…', 'search', a.replace, `${mod}H`),
      item('Go to line…', 'arrow', a.goto, `${mod}G`),
      { separator: true },
      item('Select all', 'list', a.selectAll, `${mod}A`),
      item('Time/Date', 'clock', a.timeDate, 'F5'),
      { separator: true },
      item('Ask Claude to change this…', 'sparkles', a.askClaude)
    ],
    Format: () => [item(`${prefs.wrap ? '✓ ' : ''}Word wrap`, 'list', a.toggleWrap, 'Alt+Z'), item(`Line endings: ${meta.eol === 'CRLF' ? 'Windows (CRLF)' : 'Unix (LF)'} → switch`, 'refresh', () => switchEol())],
    View: () => [
      item('Zoom in', 'plus', a.zoomIn, `${mod}+`),
      item('Zoom out', 'minus', a.zoomOut, `${mod}-`),
      item('Restore default zoom', 'search', a.zoomReset, `${mod}0`),
      { separator: true },
      item(`${prefs.status ? '✓ ' : ''}Status bar`, 'panel-right', () => updatePrefs({ status: !prefs.status })),
      item(`${prefs.symbols ? '✓ ' : ''}Symbols panel`, 'list', () => updatePrefs({ symbols: !prefs.symbols })),
      item('Go to symbol…', 'target', a.symbolPicker, `${mod}Shift+O`)
    ]
  }
  const switchEol = (): void => {
    setMeta((m) => ({ ...m, eol: m.eol === 'CRLF' ? 'LF' : 'CRLF' }))
    setDirty(true)
  }

  const filtered = useMemo(() => {
    const q = symFilter.trim().toLowerCase()
    return q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : symbols
  }, [symbols, symFilter])
  // The symbol nearest above the cursor is highlighted in the outline.
  const currentSymbol = useMemo(() => {
    let best: SymbolInfo | undefined
    for (const s of symbols) if (s.line <= cursor.line) best = s
    return best
  }, [symbols, cursor.line])

  return (
    <div className="file-editor" onKeyDown={(e) => e.key === 'Escape' && picker && (e.stopPropagation(), setPicker(false))}>
      <div className="fe-bar">
        {Object.keys(menus).map((m) => (
          <button key={m} className="fe-menu" onClick={(e) => openMenuAt(e.currentTarget, menus[m]())}>
            {m}
          </button>
        ))}
        <div className="fe-title grow ellipsis" title={meta.path}>
          {dirty && <span className="fe-dirty">●</span>}
          <b>{baseName(meta.path)}</b>
          {meta.path && <span className="muted"> — {meta.path}</span>}
        </div>
        <button className={`icon-btn sm ${prefs.symbols ? 'on' : ''}`} title="Symbols panel" onClick={() => updatePrefs({ symbols: !prefs.symbols })}>
          <Icon name="list" size={14} />
        </button>
        <button className="icon-btn sm" title={`Save (${mod}S)`} onClick={() => void a.save()}>
          <Icon name="download" size={14} />
        </button>
        <button className="icon-btn sm" title={`Close (${mod}W)`} onClick={() => void a.close()}>
          <Icon name="x" size={15} />
        </button>
      </div>
      {stale && (
        <div className="banner warn fe-banner">
          <Icon name="refresh" />
          <div className="grow">This file changed on disk while you have unsaved edits.</div>
          <button className="btn sm" onClick={() => meta.path && void readInto(meta.path)}>
            Reload theirs
          </button>
          <button className="btn sm ghost" onClick={() => setStale(false)}>
            Keep mine
          </button>
        </div>
      )}
      <div className="fe-body">
        {prefs.symbols && (
          <aside className="fe-symbols">
            <input className="input" value={symFilter} placeholder={`Filter ${symbols.length} symbols`} onChange={(e) => setSymFilter(e.target.value)} />
            <div className="fe-symbol-list">
              {!symbols.length && <div className="empty-note">No symbols found.</div>}
              {filtered.map((s, i) => (
                <SymbolRow key={i} s={s} active={s === currentSymbol} indent={!symFilter} onClick={() => jump(s.line)} />
              ))}
            </div>
          </aside>
        )}
        <div className="fe-cm" ref={host} />
        {picker && (
          <SymbolPicker
            symbols={symbols}
            onPick={(s) => {
              setPicker(false)
              jump(s.line)
            }}
            onClose={() => {
              setPicker(false)
              view.current?.focus()
            }}
          />
        )}
      </div>
      {prefs.status && (
        <div className="fe-status">
          <span>
            Ln {cursor.line}, Col {cursor.col}
          </span>
          {cursor.sel > 0 && <span>{cursor.sel} selected</span>}
          <span className="grow" />
          <span>
            {cursor.lines} lines · {cursor.chars} characters
          </span>
          {currentSymbol && <span className="ellipsis" style={{ maxWidth: 220 }}>{currentSymbol.name}</span>}
          <span>{langName}</span>
          <button className="fe-status-btn" title="Zoom (click to reset)" onClick={a.zoomReset}>
            {prefs.zoom}%
          </button>
          <button className="fe-status-btn" title="Line endings (click to switch)" onClick={switchEol}>
            {meta.eol === 'CRLF' ? 'Windows (CRLF)' : 'Unix (LF)'}
          </button>
          <span>{meta.bom ? 'UTF-8 with BOM' : 'UTF-8'}</span>
        </div>
      )}
    </div>
  )
}

function SymbolRow({ s, active, indent, onClick }: { s: SymbolInfo; active: boolean; indent: boolean; onClick: () => void }) {
  const [ch, color] = KIND_ICON[s.kind]
  return (
    <div className={`list-item fe-symbol ${active ? 'active' : ''}`} style={{ paddingLeft: 8 + (indent ? Math.min(s.depth, 6) * 12 : 0) }} title={`${s.kind} · line ${s.line}`} onClick={onClick}>
      <b className="fe-kind" style={{ color }}>
        {ch}
      </b>
      <span className="ellipsis grow">{s.name}</span>
      <span className="sub">{s.line}</span>
    </div>
  )
}

function SymbolPicker({ symbols, onPick, onClose }: { symbols: SymbolInfo[]; onPick: (s: SymbolInfo) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? symbols.filter((s) => s.name.toLowerCase().includes(t)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(t)) - Number(!b.name.toLowerCase().startsWith(t))) : symbols
  }, [symbols, q])
  useEffect(() => setSel(0), [q])
  return (
    <div className="fe-picker">
      <input
        className="input"
        autoFocus
        value={q}
        placeholder="Go to symbol…"
        onChange={(e) => setQ(e.target.value)}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(list.length - 1, i + 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)))
          else if (e.key === 'Enter' && list[sel]) onPick(list[sel])
          else if (e.key === 'Escape') onClose()
        }}
      />
      <div className="fe-picker-list">
        {!list.length && <div className="empty-note">No matching symbols.</div>}
        {list.slice(0, 200).map((s, i) => (
          <div key={i} onMouseDown={(e) => (e.preventDefault(), onPick(s))}>
            <SymbolRow s={s} active={i === sel} indent={false} onClick={() => onPick(s)} />
          </div>
        ))}
      </div>
    </div>
  )
}
