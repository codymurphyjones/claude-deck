import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import { EditorView, basicSetup } from 'codemirror'
import { EditorState, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { api, bridge, type LiveSession } from '../api'
import { askText, attempt, set, toast, useStore } from '../store'
import { Icon } from './Icon'
import { Seg } from './ui'
import { resolveTheme } from '../theme'

export const fileUrl = (p: string): string => 'deck-file://local/' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')

const ext = (p: string): string => (p.split('.').pop() ?? '').toLowerCase()
const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']

function langFor(p: string): Extension[] {
  const e = ext(p)
  if (['js', 'jsx', 'mjs', 'cjs'].includes(e)) return [javascript({ jsx: true })]
  if (['ts', 'tsx', 'mts', 'cts'].includes(e)) return [javascript({ jsx: true, typescript: true })]
  if (e === 'py') return [python()]
  if (e === 'json' || e === 'jsonc') return [json()]
  if (e === 'md' || e === 'mdx') return [markdown()]
  if (e === 'html' || e === 'htm' || e === 'vue' || e === 'svelte') return [html()]
  if (e === 'css' || e === 'scss' || e === 'less') return [css()]
  return []
}

function parseCsv(text: string, sep: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let q = false
  for (let i = 0; i < text.length && rows.length < 2000; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') q = false
      else cell += c
    } else if (c === '"') q = true
    else if (c === sep) {
      row.push(cell)
      cell = ''
    } else if (c === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

function CodeView({ path, content, dark, onSave, onSelection }: { path: string; content: string; dark: boolean; onSave: (t: string) => void; onSelection: (sel: { from: number; to: number; text: string } | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  useEffect(() => {
    if (!host.current) return
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          ...langFor(path),
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
    return () => v.destroy()
  }, [path, dark])
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== content) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } })
  }, [content])
  return <div className="cm-host" ref={host} />
}

