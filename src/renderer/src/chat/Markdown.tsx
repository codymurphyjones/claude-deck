import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { toast } from '../store'
import { renderChart } from './chart'
import { renderMarkdown } from './mdRender'
import { useRenderVersion } from '../lazyRender'

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

/**
 * While streaming, re-render at most every few times the last render's cost (each render parses
 * the whole message so far), so long responses keep the UI responsive. Final text shows at once.
 */
function useStreamThrottle(text: string, streaming: boolean | undefined, costMs: React.RefObject<number>): string {
  const [shown, setShown] = useState(text)
  const last = useRef(0)
  useEffect(() => {
    if (!streaming) return
    const interval = Math.min(1000, Math.max(60, costMs.current * 5))
    const t = setTimeout(
      () => {
        last.current = performance.now()
        setShown(text)
      },
      Math.max(0, last.current + interval - performance.now())
    )
    return () => clearTimeout(t)
  }, [text, streaming, costMs])
  return streaming ? shown : text
}

export const Markdown = memo(function Markdown({ text, streaming, cwd, dark }: { text: string; streaming?: boolean; cwd: string; dark: boolean }) {
  const cost = useRef(0)
  const deferred = useDeferredValue(useStreamThrottle(text, streaming, cost))
  // Bumps when on-demand languages / KaTeX finish loading, so this re-renders with them.
  const rv = useRenderVersion()
  const html = useMemo(() => {
    const t0 = performance.now()
    const out = renderMarkdown(deferred, streaming)
    cost.current = performance.now() - t0
    return out
  }, [deferred, streaming, rv])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || streaming) return
    for (const node of el.querySelectorAll<HTMLElement>('.md-chart:not([data-done])')) {
      node.dataset.done = '1'
      node.dataset.src = node.querySelector('.md-src')?.textContent ?? ''
      node.innerHTML = renderChart(node.dataset.src)
    }
    const diagrams = [...el.querySelectorAll<HTMLElement>('.md-mermaid:not([data-done])')]
    if (!diagrams.length) return
    void loadMermaid(dark).then(async (mm) => {
      for (const node of diagrams) {
        node.dataset.done = '1'
        // Keep the source around for "Copy as Markdown" once the diagram replaces it.
        node.dataset.src = node.querySelector('.md-src')?.textContent ?? ''
        try {
          const { svg } = await mm.render(`mmd-${++mermaidSeq}`, node.dataset.src)
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
