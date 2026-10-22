import { memo, useDeferredValue, useEffect, useMemo, useRef } from 'react'
import { api } from '../api'
import { toast } from '../store'
import { renderChart } from './chart'
import { renderMarkdown } from './mdRender'

let mermaidLoader: Promise<typeof import('mermaid').default> | undefined
let mermaidSeq = 0

function loadMermaid(dark: boolean) {
  mermaidLoader ??= import('mermaid').then((m) => m.default)
  return mermaidLoader.then((mm) => {
    mm.initialize({ startOnLoad: false, theme: dark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' })
    return mm
  })
}

/** Resolve a path Claude mentioned against the session folder. */
export function resolvePath(p: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\')) return p
  return `${cwd.replace(/[\\/]+$/, '')}\\${p.replace(/^\.[\\/]/, '').replace(/\//g, '\\')}`
}

/** Delegated clicks inside rendered markdown: copy buttons, file links, external links. */
export function handleMarkdownClick(e: React.MouseEvent, cwd: string): void {
  const t = e.target as HTMLElement
  const copy = t.closest('[data-copy]') as HTMLElement | null
  if (copy) {
    e.preventDefault()
    void api.clipboard.writeText(copy.dataset.copy ?? '')
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy'), 1200)
    return
  }
  const ref = t.closest('[data-path]') as HTMLElement | null
  if (ref) {
    e.preventDefault()
    const line = ref.dataset.line ? Number(ref.dataset.line) : undefined
    void api.shell.openInEditor(resolvePath(ref.dataset.path ?? '', cwd), line).catch(() => toast('Could not open that file', 'error'))
    return
  }
  const a = t.closest('a.ext-link') as HTMLAnchorElement | null
  if (a) {
    e.preventDefault()
    void api.shell.openExternal(a.getAttribute('href') ?? '')
  }
}

export const Markdown = memo(function Markdown({ text, streaming, cwd, dark }: { text: string; streaming?: boolean; cwd: string; dark: boolean }) {
  const deferred = useDeferredValue(text)
  const html = useMemo(() => renderMarkdown(deferred, streaming), [deferred, streaming])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || streaming) return
    for (const node of el.querySelectorAll<HTMLElement>('.md-chart:not([data-done])')) {
      node.dataset.done = '1'
      node.innerHTML = renderChart(node.querySelector('.md-src')?.textContent ?? '')
    }
    const diagrams = [...el.querySelectorAll<HTMLElement>('.md-mermaid:not([data-done])')]
    if (!diagrams.length) return
    void loadMermaid(dark).then(async (mm) => {
      for (const node of diagrams) {
        node.dataset.done = '1'
        try {
          const { svg } = await mm.render(`mmd-${++mermaidSeq}`, node.querySelector('.md-src')?.textContent ?? '')
          node.innerHTML = svg
        } catch (err) {
          node.classList.add('md-mermaid-error')
          node.title = String((err as Error).message ?? err)
        }
      }
    })
  }, [html, streaming, dark])

  return <div ref={ref} className={`md-body ${streaming ? 'streaming' : ''}`} onClick={(e) => handleMarkdownClick(e, cwd)} dangerouslySetInnerHTML={{ __html: html }} />
})
