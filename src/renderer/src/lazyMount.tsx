import { createContext, useCallback, useContext, useEffect, useRef, useState, type RefObject } from 'react'

// Lazy mounting for long lists (chat history, diffs): items start as sized placeholders and render
// for good once scrolled near. One IntersectionObserver per list, shared through LazyCtx.

export type Observe = (el: Element, onNear: () => void) => () => void

export const LazyCtx = createContext<Observe | null>(null)

/** How far outside the visible area a placeholder starts rendering its content. */
const LAZY_MARGIN = '1500px 0px'

/** The nearest ancestor that scrolls vertically (the observer's root, so the margin applies to it). */
export function scrollParent(el: Element | null): Element | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY
    if (o === 'auto' || o === 'scroll') return p
  }
  return null
}

/** The observer for one list; `root` is resolved when the first placeholder registers. */
export function useLazyObserver(root: () => Element | null): Observe {
  const io = useRef<IntersectionObserver | null>(null)
  const cbs = useRef(new Map<Element, () => void>())
  const rootRef = useRef(root)
  rootRef.current = root
  useEffect(() => () => io.current?.disconnect(), [])
  return useCallback((el, onNear) => {
    io.current ??= new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const cb = cbs.current.get(e.target)
          cbs.current.delete(e.target)
          io.current?.unobserve(e.target)
          cb?.()
        }
      },
      { root: rootRef.current(), rootMargin: LAZY_MARGIN }
    )
    cbs.current.set(el, onNear)
    io.current.observe(el)
    return () => {
      cbs.current.delete(el)
      io.current?.unobserve(el)
    }
  }, [])
}

/**
 * Whether an item's content should render: immediately when `eager`, otherwise once its placeholder
 * (attach the returned ref) comes near. Stays true afterwards, so expanded state isn't lost.
 */
export function useLazyShown(eager: boolean): [boolean, RefObject<HTMLDivElement | null>] {
  const observe = useContext(LazyCtx)
  const [shown, setShown] = useState(eager || !observe)
  const ph = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (shown) return
    if (eager || !observe) return setShown(true)
    if (ph.current) return observe(ph.current, () => setShown(true))
  }, [shown, eager, observe])
  return [shown, ph]
}
