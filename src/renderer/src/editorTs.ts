import { insertCompletionText, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import { EditorState, Prec, type Extension, type Text } from '@codemirror/state'
import { EditorView, hoverTooltip, keymap } from '@codemirror/view'
import type { TsCompletion, TsDiagnostic, TsLocation } from '@shared/tsLang'
import { api } from './api'
import { highlight } from './highlight'
import './editorTs.css'

// TypeScript / JavaScript intelligence in the editor, backed by the language service in the main
// process' TypeScript worker (src/main/lsp): live diagnostics, hover info, completions and go to
// definition (F12 / Ctrl+click, Cmd+click on macOS). One extension per open document; FileEditor puts
// it in a compartment so other files are untouched.
//
// The worker keeps an overlay of each open document's text. Before every request the current text is
// sent if it changed since the last send, so answers always match the editor (unsaved edits included).
// Answers for an older text are dropped (the linter re-runs on change; hovers/completions check).

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
/** Bigger documents get no TypeScript support (keeps typing and IPC cheap). */
export const MAX_TS_CHARS = 1_500_000

export const isTsPath = (p?: string): boolean => !!p && TS_FILE.test(p)

const isMac = navigator.platform.startsWith('Mac')

/** Per file: the document text last sent to the worker (immutable CodeMirror Text, so identity works). */
const sent = new Map<string, Text>()
/** Folders where no TypeScript could be loaded: stop asking. */
const unavailable = new Set<string>()

async function sync(file: string, root: string | undefined, doc: Text): Promise<boolean> {
  if (doc.length > MAX_TS_CHARS || unavailable.has(root ?? '')) return false
  if (sent.get(file) === doc) return true
  sent.set(file, doc)
  try {
    const r = await api.ts.update(file, doc.toString(), root)
    if (!r.available) {
      unavailable.add(root ?? '')
      sent.delete(file)
      return false
    }
    return true
  } catch {
    sent.delete(file)
    return false
  }
}

/** Tell the worker a document closed (drops its unsaved text). */
export function closeTsDoc(file: string): void {
  if (!sent.delete(file)) return
  void api.ts.close(file).catch(() => undefined)
}

export interface TsHooks {
  /** The latest diagnostics for the document (for the Problems list / status bar). */
  onDiagnostics: (diags: TsDiagnostic[]) => void
  /** Go to a definition (may be another file). */
  onDefinition: (loc: TsLocation) => void
  /** No definition found. */
  onNoDefinition: () => void
}

const KIND_TYPE: Record<string, string> = {
  keyword: 'keyword',
  'primitive type': 'type',
  module: 'namespace',
  'external module name': 'namespace',
  class: 'class',
  'local class': 'class',
  interface: 'interface',
  type: 'type',
  enum: 'enum',
  'enum member': 'enum',
  var: 'variable',
  'local var': 'variable',
  let: 'variable',
  const: 'constant',
  parameter: 'variable',
  function: 'function',
  'local function': 'function',
  method: 'method',
  property: 'property',
  getter: 'property',
  setter: 'property',
  constructor: 'class',
  alias: 'variable',
  string: 'text'
}

function infoDom(text: string, doc: string): HTMLElement {
  const box = document.createElement('div')
  box.className = 'cm-ts-info'
  if (text) {
    const code = document.createElement('pre')
    code.className = 'cm-ts-sig hljs'
    code.innerHTML = highlight(text, 'typescript')
    box.appendChild(code)
  }
  if (doc) {
    const d = document.createElement('div')
    d.className = 'cm-ts-doc'
    d.textContent = doc
    box.appendChild(d)
  }
  return box
}

/** CodeMirror extensions giving `file` TypeScript support. `root` is the editor's folder. */
export function tsExtension(file: string, root: string | undefined, hooks: TsHooks): Extension {
  const lint = linter(
    async (view): Promise<Diagnostic[]> => {
      const doc = view.state.doc
      if (!(await sync(file, root, doc))) return []
      const diags = await api.ts.diagnostics(file).catch(() => null)
      // A newer text was sent meanwhile: the linter runs again for it.
      if (!diags || view.state.doc !== doc) return []
      hooks.onDiagnostics(diags)
      return diags.map((d) => ({
        from: Math.min(d.from, doc.length),
        to: Math.min(Math.max(d.to, d.from), doc.length),
        severity: d.severity,
        message: d.message,
        source: `ts(${d.code})`
      }))
    },
    { delay: 400 }
  )

  const hover = hoverTooltip(
    async (view, pos) => {
      const doc = view.state.doc
      if (!(await sync(file, root, doc))) return null
      const q = await api.ts.quickInfo(file, pos).catch(() => null)
      if (!q || view.state.doc !== doc) return null
      return { pos: q.from, end: q.to, above: true, create: () => ({ dom: infoDom(q.text, q.doc) }) }
    },
    { hoverTime: 350 }
  )

  const complete = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const word = ctx.matchBefore(/[\w$]+/)
    const prev = ctx.state.sliceDoc(Math.max(0, ctx.pos - 1), ctx.pos)
    if (!ctx.explicit && !word && prev !== '.') return null
    const doc = ctx.state.doc
    if (!(await sync(file, root, doc)) || ctx.aborted) return null
    const r = await api.ts.completions(file, ctx.pos, word?.text ?? '').catch(() => null)
    if (!r || ctx.aborted || !r.items.length) return null
    const options: Completion[] = r.items.map((it: TsCompletion, i) => ({
      label: it.name,
      type: KIND_TYPE[it.kind] ?? 'variable',
      // Keep TypeScript's ranking (locals before globals…) among equally good matches.
      boost: Math.max(-99, 50 - Number.parseInt(it.sortText, 10) * 2 || 0) - i / 10000,
      apply:
        it.insertText !== undefined || it.from !== undefined ? (view, _c, from, to) => view.dispatch(insertCompletionText(view.state, it.insertText ?? it.name, it.from ?? from, Math.max(it.to ?? to, to))) : undefined,
      info: async () => {
        const d = await api.ts.completionDetails(file, ctx.pos, it.name, it.source, it.data).catch(() => null)
        return d && (d.text || d.doc) ? infoDom(d.text, d.doc) : null
      }
    }))
    return { from: word ? word.from : ctx.pos, options, validFor: /^[\w$]*$/ }
  }

  const goToDefinition = async (view: EditorView, pos: number): Promise<void> => {
    const doc = view.state.doc
    if (!(await sync(file, root, doc))) return
    const defs = await api.ts.definition(file, pos).catch(() => null)
    if (view.state.doc !== doc) return
    if (defs?.length) hooks.onDefinition(defs[0])
    else hooks.onNoDefinition()
  }

  return [
    lint,
    lintGutter(),
    hover,
    EditorState.languageData.of(() => [{ autocomplete: complete }]),
    Prec.high(keymap.of([{ key: 'F12', run: (v) => (void goToDefinition(v, v.state.selection.main.head), true) }])),
    EditorView.domEventHandlers({
      mousedown: (e, view) => {
        if (e.button !== 0 || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey)) return false
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY })
        if (pos === null) return false
        e.preventDefault()
        view.dispatch({ selection: { anchor: pos } })
        void goToDefinition(view, pos)
        return true
      }
    }),
    EditorView.contentAttributes.of({ 'data-ts': 'on' })
  ]
}
