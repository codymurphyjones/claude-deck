import { useEffect, useRef } from 'react'
import { EditorView, basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { openSearchPanel } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { loadLanguage } from '../cmLanguage'

// The Files panel's source view. Its own module so CodeMirror loads only when a file's source is
// first shown, not at app startup (FilesPanel imports it with React.lazy).

export { openSearchPanel }

export default function CodeView({
  path,
  content,
  dark,
  onSave,
  onSelection,
  view
}: {
  path: string
  content: string
  dark: boolean
  onSave: (t: string) => void
  onSelection: (sel: { from: number; to: number; text: string } | null) => void
  view: React.MutableRefObject<EditorView | null>
}) {
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current) return
    const lang = new Compartment()
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          lang.of([]),
          ...(dark ? [oneDark] : []),
          EditorView.theme({ '&': { backgroundColor: 'var(--bg)' }, '.cm-gutters': { backgroundColor: 'var(--panel)', borderRight: '1px solid var(--border)' } }),
          keymap.of([
            {
              key: 'Mod-s',
              run: (vw) => {
                onSave(vw.state.doc.toString())
                return true
              }
            }
          ]),
          EditorView.updateListener.of((u) => {
            if (!u.selectionSet) return
            const r = u.state.selection.main
            if (r.empty) onSelection(null)
            else onSelection({ from: u.state.doc.lineAt(r.from).number, to: u.state.doc.lineAt(r.to).number, text: u.state.sliceDoc(r.from, r.to) })
          })
        ]
      })
    })
    view.current = v
    // Language support loads on demand (any of ~150 languages).
    void loadLanguage(path, content.slice(0, 200).split('\n', 1)[0]).then((l) => l && view.current === v && v.dispatch({ effects: lang.reconfigure(l.support) }))
    return () => {
      v.destroy()
      if (view.current === v) view.current = null
    }
  }, [path, dark])
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== content) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } })
  }, [content])
  return <div className="cm-host" ref={host} />
}