export function FilesPanel({ session }: { session?: LiveSession }) {
  const toOpen = useStore((s) => s.fileToOpen)
  const dark = useStore((s) => resolveTheme(s.settings, s.systemDark).dark)
  const [path, setPath] = useState<string | undefined>(session?.files[0])
  const [content, setContent] = useState<{ binary: boolean; content: string; size: number } | null>(null)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [sel, setSel] = useState<{ from: number; to: number; text: string } | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (toOpen) {
      setPath(toOpen.path)
      set({ fileToOpen: undefined })
    }
  }, [toOpen])
  useEffect(() => {
    if (!path && session?.files[0]) setPath(session.files[0])
  }, [session?.files])
  useEffect(() => {
    if (!path) return
    setContent(null)
    setSel(null)
    const e = ext(path)
    if (IMG.includes(e) || e === 'pdf') {
      setContent({ binary: true, content: '', size: 0 })
      return
    }
    api.fs.readFile(path).then(setContent, () => setContent({ binary: true, content: '', size: 0 }))
  }, [path, version])
  useEffect(
    () =>
      bridge.on('session:fileTouched', (ev: { path: string }) => {
        if (ev.path.toLowerCase() === path?.toLowerCase()) setVersion((v) => v + 1)
      }),
    [path]
  )

  const e = path ? ext(path) : ''
  const renderable = ['md', 'markdown', 'html', 'htm', 'csv', 'tsv'].includes(e) || IMG.includes(e) || e === 'pdf'
  const md = useMemo(() => (content && (e === 'md' || e === 'markdown') ? (marked.parse(content.content) as string) : ''), [content, e])

  const askRevision = async (): Promise<void> => {
    if (!session || !path) return
    const rendered = mode === 'rendered' ? window.getSelection()?.toString() : ''
    const snippet = sel?.text || rendered || ''
    const note = await askText(snippet ? 'What should Claude change about the selection?' : `What should Claude change in ${path.split(/[\\/]/).pop()}?`, '', { multiline: true })
    if (!note) return
    const where = sel ? ` (lines ${sel.from}-${sel.to})` : ''
    const prompt = `In ${path}${where}${snippet ? `, regarding this part:\n\n${snippet.slice(0, 2000)}\n\n` : ': '}${note}`
    await api.session.sendPrompt(session.id, prompt)
    toast('Sent to Claude', 'success')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="col" style={{ padding: '8px 10px', gap: 6, borderBottom: '1px solid var(--border)' }}>
        <div className="row" style={{ gap: 4 }}>
          <select className="select" style={{ flex: 1 }} value={path ?? ''} onChange={(ev) => setPath(ev.target.value || undefined)}>
            <option value="">{session?.files.length ? 'Files Claude touched…' : 'No files touched yet'}</option>
            {path && !session?.files.includes(path) && <option value={path}>{path}</option>}
            {session?.files.map((f) => (
              <option key={f} value={f}>
                {f.replace(session.root, '').replace(/^[\\/]/, '') || f}
              </option>
            ))}
          </select>
          <button className="icon-btn sm" title="Open a file…" onClick={async () => setPath((await api.dialog.openFile()) ?? path)}>
            <Icon name="folder-open" size={14} />
          </button>
          {path && (
            <>
              <button className="icon-btn sm" title="Open in editor" onClick={() => api.shell.openInEditor(path)}>
                <Icon name="code" size={14} />
              </button>
              <button className="icon-btn sm" title="Reload" onClick={() => setVersion((v) => v + 1)}>
                <Icon name="refresh" size={14} />
              </button>
            </>
          )}
        </div>
        {path && (
          <div className="row" style={{ gap: 6 }}>
            {renderable && !IMG.includes(e) && e !== 'pdf' && (
              <Seg
                value={mode}
                onChange={setMode}
                options={[
                  ['rendered', 'Preview'],
                  ['source', 'Source']
                ]}
              />
            )}
            <span className="grow" />
            {session && (
              <button className="btn sm primary" onClick={askRevision} title="Select text, then ask Claude for a targeted change">
                <Icon name="sparkles" size={12} /> {sel || mode === 'rendered' ? 'Revise selection' : 'Ask for changes'}
              </button>
            )}
          </div>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {!path && <div className="empty-note">Files Claude creates or edits show up here. Turn on “Open generated files automatically” in Settings to follow along live.</div>}
        {path && !content && <div className="empty-note">Loading…</div>}
        {path && content && IMG.includes(e) && (
          <div style={{ padding: 12, display: 'grid', placeItems: 'center' }}>
            <img src={fileUrl(path) + `?v=${version}`} style={{ maxWidth: '100%', borderRadius: 8, boxShadow: 'var(--shadow)' }} />
          </div>
        )}
        {path && content && e === 'pdf' && <iframe className="viewer-frame" src={fileUrl(path)} />}
        {path && content && !content.binary && (
          <>
            {mode === 'rendered' && (e === 'md' || e === 'markdown') && <div className="md" dangerouslySetInnerHTML={{ __html: md }} />}
            {mode === 'rendered' && (e === 'html' || e === 'htm') && <iframe className="viewer-frame" sandbox="allow-scripts allow-same-origin allow-forms" src={fileUrl(path) + `?v=${version}`} />}
            {mode === 'rendered' && (e === 'csv' || e === 'tsv') && (
              <div style={{ padding: 8, overflow: 'auto' }}>
                <table className="csv-table">
                  <tbody>
                    {parseCsv(content.content, e === 'tsv' ? '\t' : ',').map((r, i) => (
                      <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(mode === 'source' || !renderable) && (
              <CodeView
                path={path}
                content={content.content}
                dark={dark}
                onSelection={setSel}
                onSave={(t) => attempt(() => api.fs.writeFile(path, t), 'Saved')}
              />
            )}
          </>
        )}
        {path && content?.binary && !IMG.includes(e) && e !== 'pdf' && (
          <div className="empty-note">
            Binary or very large file.{' '}
            <button className="btn sm" onClick={() => api.shell.openPath(path)}>
              Open externally
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
