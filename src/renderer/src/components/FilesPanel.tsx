import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import type { EditorView } from '@codemirror/view'
import { api, bridge, type LiveSession } from '../api'
import { askText, attempt, openInEditor, set, toast, useStore } from '../store'
import { Icon } from './Icon'
import { Seg } from './ui'
import { useFind } from './FindBar'
import { resolveTheme } from '../theme'

// CodeMirror (the source view) loads on first use.
const loadCodeView = () => import('./FilesCodeView')
const CodeView = lazy(loadCodeView)

export const fileUrl = (p: string): string => 'deck-file://local/' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:')

const ext = (p: string): string => (p.split('.').pop() ?? '').toLowerCase()
const IMG = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico']

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

export function FilesPanel({ session }: { session?: LiveSession }) {
  const toOpen = useStore((s) => s.fileToOpen)
  const dark = useStore((s) => resolveTheme(s.settings, s.systemDark).dark)
  const [path, setPath] = useState<string | undefined>(session?.files[0])
  const [content, setContent] = useState<{ binary: boolean; content: string; size: number } | null>(null)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [sel, setSel] = useState<{ from: number; to: number; text: string } | null>(null)
  const [version, setVersion] = useState(0)
  const cm = useRef<EditorView | null>(null)
  const body = useRef<HTMLDivElement>(null)
  // Source view: CodeMirror's own search. Previews: the DOM find bar.
  const find = useFind({
    searchRoot: () => body.current,
    override: () => {
      if (!cm.current) return false
      // The view exists, so its module (with the search panel) has already loaded.
      void loadCodeView().then((m) => cm.current && m.openSearchPanel(cm.current))
      return true
    }
  })

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
    <div ref={find.scope} style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
          <button className="btn sm" title="Open in the editor tab" onClick={() => path && openInEditor(path)}>
            <Icon name="edit" size={13} /> Edit file
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
      <div ref={body} style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
        {find.bar}
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
              <Suspense fallback={<div className="empty-note">Loading…</div>}>
                <CodeView
                  path={path}
                  content={content.content}
                  dark={dark}
                  view={cm}
                  onSelection={setSel}
                  onSave={(t) => attempt(() => api.fs.writeFile(path, t), 'Saved')}
                />
              </Suspense>
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
