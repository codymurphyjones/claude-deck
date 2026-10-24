import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorSelection, EditorState, Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { indentWithTab, redo, selectAll, toggleComment, undo } from '@codemirror/commands'
import { foldAll, unfoldAll } from '@codemirror/language'
import { findNext, findPrevious, gotoLine, openSearchPanel } from '@codemirror/search'
import { getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge'
import { oneDark } from '@codemirror/theme-one-dark'
import { showMinimap } from '@replit/codemirror-minimap'
import { languageForPath } from '@shared/languages'
import { extractSymbols, type SymbolInfo, type SymbolKind } from '@shared/symbols'
import { api, bridge, errMsg } from '../api'
import { loadLanguage } from '../cmLanguage'
import { askText, editorUnsaved, focusSessionTab, get, toast, useStore } from '../store'
import { resolveTheme } from '../theme'
import type { TsDiagnostic, TsLocation } from '@shared/tsLang'
import { closeTsDoc, isTsPath, MAX_TS_CHARS, tsExtension } from '../editorTs'
import { Icon } from './Icon'
import { openMenu, openMenuAt, type MenuItem } from './ui'

// The code editor tab: open-file tabs, a project explorer, find in files, quick open (Ctrl+P),
// symbols, minimap, and Edit Diff (only the changes since the last commit, editable, with per-change
// revert). One instance lives in the editor tab; store.openInEditor() opens files in it.

const PREFS_KEY = 'deck.fileEditor'
interface Prefs {
  wrap: boolean
  zoom: number
  status: boolean
  symbols: boolean
  minimap: boolean
  side: 'explorer' | 'search' | null
}
const DEFAULT_PREFS: Prefs = { wrap: false, zoom: 100, status: true, symbols: false, minimap: true, side: 'explorer' }

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
const slash = (p: string): string => p.replace(/\\/g, '/')
const samePath = (a?: string, b?: string): boolean => !!a && !!b && slash(a).toLowerCase() === slash(b).toLowerCase()
const isMac = navigator.platform.startsWith('Mac')
const mod = isMac ? '⌘' : 'Ctrl+'

interface DocMeta {
  path?: string
  eol: 'CRLF' | 'LF'
  bom: boolean
}

/** An open file. `state` is its editor state while another file is showing. */
interface Doc {
  key: string
  meta: DocMeta
  state: EditorState
  dirty: boolean
  stale: boolean
  lang: string
  diff: boolean
  /** The committed (HEAD) version: undefined = not loaded yet, null = not in HEAD. */
  original?: string | null
  /** The text last read from or saved to disk: the common ancestor when merging with a change on disk. */
  base: string
  /** The chat whose edit made this file stale. */
  staleBy?: string
  /** Claude is merging the user's unsaved edits into the file (read-only until it lands). */
  merging?: { sessionId: string; name: string }
  /** The path TypeScript support is on for (TS/JS files), and its latest diagnostics. */
  tsPath?: string
  problems?: TsDiagnostic[]
}

// Kept here for existing importers; import it from '../editorClose' to avoid loading the editor.
export { requestCloseEditor } from '../editorClose'

/** A workspace's editor. `root` is its folder; it opens the files requested for its workspace. */
export function EditorWorkspace({ active, tabId, group, root }: { active: boolean; tabId: string; group: string; root?: string }) {
  const dark = useStore((s) => resolveTheme(s.settings, s.systemDark).dark)
  const request = useStore((s) => (s.editorRequest?.group === group ? s.editorRequest : undefined))
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const comps = useRef({ lang: new Compartment(), wrap: new Compartment(), zoom: new Compartment(), theme: new Compartment(), diff: new Compartment(), minimap: new Compartment(), readOnly: new Compartment(), ts: new Compartment() })
  const docs = useRef(new Map<string, Doc>())
  const [order, setOrder] = useState<string[]>([])
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined)
  const activeRef = useRef<string | undefined>(undefined)
  activeRef.current = activeKey
  const [, setTick] = useState(0)
  const bump = (): void => setTick((t) => t + 1)
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0, chars: 0, lines: 1 })
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs)
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const [symbols, setSymbols] = useState<SymbolInfo[]>([])
  const [symFilter, setSymFilter] = useState('')
  const [picker, setPicker] = useState<false | 'symbols' | 'files'>(false)
  const [showProblems, setShowProblems] = useState(false)
  const untitled = useRef(0)
  const doc = activeKey ? docs.current.get(activeKey) : undefined

  // Unsaved files, for closing this editor or its workspace from the tab strip.
  useEffect(() => {
    editorUnsaved.set(tabId, () => [...docs.current.values()].filter((d) => d.dirty).map((d) => baseName(d.meta.path)))
    return () => void editorUnsaved.delete(tabId)
  }, [tabId])

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

  // ---------------------------------------------------------------- editor setup
  const zoomTheme = (zoom: number): Extension => EditorView.theme({ '&': { fontSize: `${(13 * zoom) / 100}px` }, '.cm-content, .cm-gutters': { fontFamily: 'var(--code-font)' } })
  const editorTheme = (d: boolean): Extension => [
    ...(d ? [oneDark] : []),
    EditorView.theme({ '&': { backgroundColor: 'var(--bg)', height: '100%' }, '.cm-scroller': { overflow: 'auto' }, '.cm-gutters': { backgroundColor: 'var(--panel)', borderRight: '1px solid var(--border)' } })
  ]
  const minimapExt = (on: boolean): Extension =>
    on ? showMinimap.compute(['doc'], () => ({ create: () => ({ dom: document.createElement('div') }), displayText: 'blocks', showOverlay: 'mouse-over' })) : []

  // Handlers are read through refs so the keymap (built once per document) always calls the latest.
  const actions = useRef<Record<string, () => unknown>>({})
  const bind = (key: string, name: string, shift?: string) => ({ key, shift: shift ? () => (void actions.current[shift]?.(), true) : undefined, run: () => (void actions.current[name]?.(), true), preventDefault: true })

  const refreshSymbols = useCallback(() => {
    const v = view.current
    const d = activeRef.current ? docs.current.get(activeRef.current) : undefined
    if (!v || !d) return setSymbols([])
    const text = v.state.doc.toString()
    const lang = d.meta.path ? languageForPath(d.meta.path, text.slice(0, 200).split('\n', 1)[0]) : undefined
    setSymbols(extractSymbols(text, lang))
  }, [])
  const symTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  /** A new document's state, with the editor's shared extensions. */
  const makeState = (text: string): EditorState => {
    const c = comps.current
    const p = prefsRef.current
    return EditorState.create({
      doc: text,
      extensions: [
        Prec.highest(
          keymap.of([
            bind('Mod-s', 'save', 'saveAs'),
            bind('Mod-o', 'open'),
            bind('Mod-n', 'newFile'),
            bind('Mod-w', 'closeFile'),
            bind('Mod-p', 'quickOpen'),
            bind('Mod-Shift-f', 'findInFiles'),
            bind('Mod-b', 'toggleSide'),
            bind('Mod-g', 'goto'),
            bind('Mod-h', 'replace'),
            bind('Mod-/', 'comment'),
            bind('Alt-z', 'toggleWrap'),
            bind('Mod-Shift-o', 'symbolPicker'),
            bind('Mod-Shift-d', 'toggleDiff'),
            bind('F7', 'nextChange', 'prevChange'),
            bind('Mod-=', 'zoomIn'),
            bind('Mod-+', 'zoomIn'),
            bind('Mod--', 'zoomOut'),
            bind('Mod-0', 'zoomReset')
          ])
        ),
        basicSetup,
        keymap.of([indentWithTab]),
        c.lang.of([]),
        c.wrap.of(p.wrap ? EditorView.lineWrapping : []),
        c.zoom.of(zoomTheme(p.zoom)),
        c.theme.of(editorTheme(dark)),
        c.minimap.of(minimapExt(p.minimap)),
        c.diff.of([]),
        c.readOnly.of([]),
        c.ts.of([]),
        EditorView.updateListener.of((u) => {
          const d = activeRef.current ? docs.current.get(activeRef.current) : undefined
          if (u.docChanged && d && !d.dirty) {
            d.dirty = true
            bump()
          }
          if (u.docChanged) {
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
  }

  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({ parent: host.current, state: makeState('') })
    view.current = v
    return () => {
      clearTimeout(symTimer.current)
      for (const d of docs.current.values()) if (d.tsPath) closeTsDoc(d.tsPath)
      v.destroy()
    }
    // Built once; documents swap in with setState, preferences apply through compartments.
  }, [])

  /** Apply the current preferences to the showing document (each document keeps its own config). */
  const applyPrefs = (): void => {
    const v = view.current
    if (!v) return
    const c = comps.current
    const p = prefsRef.current
    v.dispatch({ effects: [c.wrap.reconfigure(p.wrap ? EditorView.lineWrapping : []), c.zoom.reconfigure(zoomTheme(p.zoom)), c.theme.reconfigure(editorTheme(dark)), c.minimap.reconfigure(minimapExt(p.minimap))] })
  }
  useEffect(applyPrefs, [prefs.wrap, prefs.zoom, prefs.minimap, dark])

  // ---------------------------------------------------------------- documents
  /** Show a document (stashing the current one's state). */
  const activate = (key: string | undefined): void => {
    const v = view.current
    if (!v) return
    const cur = activeRef.current ? docs.current.get(activeRef.current) : undefined
    if (cur) cur.state = v.state
    const next = key ? docs.current.get(key) : undefined
    v.setState(next ? next.state : makeState(''))
    activeRef.current = key
    setActiveKey(key)
    applyPrefs()
    const s = v.state
    const r = s.selection.main
    const line = s.doc.lineAt(r.head)
    setCursor({ line: line.number, col: r.head - line.from + 1, sel: r.to - r.from, chars: s.doc.length, lines: s.doc.lines })
    refreshSymbols()
    if (active) requestAnimationFrame(() => v.focus())
  }

  const jump = (line: number, col = 1): void => {
    const v = view.current
    if (!v) return
    const l = v.state.doc.line(Math.max(1, Math.min(line, v.state.doc.lines)))
    const at = Math.min(l.from + Math.max(0, col - 1), l.to)
    v.dispatch({ selection: EditorSelection.cursor(at), effects: EditorView.scrollIntoView(at, { y: 'center' }) })
    v.focus()
  }

  /** Reconfigure one document, whether it's showing or stashed. */
  const reconfigureDoc = (d: Doc, effects: Parameters<EditorView['dispatch']>[0]['effects']): void => {
    if (d.key === activeRef.current && view.current) view.current.dispatch({ effects })
    else d.state = d.state.update({ effects }).state
  }

  const readFile = async (p: string): Promise<{ text: string; meta: DocMeta } | undefined> => {
    try {
      const f = await api.fs.readFile(p)
      if (f.binary) {
        toast(`${baseName(p)} is binary or too large to edit here`, 'error')
        return undefined
      }
      const bom = f.content.startsWith('﻿')
      const raw = bom ? f.content.slice(1) : f.content
      return { text: raw.replace(/\r\n?/g, '\n'), meta: { path: p, eol: /\r\n/.test(raw) ? 'CRLF' : raw.includes('\n') ? 'LF' : isMac ? 'LF' : 'CRLF', bom } }
    } catch (e) {
      toast(errMsg(e), 'error')
      return undefined
    }
  }

  const setLanguage = async (d: Doc): Promise<void> => {
    if (!d.meta.path) return
    const lang = await loadLanguage(d.meta.path, d.state.doc.toString().slice(0, 200).split('\n', 1)[0])
    d.lang = lang?.name ?? 'Plain Text'
    reconfigureDoc(d, comps.current.lang.reconfigure(lang?.support ?? []))
    configureTs(d)
    bump()
  }

  /** TypeScript support (diagnostics, hover, completions, go to definition) for TS/JS files. */
  const configureTs = (d: Doc): void => {
    const p = d.meta.path
    const want = isTsPath(p) && d.state.doc.length <= MAX_TS_CHARS ? p : undefined
    if (d.tsPath === want) return
    if (d.tsPath) closeTsDoc(d.tsPath)
    d.tsPath = want
    d.problems = undefined
    reconfigureDoc(
      d,
      comps.current.ts.reconfigure(
        want
          ? tsExtension(want, root, {
              onDiagnostics: (diags) => {
                if (d.tsPath !== want || JSON.stringify(diags) === JSON.stringify(d.problems)) return
                d.problems = diags
                bump()
              },
              onDefinition: (loc) => void openLocation.current(loc),
              onNoDefinition: () => toast('No definition found', 'info')
            })
          : []
      )
    )
  }

  const openFile = async (p: string, opts: { line?: number; col?: number; diff?: boolean } = {}): Promise<void> => {
    let d = [...docs.current.values()].find((x) => samePath(x.meta.path, p))
    if (!d) {
      const r = await readFile(p)
      if (!r) return
      d = [...docs.current.values()].find((x) => samePath(x.meta.path, p))
      if (!d) {
        d = { key: p, meta: r.meta, state: makeState(r.text), dirty: false, stale: false, lang: 'Plain Text', diff: false, base: r.text }
        docs.current.set(d.key, d)
        setOrder((o) => [...o, d!.key])
        void setLanguage(d)
      }
    }
    if (d.key !== activeRef.current) activate(d.key)
    if (opts.diff && !d.diff) await setDiff(d, true)
    if (opts.line) jump(opts.line, opts.col)
  }

  const closeFile = async (key: string): Promise<void> => {
    const d = docs.current.get(key)
    if (!d) return
    if (d.dirty) {
      const r = await api.dialog.confirm(`Save changes to ${baseName(d.meta.path)}?`, undefined, ['Save', "Don't save", 'Cancel'])
      if (r === 2 || r < 0) return
      if (r === 0) {
        if (key !== activeRef.current) activate(key)
        if (!(await save())) return
      }
    }
    if (d.tsPath) closeTsDoc(d.tsPath)
    const idx = order.indexOf(key)
    const rest = order.filter((k) => k !== key)
    if (key === activeRef.current) {
      activeRef.current = undefined
      docs.current.delete(key)
      activate(rest[Math.min(idx, rest.length - 1)])
    } else docs.current.delete(key)
    setOrder(rest)
  }

  // Requests from outside (Review, Files panel, Project home, an agent's open_file).
  useEffect(() => {
    if (request?.path) void openFile(request.path, { line: request.line, diff: request.diff })
  }, [request?.at])

  // Changes on disk (e.g. Claude editing an open file): reload clean files, flag edited ones.
  useEffect(
    () =>
      bridge.on('session:fileTouched', (ev: { id: string; path: string }) => {
        const d = [...docs.current.values()].find((x) => samePath(x.meta.path, ev.path))
        if (!d) return
        // While Claude merges, its write is the merged result: take it.
        if (d.dirty && !d.merging) {
          d.stale = true
          d.staleBy = ev.id
          bump()
        } else void reload(d)
      }),
    []
  )

  const reload = async (d: Doc): Promise<void> => {
    if (!d.meta.path) return
    const r = await readFile(d.meta.path)
    if (!r) return
    const replace = { changes: { from: 0, to: d.state.doc.length, insert: r.text } }
    if (d.key === activeRef.current && view.current) {
      const v = view.current
      const head = Math.min(v.state.selection.main.head, r.text.length)
      v.dispatch({ ...replace, changes: { from: 0, to: v.state.doc.length, insert: r.text }, selection: EditorSelection.cursor(head) })
    } else d.state = d.state.update(replace).state
    d.meta = r.meta
    d.base = r.text
    d.dirty = false
    d.stale = false
    d.original = undefined
    if (d.merging) {
      toast(`${d.merging.name} merged your edits into ${baseName(d.meta.path)}`, 'success')
      d.merging = undefined
      reconfigureDoc(d, comps.current.readOnly.reconfigure([]))
    }
    if (d.diff) await setDiff(d, true)
    bump()
  }

  // ---------------------------------------------------------------- Edit Diff
  /** Show only the changes since the last commit (unified diff, editable; unchanged code collapsed). */
  const setDiff = async (d: Doc, on: boolean): Promise<void> => {
    if (!on) {
      d.diff = false
      reconfigureDoc(d, comps.current.diff.reconfigure([]))
      return bump()
    }
    if (!d.meta.path) return void toast('Save the file first; Edit Diff compares it with the last commit.', 'error')
    if (d.original === undefined) d.original = await api.git.fileAtHead(d.meta.path).catch(() => null)
    const original = (d.original ?? '').replace(/\r\n?/g, '\n')
    const current = d.key === activeRef.current && view.current ? view.current.state.doc.toString() : d.state.doc.toString()
    if (d.original !== null && original === current) return void toast(`${baseName(d.meta.path)} has no changes since the last commit.`, 'info')
    if (d.original === null) toast(`${baseName(d.meta.path)} isn't in the last commit, so all of it shows as added.`, 'info')
    d.diff = true
    reconfigureDoc(d, comps.current.diff.reconfigure(unifiedMergeView({ original, collapseUnchanged: { margin: 3, minSize: 4 }, mergeControls: true, gutter: true })))
    bump()
    if (d.key === activeRef.current && view.current) requestAnimationFrame(() => view.current && goToNextChunk(view.current))
  }
  const changeCount = doc?.diff && view.current ? (getChunks(view.current.state)?.chunks.length ?? 0) : 0

  // ---------------------------------------------------------------- saving
  const text = (): string => view.current?.state.doc.toString() ?? ''

  const writeTo = async (p: string): Promise<boolean> => {
    const d = activeRef.current ? docs.current.get(activeRef.current) : undefined
    if (!d) return false
    const body = d.meta.eol === 'CRLF' ? text().replace(/\n/g, '\r\n') : text()
    try {
      await api.fs.writeFile(p, (d.meta.bom ? '﻿' : '') + body)
    } catch (e) {
      toast(errMsg(e), 'error')
      return false
    }
    const renamed = !samePath(p, d.meta.path)
    d.base = text()
    d.meta = { ...d.meta, path: p }
    d.dirty = false
    d.stale = false
    if (renamed) {
      d.original = undefined
      void setLanguage(d)
    }
    refreshSymbols()
    bump()
    toast(`Saved ${baseName(p)}`, 'success')
    return true
  }
  const saveAs = async (): Promise<boolean> => {
    const d = activeRef.current ? docs.current.get(activeRef.current) : undefined
    const p = await api.dialog.saveFile(d?.meta.path ?? (root ? `${root}/untitled.txt` : 'untitled.txt'))
    return p ? writeTo(p) : false
  }
  const save = async (): Promise<boolean> => {
    const d = activeRef.current ? docs.current.get(activeRef.current) : undefined
    if (!d) return false
    return d.meta.path ? writeTo(d.meta.path) : saveAs()
  }

  // ---------------------------------------------------------------- helpers
  const withView = (fn: (v: EditorView) => unknown) => (): void => {
    const v = view.current
    if (!v || !activeRef.current) return
    fn(v)
    v.focus()
  }
  const selection = (v: EditorView): string => v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)
  const insert = (v: EditorView, s: string): void => v.dispatch(v.state.replaceSelection(s), { scrollIntoView: true })

  const print = (): void => {
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
    document.body.appendChild(frame)
    const fd = frame.contentDocument!
    fd.open()
    fd.write(`<!doctype html><title>${baseName(doc?.meta.path)}</title><style>body{margin:16px}pre{font:11px/1.45 Consolas,Menlo,monospace;white-space:pre-wrap;word-break:break-word}</style><pre></pre>`)
    fd.close()
    fd.querySelector('pre')!.textContent = text()
    frame.contentWindow!.focus()
    frame.contentWindow!.print()
    setTimeout(() => frame.remove(), 1000)
  }

  /** The chat to ask: `preferId` if it's still open, else the project's most recently active one. */
  const pickChat = (preferId?: string) => {
    const sessions = Object.values(get().sessions).filter((s) => s.kind === 'agent' && s.status !== 'exited')
    const byRecent = (a: { lastActivity: number }, b: { lastActivity: number }): number => b.lastActivity - a.lastActivity
    return sessions.find((s) => s.id === preferId) ?? sessions.filter((x) => root && samePath(x.root, root)).sort(byRecent)[0] ?? sessions.sort(byRecent)[0]
  }

  /**
   * The file changed on disk while the user had unsaved edits: hand both to Claude to combine. The
   * user's version and the one they started from (the common ancestor) go to temp files; the file
   * is read-only until Claude's merged write reloads it.
   */
  const mergeWithClaude = async (d: Doc): Promise<void> => {
    const p = d.meta.path
    if (!p) return
    const s = pickChat(d.staleBy)
    if (!s) return void toast('Open a Claude chat for this project first', 'error')
    const mine = d.key === activeRef.current && view.current ? view.current.state.doc.toString() : d.state.doc.toString()
    let minePath: string
    let basePath: string
    try {
      ;[minePath, basePath] = await Promise.all([api.fs.saveTempText(`mine-${baseName(p)}`, mine), api.fs.saveTempText(`base-${baseName(p)}`, d.base)])
    } catch (e) {
      return void toast(errMsg(e), 'error')
    }
    await api.session.sendPrompt(
      s.id,
      [
        `[Claude Deck] Please merge edits to ${p}.`,
        `The file changed on disk (your edit, or another session's) while the user had unsaved changes to it in the Claude Deck editor. Three versions:`,
        `- Current file on disk: ${p}`,
        `- The user's unsaved version: ${minePath}`,
        `- The version the user started from (common ancestor): ${basePath}`,
        `Update ${p} so it keeps both sets of changes: diff each version against the ancestor and combine them. Where they touch the same lines, keep both intents if possible; if a real conflict needs a decision, ask the user before writing. Change only ${p}, then briefly say what you merged.`
      ].join('\n')
    )
    // The user's edits now live in the temp file Claude is merging from.
    d.merging = { sessionId: s.id, name: s.name }
    d.dirty = false
    d.stale = false
    reconfigureDoc(d, comps.current.readOnly.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]))
    bump()
    toast(`Asked ${s.name} to merge your edits`, 'success')
  }

  /** Stop waiting for a merge: the user's version is editable (and unsaved) again. */
  const cancelMerge = (d: Doc): void => {
    d.merging = undefined
    d.dirty = true
    d.stale = true
    reconfigureDoc(d, comps.current.readOnly.reconfigure([]))
    bump()
  }

  /** Send a change request to the project's most recent Claude chat. */
  const askClaude = async (): Promise<void> => {
    const v = view.current
    const p = doc?.meta.path
    if (!v || !p) return void toast('Save the file first so Claude can find it', 'error')
    const s = pickChat()
    if (!s) return void toast('Open a Claude chat for this project first', 'error')
    const r = v.state.selection.main
    const snippet = selection(v)
    const note = await askText(snippet ? `What should ${s.name} change about the selection?` : `What should ${s.name} change in ${baseName(p)}?`, '', { multiline: true })
    if (!note) return
    if (doc.dirty && !(await save())) return
    const where = snippet ? ` (lines ${v.state.doc.lineAt(r.from).number}-${v.state.doc.lineAt(r.to).number})` : ''
    await api.session.sendPrompt(s.id, `In ${p}${where}${snippet ? `, regarding this part:\n\n${snippet.slice(0, 2000)}\n\n` : ': '}${note}`)
    toast(`Sent to ${s.name}`, 'success')
  }

  /** Hand the current file's TypeScript errors to the project's most recent Claude chat to fix. */
  const fixWithClaude = async (): Promise<void> => {
    const d = doc
    const p = d?.meta.path
    if (!d || !p) return
    const errors = (d.problems ?? []).filter((x) => x.severity === 'error')
    if (!errors.length) return void toast('No errors to fix', 'info')
    const s = pickChat()
    if (!s) return void toast('Open a Claude chat for this project first', 'error')
    if (d.dirty && !(await save())) return
    const lines = text().split('\n')
    const MAX = 50
    const list = errors.slice(0, MAX).map((e) => `- ${e.line}:${e.col} TS${e.code}: ${e.message.replace(/\n/g, '\n    ')}\n    > ${(lines[e.line - 1] ?? '').trim().slice(0, 200)}`)
    await api.session.sendPrompt(
      s.id,
      [
        `[Claude Deck] Please fix the TypeScript error${errors.length === 1 ? '' : 's'} in ${p} (reported by the editor's TypeScript checker; line:col, code, message, then the source line):`,
        ...list,
        ...(errors.length > MAX ? [`… and ${errors.length - MAX} more.`] : []),
        `Fix the causes (in ${p}, or wherever the real problem is) without changing behaviour, and don't silence them with \`any\` or @ts-ignore. Then briefly say what you changed.`
      ].join('\n')
    )
    toast(`Sent ${errors.length} error${errors.length === 1 ? '' : 's'} to ${s.name}`, 'success')
  }

  const newFile = (): void => {
    const key = `untitled:${++untitled.current}`
    docs.current.set(key, { key, meta: { eol: isMac ? 'LF' : 'CRLF', bom: false }, state: makeState(''), dirty: false, stale: false, lang: 'Plain Text', diff: false, base: '' })
    setOrder((o) => [...o, key])
    activate(key)
  }

  actions.current = {
    newFile,
    open: async () => {
      const p = await api.dialog.openFile()
      if (p) await openFile(p)
    },
    save,
    saveAs,
    reload: () => doc && reload(doc),
    closeFile: () => activeRef.current && closeFile(activeRef.current),
    print,
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
    find: withView(openSearchPanel),
    replace: withView((v) => {
      openSearchPanel(v)
      setTimeout(() => (v.dom.querySelector('.cm-search input[name=replace]') as HTMLInputElement | null)?.focus(), 0)
    }),
    findNext: withView(findNext),
    findPrevious: withView(findPrevious),
    goto: withView(gotoLine),
    selectAll: withView(selectAll),
    comment: withView(toggleComment),
    foldAll: withView(foldAll),
    unfoldAll: withView(unfoldAll),
    timeDate: withView((v) => insert(v, new Date().toLocaleString())),
    toggleWrap: () => updatePrefs({ wrap: !prefs.wrap }),
    zoomIn: () => updatePrefs({ zoom: Math.min(400, prefs.zoom + 10) }),
    zoomOut: () => updatePrefs({ zoom: Math.max(50, prefs.zoom - 10) }),
    zoomReset: () => updatePrefs({ zoom: 100 }),
    symbolPicker: () => {
      refreshSymbols()
      setPicker('symbols')
    },
    quickOpen: () => setPicker('files'),
    findInFiles: () => {
      updatePrefs({ side: 'search' })
      setTimeout(() => (document.querySelector('.fe-search-input') as HTMLInputElement | null)?.focus(), 0)
    },
    toggleSide: () => updatePrefs({ side: prefs.side ? null : 'explorer' }),
    toggleDiff: () => doc && setDiff(doc, !doc.diff),
    nextChange: withView(goToNextChunk),
    prevChange: withView(goToPreviousChunk),
    external: () => doc?.meta.path && api.shell.openInEditor(doc.meta.path, cursor.line),
    askClaude,
    fixWithClaude,
    toggleProblems: () => setShowProblems((x) => !x)
  }
  const a = actions.current
  // Go to definition (TypeScript), possibly in a file that isn't open yet.
  const openLocation = useRef((_loc: TsLocation): unknown => undefined)
  openLocation.current = (loc) => openFile(loc.file, { line: loc.line, col: loc.col })

  // Shortcuts when focus is outside the code (explorer, search, tabs).
  const onKeyDown = (e: ReactKeyboardEvent): void => {
    if (picker && e.key === 'Escape') {
      e.stopPropagation()
      setPicker(false)
      return
    }
    if ((e.target as HTMLElement).closest('.cm-editor')) return
    const m = isMac ? e.metaKey : e.ctrlKey
    if (!m) return
    const k = e.key.toLowerCase()
    const run = (name: string): void => {
      e.preventDefault()
      void actions.current[name]?.()
    }
    if (k === 'p') run('quickOpen')
    else if (k === 'f' && e.shiftKey) run('findInFiles')
    else if (k === 's') run(e.shiftKey ? 'saveAs' : 'save')
    else if (k === 'w') run('closeFile')
    else if (k === 'b') run('toggleSide')
    else if (k === 'n') run('newFile')
    else if (k === 'o' && !e.shiftKey) run('open')
  }

  // ---------------------------------------------------------------- menus
  const item = (label: string, icon: string, fn: () => unknown, hint?: string, disabled?: boolean): MenuItem => ({ label, icon, hint, disabled, onClick: () => void fn() })
  const noDoc = !doc
  const problems = doc?.problems
  const errorCount = problems?.filter((x) => x.severity === 'error').length ?? 0
  const otherCount = problems ? problems.length - errorCount : 0
  const menus: Record<string, () => MenuItem[]> = {
    File: () => [
      item('New file', 'plus', a.newFile, `${mod}N`),
      item('Open file…', 'folder-open', a.open, `${mod}O`),
      item('Quick open…', 'search', a.quickOpen, `${mod}P`),
      { separator: true },
      item('Save', 'download', a.save, `${mod}S`, noDoc),
      item('Save as…', 'download', a.saveAs, `${mod}Shift+S`, noDoc),
      item('Reload from disk', 'refresh', a.reload, undefined, !doc?.meta.path),
      { separator: true },
      item('Print…', 'file', a.print, undefined, noDoc),
      item('Open in VS Code / external editor', 'code', a.external, undefined, !doc?.meta.path),
      item('Reveal in folder', 'folder-open', () => doc?.meta.path && api.shell.showItem(doc.meta.path), undefined, !doc?.meta.path),
      item('Copy path', 'copy', () => doc?.meta.path && api.clipboard.writeText(doc.meta.path), undefined, !doc?.meta.path),
      { separator: true },
      item('Close file', 'x', a.closeFile, `${mod}W`, noDoc)
    ],
    Edit: () => [
      item('Undo', 'undo', a.undo, `${mod}Z`, noDoc),
      item('Redo', 'undo', a.redo, `${mod}Y`, noDoc),
      { separator: true },
      item('Cut', 'copy', a.cut, `${mod}X`, noDoc),
      item('Copy', 'copy', a.copy, `${mod}C`, noDoc),
      item('Paste', 'copy', a.paste, `${mod}V`, noDoc),
      { separator: true },
      item('Find…', 'search', a.find, `${mod}F`, noDoc),
      item('Replace…', 'search', a.replace, `${mod}H`, noDoc),
      item('Find next', 'search', a.findNext, 'F3', noDoc),
      item('Find previous', 'search', a.findPrevious, 'Shift+F3', noDoc),
      item('Find in files…', 'search', a.findInFiles, `${mod}Shift+F`),
      { separator: true },
      item('Toggle line comment', 'code', a.comment, `${mod}/`, noDoc),
      item('Select all', 'list', a.selectAll, `${mod}A`, noDoc),
      item('Insert time/date', 'clock', a.timeDate, undefined, noDoc),
      { separator: true },
      item('Ask Claude to change this…', 'sparkles', a.askClaude, undefined, noDoc),
      item(errorCount ? `Fix ${errorCount} error${errorCount === 1 ? '' : 's'} with Claude` : 'Fix errors with Claude', 'sparkles', a.fixWithClaude, undefined, !errorCount)
    ],
    Go: () => [
      item('Go to file…', 'file', a.quickOpen, `${mod}P`),
      item('Go to line…', 'arrow', a.goto, `${mod}G`, noDoc),
      item('Go to symbol…', 'target', a.symbolPicker, `${mod}Shift+O`, noDoc),
      { separator: true },
      item('Next change', 'chevron-down', a.nextChange, 'F7', !doc?.diff),
      item('Previous change', 'chevron-up', a.prevChange, 'Shift+F7', !doc?.diff)
    ],
    View: () => [
      item(`${prefs.side === 'explorer' ? '✓ ' : ''}Explorer`, 'folder', () => updatePrefs({ side: prefs.side === 'explorer' ? null : 'explorer' }), `${mod}B`),
      item(`${prefs.side === 'search' ? '✓ ' : ''}Search`, 'search', () => updatePrefs({ side: prefs.side === 'search' ? null : 'search' })),
      item(`${prefs.symbols ? '✓ ' : ''}Outline`, 'list', () => updatePrefs({ symbols: !prefs.symbols })),
      item(`${prefs.minimap ? '✓ ' : ''}Minimap`, 'panel-right', () => updatePrefs({ minimap: !prefs.minimap })),
      item(`${prefs.status ? '✓ ' : ''}Status bar`, 'panel-right', () => updatePrefs({ status: !prefs.status })),
      item(`${showProblems ? '✓ ' : ''}Problems`, 'list', a.toggleProblems, undefined, !doc?.tsPath),
      item(`${prefs.wrap ? '✓ ' : ''}Word wrap`, 'list', a.toggleWrap, 'Alt+Z'),
      { separator: true },
      item('Fold all', 'chevron-right', a.foldAll, undefined, noDoc),
      item('Unfold all', 'chevron-down', a.unfoldAll, undefined, noDoc),
      { separator: true },
      item('Zoom in', 'plus', a.zoomIn, `${mod}+`),
      item('Zoom out', 'minus', a.zoomOut, `${mod}-`),
      item('Reset zoom', 'search', a.zoomReset, `${mod}0`)
    ]
  }
  const switchEol = (): void => {
    if (!doc) return
    doc.meta = { ...doc.meta, eol: doc.meta.eol === 'CRLF' ? 'LF' : 'CRLF' }
    doc.dirty = true
    bump()
  }

  const filteredSymbols = useMemo(() => {
    const q = symFilter.trim().toLowerCase()
    return q ? symbols.filter((s) => s.name.toLowerCase().includes(q)) : symbols
  }, [symbols, symFilter])
  const currentSymbol = useMemo(() => {
    let best: SymbolInfo | undefined
    for (const s of symbols) if (s.line <= cursor.line) best = s
    return best
  }, [symbols, cursor.line])

  // Project files for the explorer and quick open.
  const [files, setFiles] = useState<string[] | null>(null)
  const loadFiles = useCallback(async () => {
    if (!root) return setFiles([])
    setFiles((await api.fs.listFiles(root).catch(() => [])).map(slash))
  }, [root])
  useEffect(() => {
    setFiles(null)
    void loadFiles()
  }, [loadFiles])

  const rel = (p?: string): string | undefined => {
    if (!p || !root) return p
    const a2 = slash(p)
    const r = slash(root).replace(/\/+$/, '')
    return a2.toLowerCase().startsWith(r.toLowerCase() + '/') ? a2.slice(r.length + 1) : a2
  }
  const abs = (relPath: string): string => (root ? `${slash(root).replace(/\/+$/, '')}/${relPath}` : relPath)

  return (
    <div className="file-editor" onKeyDown={onKeyDown}>
      <div className="fe-bar">
        {Object.keys(menus).map((m) => (
          <button key={m} className="fe-menu" onClick={(e) => openMenuAt(e.currentTarget, menus[m]())}>
            {m}
          </button>
        ))}
        <div className="fe-title grow ellipsis" title={root}>
          <span className="muted">{root ? baseName(root) : 'No folder'}</span>
        </div>
        <button className={`btn sm ${doc?.diff ? 'primary' : ''}`} disabled={!doc?.meta.path} title={`Show only what changed since the last commit (${mod}Shift+D). Edit right in the diff; ↶ on a change reverts it.`} onClick={() => void a.toggleDiff()}>
          <Icon name="split" size={13} /> {doc?.diff ? 'Full file' : 'Edit Diff'}
        </button>
        <button className="icon-btn sm" title={`Save (${mod}S)`} disabled={!doc} onClick={() => void a.save()}>
          <Icon name="download" size={14} />
        </button>
        <button className={`icon-btn sm ${prefs.symbols ? 'on' : ''}`} title="Outline" onClick={() => updatePrefs({ symbols: !prefs.symbols })}>
          <Icon name="list" size={14} />
        </button>
      </div>

      <div className="fe-body">
        <nav className="fe-activity">
          <button className={`icon-btn ${prefs.side === 'explorer' ? 'on' : ''}`} title={`Explorer (${mod}B)`} onClick={() => updatePrefs({ side: prefs.side === 'explorer' ? null : 'explorer' })}>
            <Icon name="folder" size={16} />
          </button>
          <button className={`icon-btn ${prefs.side === 'search' ? 'on' : ''}`} title={`Find in files (${mod}Shift+F)`} onClick={() => updatePrefs({ side: prefs.side === 'search' ? null : 'search' })}>
            <Icon name="search" size={16} />
          </button>
        </nav>
        {prefs.side === 'explorer' && <Explorer root={root} files={files} activePath={rel(doc?.meta.path)} onOpen={(r) => void openFile(abs(r))} onRefresh={() => void loadFiles()} />}
        {prefs.side === 'search' && <SearchPanel root={root} onOpen={(r, line) => void openFile(abs(r), { line })} />}

        <div className="fe-main">
          {order.length > 0 && (
            <div className="fe-tabs">
              {order.map((k) => {
                const d = docs.current.get(k)
                if (!d) return null
                return (
                  <div
                    key={k}
                    className={`fe-tab ${k === activeKey ? 'active' : ''}`}
                    title={d.meta.path ?? 'Unsaved file'}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        void closeFile(k)
                      } else if (e.button === 0 && k !== activeKey) activate(k)
                    }}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: 'Close', icon: 'x', onClick: () => void closeFile(k) },
                        { label: 'Close others', icon: 'x', onClick: () => order.filter((x) => x !== k).forEach((x) => void closeFile(x)) },
                        { separator: true },
                        { label: 'Copy path', icon: 'copy', disabled: !d.meta.path, onClick: () => d.meta.path && api.clipboard.writeText(d.meta.path) },
                        { label: 'Reveal in folder', icon: 'folder-open', disabled: !d.meta.path, onClick: () => d.meta.path && api.shell.showItem(d.meta.path) }
                      ])
                    }
                  >
                    <span className="ellipsis">{baseName(d.meta.path) || 'Untitled'}</span>
                    {d.diff && <span className="badge accent">diff</span>}
                    <button
                      className={`icon-btn sm fe-tab-close ${d.dirty ? 'dirty' : ''}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        void closeFile(k)
                      }}
                      title={d.dirty ? 'Unsaved changes. Close' : 'Close'}
                    >
                      {d.dirty ? <span className="fe-dirty">●</span> : <Icon name="x" size={12} />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
          {doc && (
            <div className="fe-crumbs ellipsis">
              {(rel(doc.meta.path) ?? 'Untitled').split('/').map((seg, i, all) => (
                <span key={i} className={i === all.length - 1 ? 'cur' : ''}>
                  {seg}
                  {i < all.length - 1 && <Icon name="chevron-right" size={11} />}
                </span>
              ))}
              {currentSymbol && (
                <span className="sym">
                  <Icon name="chevron-right" size={11} /> {currentSymbol.name}
                </span>
              )}
              {doc.diff && (
                <span className="fe-diff-note">
                  {changeCount} change{changeCount === 1 ? '' : 's'} since the last commit · F7 next · ↶ reverts a change
                </span>
              )}
            </div>
          )}
          {doc?.stale && (
            <div className="banner warn fe-banner">
              <Icon name="refresh" />
              <div className="grow">This file changed on disk while you have unsaved edits.</div>
              <button className="btn sm primary" title="Send your version to Claude to combine with the change on disk" onClick={() => void mergeWithClaude(doc)}>
                <Icon name="sparkles" size={12} /> Have Claude merge these
              </button>
              <button className="btn sm" onClick={() => void reload(doc)}>
                Reload theirs
              </button>
              <button className="btn sm ghost" onClick={() => ((doc.stale = false), bump())}>
                Keep mine
              </button>
            </div>
          )}
          {doc?.merging && (
            <div className="banner fe-banner">
              <span className="dot working" />
              <div className="grow">
                {doc.merging.name} is merging your edits into this file. It's read-only until the merged version lands.
              </div>
              <button className="btn sm" onClick={() => doc.merging && focusSessionTab(doc.merging.sessionId)}>
                Open chat
              </button>
              <button className="btn sm ghost" title="Stop waiting and keep editing your version" onClick={() => cancelMerge(doc)}>
                Cancel
              </button>
            </div>
          )}
          <div className="fe-editor-row">
            <div className="fe-cm" ref={host} style={doc ? undefined : { display: 'none' }} />
            {!doc && <Welcome root={root} onQuickOpen={a.quickOpen} onSearch={a.findInFiles} onNew={a.newFile} />}
            {prefs.symbols && doc && (
              <aside className="fe-symbols">
                <input className="input" value={symFilter} placeholder={`Filter ${symbols.length} symbols`} onChange={(e) => setSymFilter(e.target.value)} />
                <div className="fe-symbol-list">
                  {!symbols.length && <div className="empty-note">No symbols found.</div>}
                  {filteredSymbols.map((s, i) => (
                    <SymbolRow key={i} s={s} active={s === currentSymbol} indent={!symFilter} onClick={() => jump(s.line)} />
                  ))}
                </div>
              </aside>
            )}
            {picker === 'symbols' && (
              <Picker<SymbolInfo>
                placeholder="Go to symbol…"
                items={symbols}
                text={(s) => s.name}
                render={(s, on) => <SymbolRow s={s} active={on} indent={false} onClick={() => undefined} />}
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
            {picker === 'files' && (
              <Picker<string>
                placeholder={files ? `Go to file in ${root ? baseName(root) : 'project'}…` : 'Loading files…'}
                items={files ?? []}
                text={(f) => f}
                fuzzy
                render={(f, on) => (
                  <div className={`list-item ${on ? 'active' : ''}`}>
                    <Icon name="file" size={13} style={{ color: 'var(--muted)' }} />
                    <span className="ellipsis">{baseName(f)}</span>
                    <span className="sub ellipsis">{f.split('/').slice(0, -1).join('/')}</span>
                  </div>
                )}
                onPick={(f) => {
                  setPicker(false)
                  void openFile(abs(f))
                }}
                onClose={() => {
                  setPicker(false)
                  view.current?.focus()
                }}
              />
            )}
          </div>
          {showProblems && doc?.tsPath && (
            <div className="fe-problems">
              <div className="fe-problems-head">
                <span className="grow">
                  Problems · {errorCount} error{errorCount === 1 ? '' : 's'}, {otherCount} other
                </span>
                <button className="btn sm" disabled={!errorCount} title="Save, then send these errors to the project's most recent Claude chat to fix" onClick={() => void a.fixWithClaude()}>
                  <Icon name="sparkles" size={12} /> Fix {errorCount || ''} error{errorCount === 1 ? '' : 's'} with Claude
                </button>
                <button className="icon-btn sm" title="Close" onClick={() => setShowProblems(false)}>
                  <Icon name="x" size={12} />
                </button>
              </div>
              <div className="fe-problems-list">
                {!problems?.length && <div className="empty-note">{problems ? 'No problems in this file.' : 'Checking…'}</div>}
                {problems?.map((pr, i) => (
                  <div key={i} className="fe-problem" title={pr.message} onClick={() => jump(pr.line, pr.col)}>
                    <span className={`fe-sev ${pr.severity}`}>{pr.severity === 'error' ? '×' : pr.severity === 'warning' ? '!' : 'i'}</span>
                    <span className="msg">{pr.message}</span>
                    <span className="where">
                      ts({pr.code}) [{pr.line}:{pr.col}]
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {prefs.status && (
        <div className="fe-status">
          {doc ? (
            <>
              <span>
                Ln {cursor.line}, Col {cursor.col}
              </span>
              {cursor.sel > 0 && <span>{cursor.sel} selected</span>}
              {doc.diff && <span className="fe-status-diff">Edit Diff · {changeCount} change{changeCount === 1 ? '' : 's'}</span>}
              {doc.tsPath && (
                <button className="fe-status-btn fe-status-problems" title="Problems (TypeScript). Click to show the list; F12 or Ctrl+click goes to a definition" onClick={a.toggleProblems}>
                  {problems ? (
                    <>
                      <span className={errorCount ? 'err' : ''}>⊗ {errorCount}</span> <span className={otherCount ? 'warn' : ''}>⚠ {otherCount}</span>
                    </>
                  ) : (
                    'TS…'
                  )}
                </button>
              )}
              {errorCount > 0 && (
                <button className="fe-status-btn" title="Save, then send this file's errors to the project's most recent Claude chat to fix" onClick={() => void a.fixWithClaude()}>
                  <Icon name="sparkles" size={11} /> Fix with Claude
                </button>
              )}
              <span className="grow" />
              <span>
                {cursor.lines} lines · {cursor.chars} characters
              </span>
              <span>{doc.lang}</span>
              <button className="fe-status-btn" title="Zoom (click to reset)" onClick={a.zoomReset}>
                {prefs.zoom}%
              </button>
              <button className="fe-status-btn" title="Line endings (click to switch)" onClick={switchEol}>
                {doc.meta.eol === 'CRLF' ? 'CRLF' : 'LF'}
              </button>
              <span>{doc.meta.bom ? 'UTF-8 with BOM' : 'UTF-8'}</span>
            </>
          ) : (
            <span className="grow">{root ?? ''}</span>
          )}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ welcome
function Welcome({ root, onQuickOpen, onSearch, onNew }: { root?: string; onQuickOpen: () => unknown; onSearch: () => unknown; onNew: () => unknown }) {
  return (
    <div className="fe-welcome">
      <Icon name="code" size={34} style={{ color: 'var(--muted)' }} />
      <h2>{root ? baseName(root) : 'Editor'}</h2>
      <div className="fe-welcome-actions">
        <button className="btn" onClick={() => void onQuickOpen()}>
          <Icon name="search" size={13} /> Go to file <kbd>{mod}P</kbd>
        </button>
        <button className="btn" onClick={() => void onSearch()}>
          <Icon name="search" size={13} /> Find in files <kbd>{mod}Shift+F</kbd>
        </button>
        <button className="btn" onClick={() => void onNew()}>
          <Icon name="plus" size={13} /> New file <kbd>{mod}N</kbd>
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Open a file from the explorer. In Review, the file buttons open files here, or straight into Edit Diff.
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ explorer
interface TreeNode {
  name: string
  path: string
  dirs: Map<string, TreeNode>
  files: string[]
}

function buildTree(files: string[]): TreeNode {
  const top: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.split('/')
    let n = top
    for (let i = 0; i < parts.length - 1; i++) {
      let next = n.dirs.get(parts[i])
      if (!next) {
        next = { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] }
        n.dirs.set(parts[i], next)
      }
      n = next
    }
    n.files.push(f)
  }
  return top
}

function Explorer({ root, files, activePath, onOpen, onRefresh }: { root?: string; files: string[] | null; activePath?: string; onOpen: (rel: string) => void; onRefresh: () => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [q, setQ] = useState('')
  const tree = useMemo(() => buildTree(files ?? []), [files])
  // Reveal the active file.
  useEffect(() => {
    if (!activePath) return
    const parts = activePath.split('/')
    setOpen((o) => {
      const next = new Set(o)
      for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join('/'))
      return next
    })
  }, [activePath])
  const toggle = (p: string): void =>
    setOpen((o) => {
      const next = new Set(o)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  const ql = q.trim().toLowerCase()
  const fileRow = (f: string, depth: number, showDir = false) => (
    <div
      key={f}
      className={`fe-node ${activePath === f ? 'active' : ''}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      title={f}
      onClick={() => onOpen(f)}
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Open', icon: 'file', onClick: () => onOpen(f) },
          { label: 'Open in VS Code / external editor', icon: 'code', onClick: () => root && api.shell.openInEditor(`${root}/${f}`) },
          { label: 'Reveal in folder', icon: 'folder-open', onClick: () => root && api.shell.showItem(`${root}/${f}`) },
          { label: 'Copy relative path', icon: 'copy', onClick: () => api.clipboard.writeText(f) }
        ])
      }
    >
      <Icon name="file" size={13} style={{ color: 'var(--muted)' }} />
      <span className="ellipsis">{f.split('/').pop()}</span>
      {showDir && <span className="sub ellipsis">{f.split('/').slice(0, -1).join('/')}</span>}
    </div>
  )
  const renderDir = (n: TreeNode, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = []
    for (const d of [...n.dirs.values()].sort((x, y) => x.name.localeCompare(y.name))) {
      const isOpen = open.has(d.path)
      out.push(
        <div key={`d:${d.path}`} className="fe-node dir" style={{ paddingLeft: 8 + depth * 12 }} onClick={() => toggle(d.path)} title={d.path}>
          <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} style={{ color: 'var(--muted)' }} />
          <Icon name="folder" size={13} style={{ color: 'var(--accent)' }} />
          <span className="ellipsis">{d.name}</span>
        </div>
      )
      if (isOpen) out.push(...renderDir(d, depth + 1))
    }
    for (const f of [...n.files].sort((x, y) => x.localeCompare(y))) out.push(fileRow(f, depth + 1))
    return out
  }
  return (
    <aside className="fe-side">
      <div className="fe-side-head">
        <span className="grow ellipsis">{root ? baseName(root) : 'Explorer'}</span>
        <button className="icon-btn sm" title="Collapse folders" onClick={() => setOpen(new Set())}>
          <Icon name="minus" size={12} />
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={onRefresh}>
          <Icon name="refresh" size={12} />
        </button>
      </div>
      <input className="input fe-side-input" value={q} placeholder="Filter files" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setQ('')} />
      <div className="fe-side-body">
        {!root && <div className="empty-note">Open a project to browse its files.</div>}
        {root && files === null && <div className="empty-note">Loading files…</div>}
        {root && files && !files.length && <div className="empty-note">No files.</div>}
        {ql ? (files ?? []).filter((f) => f.toLowerCase().includes(ql)).slice(0, 300).map((f) => fileRow(f, 0, true)) : renderDir(tree, 0)}
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------ find in files
type Hit = { path: string; line: number; text: string }

