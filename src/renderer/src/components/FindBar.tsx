import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { clearMatches, findRanges, paintMatches, registerFindScope, revealRange } from '../find'
import { Icon } from './Icon'

// Only one find bar is open at a time: highlights are window-wide.
let closeActive: (() => void) | null = null

function FindBar({ root, focusKey, onClose }: { root: () => HTMLElement | null; focusKey: number; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  const returnTo = useRef(document.activeElement as HTMLElement | null)
  const [q, setQ] = useState(() => {
    const sel = window.getSelection()?.toString() ?? ''
    return sel.length < 200 && !sel.includes('\n') ? sel.trim() : ''
  })
  const [pos, setPos] = useState({ index: 0, total: 0 })
  const ranges = useRef<Range[]>([])
  const index = useRef(0)

  const show = (i: number, reveal: boolean): void => {
    const n = ranges.current.length
    index.current = n ? (i + n) % n : 0
    paintMatches(ranges.current, index.current)
    if (reveal && n) revealRange(ranges.current[index.current])
    setPos({ index: index.current, total: n })
  }
  const run = (keep: boolean): void => {
    const el = root()
    ranges.current = el && q ? findRanges(el, q) : []
    show(keep ? Math.min(index.current, ranges.current.length - 1) : 0, !keep)
  }

  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusKey])

  useEffect(() => run(false), [q])

  // Content keeps changing (streaming replies, reloaded diffs): re-run quietly.
  useEffect(() => {
    const el = root()
    if (!el || !q) return
    let t: ReturnType<typeof setTimeout> | undefined
    const mo = new MutationObserver((recs) => {
      if (recs.every((r) => (r.target instanceof Element ? r.target : r.target.parentElement)?.closest('.search-bar'))) return
      clearTimeout(t)
      t = setTimeout(() => run(true), 150)
    })
    mo.observe(el, { subtree: true, childList: true, characterData: true })
    return () => {
      mo.disconnect()
      clearTimeout(t)
    }
  }, [q])

  const close = useCallback((): void => {
    onClose()
    const back = returnTo.current
    if (back?.isConnected && back !== document.body) back.focus()
  }, [onClose])

  useEffect(() => {
    closeActive?.()
    closeActive = onClose
    return () => {
      // A bar closed because another opened must not wipe the new bar's highlights.
      if (closeActive !== onClose) return
      closeActive = null
      clearMatches()
    }
  }, [onClose])

  return (
    <div className="find-anchor">
      <div className="search-bar">
        <input
          ref={input}
          className="input"
          placeholder="Find…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              show(index.current + (e.shiftKey ? -1 : 1), true)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              close()
            }
          }}
        />
        <span className="find-count">{q ? (pos.total ? `${pos.index + 1} / ${pos.total}` : 'No results') : ''}</span>
        <button className="icon-btn sm" title="Previous (Shift+Enter)" disabled={!pos.total} onClick={() => show(index.current - 1, true)}>
          <Icon name="chevron-left" size={14} />
        </button>
        <button className="icon-btn sm" title="Next (Enter)" disabled={!pos.total} onClick={() => show(index.current + 1, true)}>
          <Icon name="chevron-right" size={14} />
        </button>
        <button className="icon-btn sm" title="Close (Esc)" onClick={close}>
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Ctrl+F support for a DOM view. Pass `scope` as the view root's ref; render `bar` inside it.
 * Matches are searched under `searchRoot` (defaults to the scope). `override` can claim the
 * request instead (e.g. to open CodeMirror's own search) by returning true.
 */
export function useFind(opts: { searchRoot?: () => HTMLElement | null; override?: () => boolean } = {}): {
  scope: (el: HTMLElement | null) => (() => void) | undefined
  bar: ReactNode
  open: () => void
} {
  const [focusKey, setFocusKey] = useState(0)
  const [isOpen, setOpen] = useState(false)
  const rootEl = useRef<HTMLElement | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const open = useCallback(() => {
    if (optsRef.current.override?.()) return
    setOpen(true)
    setFocusKey((k) => k + 1)
  }, [])
  const scope = useCallback(
    (el: HTMLElement | null) => {
      rootEl.current = el
      if (!el) return
      const off = registerFindScope(el, open)
      return () => {
        off()
        rootEl.current = null
      }
    },
    [open]
  )
  const onClose = useCallback(() => setOpen(false), [])
  const root = useCallback(() => optsRef.current.searchRoot?.() ?? rootEl.current, [])
  return { scope, open, bar: isOpen ? <FindBar root={root} focusKey={focusKey} onClose={onClose} /> : null }
}