function SearchPanel({ root, onOpen }: { root?: string; onOpen: (rel: string, line: number) => void }) {
  const [q, setQ] = useState('')
  const [opts, setOpts] = useState({ caseSensitive: false, wholeWord: false, regex: false })
  const [res, setRes] = useState<{ results: Hit[]; truncated: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const run = async (): Promise<void> => {
    if (!root || !q.trim()) return
    setBusy(true)
    setErr('')
    try {
      setRes(await api.fs.grep(root, q, opts))
      setFolded(new Set())
    } catch (e) {
      setErr(errMsg(e))
      setRes(null)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (res) void run()
  }, [opts])
  const groups = useMemo(() => {
    const m = new Map<string, Hit[]>()
    for (const h of res?.results ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h])
    return [...m.entries()]
  }, [res])
  const toggle = (k: keyof typeof opts, label: string, title: string) => (
    <button className={`fe-opt ${opts[k] ? 'on' : ''}`} title={title} onClick={() => setOpts((o) => ({ ...o, [k]: !o[k] }))}>
      {label}
    </button>
  )
  return (
    <aside className="fe-side">
      <div className="fe-side-head">
        <span className="grow">Find in files</span>
        {busy && <span className="dot working" />}
      </div>
      <div className="fe-search-row">
        <input className="input fe-search-input" value={q} placeholder="Search" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
        {toggle('caseSensitive', 'Aa', 'Match case')}
        {toggle('wholeWord', 'ab', 'Whole word')}
        {toggle('regex', '.*', 'Regular expression')}
      </div>
      <div className="fe-side-body">
        {!root && <div className="empty-note">Open a project to search it.</div>}
        {err && <div className="empty-note" style={{ color: 'var(--danger)' }}>{err}</div>}
        {res && (
          <div className="sub" style={{ padding: '2px 8px 6px' }}>
            {res.results.length} result{res.results.length === 1 ? '' : 's'} in {groups.length} file{groups.length === 1 ? '' : 's'}
            {res.truncated ? ' (first 2000 shown)' : ''}
          </div>
        )}
        {groups.map(([p, hits]) => (
          <div key={p}>
            <div
              className="fe-node dir"
              title={p}
              onClick={() =>
                setFolded((f) => {
                  const n = new Set(f)
                  if (n.has(p)) n.delete(p)
                  else n.add(p)
                  return n
                })
              }
            >
              <Icon name={folded.has(p) ? 'chevron-right' : 'chevron-down'} size={12} style={{ color: 'var(--muted)' }} />
              <span className="ellipsis">{p.split('/').pop()}</span>
              <span className="sub ellipsis">{p.split('/').slice(0, -1).join('/')}</span>
              <span className="badge">{hits.length}</span>
            </div>
            {!folded.has(p) &&
              hits.map((h, i) => (
                <div key={i} className="fe-node fe-hit" style={{ paddingLeft: 26 }} onClick={() => onOpen(h.path, h.line)} title={`${p}:${h.line}`}>
                  <span className="sub">{h.line}</span>
                  <span className="ellipsis mono">{h.text.trim()}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

// ------------------------------------------------------------------ pickers
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

/** Characters of `q` in order within `s`; lower is better, -1 = no match. Favors matches in the file name. */
function fuzzyScore(s: string, q: string): number {
  const t = s.toLowerCase()
  let at = -1
  let gaps = 0
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1)
    if (i < 0) return -1
    gaps += i - at - 1
    at = i
  }
  const name = t.slice(t.lastIndexOf('/') + 1)
  return gaps + (name.includes(q) ? 0 : 50) + t.length / 100
}

function Picker<T>({ placeholder, items, text, render, onPick, onClose, fuzzy }: { placeholder: string; items: T[]; text: (t: T) => string; render: (t: T, active: boolean) => React.ReactNode; onPick: (t: T) => void; onClose: () => void; fuzzy?: boolean }) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const list = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/\s+/g, '')
    if (!t) return items.slice(0, 200)
    if (fuzzy)
      return items
        .map((it) => [it, fuzzyScore(text(it), t)] as const)
        .filter(([, s]) => s >= 0)
        .sort((x, y) => x[1] - y[1])
        .slice(0, 200)
        .map(([it]) => it)
    return items.filter((it) => text(it).toLowerCase().includes(t)).sort((x, y) => Number(!text(x).toLowerCase().startsWith(t)) - Number(!text(y).toLowerCase().startsWith(t)))
  }, [items, q])
  useEffect(() => setSel(0), [q])
  return (
    <div className="fe-picker">
      <input
        className="input"
        autoFocus
        value={q}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onBlur={onClose}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setSel((i) => Math.min(list.length - 1, i + 1)))
          else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((i) => Math.max(0, i - 1)))
          else if (e.key === 'Enter' && list[sel] !== undefined) onPick(list[sel])
          else if (e.key === 'Escape') onClose()
        }}
      />
      <div className="fe-picker-list">
        {!list.length && <div className="empty-note">No matches.</div>}
        {list.map((it, i) => (
          <div key={i} onMouseDown={(e) => (e.preventDefault(), onPick(it))} onMouseMove={() => setSel(i)}>
            {render(it, i === sel)}
          </div>
        ))}
      </div>
    </div>
  )
}
