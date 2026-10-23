// In-page find for DOM views (chat, diffs, previews). Matches are painted with the CSS Custom
// Highlight API, so the DOM React renders is never touched.

/** Every case-insensitive, non-overlapping occurrence of `query` in `text`, as [start, end) offsets. */
export function locate(text: string, query: string): [number, number][] {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const out: [number, number][] = []
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length])
  return out
}

/** Index of the segment containing `pos`, given ascending segment start offsets (the first is 0). */
export function segmentAt(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

const SKIP = '.search-bar, [data-find-skip], script, style, textarea'

/** Text nodes under `root` joined into one string, so a match can span highlight <span>s. */
function collectText(root: Element): { nodes: Text[]; starts: number[]; text: string } {
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeValue && !n.parentElement?.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT)
  })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text)
    starts.push(text.length)
    text += n.nodeValue
  }
  return { nodes, starts, text }
}

export function findRanges(root: Element, query: string): Range[] {
  const { nodes, starts, text } = collectText(root)
  if (!nodes.length) return []
  return locate(text, query).map(([a, b]) => {
    const r = document.createRange()
    const i = segmentAt(starts, a)
    const j = segmentAt(starts, b - 1)
    r.setStart(nodes[i], a - starts[i])
    r.setEnd(nodes[j], b - starts[j])
    return r
  })
}

export function paintMatches(ranges: Range[], current: number): void {
  CSS.highlights.set('deck-find', new Highlight(...ranges))
  if (ranges[current]) CSS.highlights.set('deck-find-current', new Highlight(ranges[current]))
  else CSS.highlights.delete('deck-find-current')
}

export function clearMatches(): void {
  CSS.highlights.delete('deck-find')
  CSS.highlights.delete('deck-find-current')
}

export function revealRange(r: Range): void {
  r.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

// ---- scopes: which view a Ctrl+F belongs to ----

const scopes = new WeakMap<Element, () => void>()

/** Mark `el` as searchable; `open` shows its find UI. Returns the cleanup. */
export function registerFindScope(el: HTMLElement, open: () => void): () => void {
  el.dataset.findScope = ''
  scopes.set(el, open)
  return () => {
    scopes.delete(el)
    delete el.dataset.findScope
  }
}

// Clicking text doesn't move focus, so remember where the pointer last went down too.
let lastPointer: Element | null = null
if (typeof window !== 'undefined') window.addEventListener('pointerdown', (e) => (lastPointer = e.target as Element), true)

const scopeOf = (el: Element | null): Element | null | undefined => el?.closest?.('[data-find-scope]')

/** Open the find UI of the scope at `el`, or (without `el`) the one the user is working in. */
export function openFind(el?: Element | null): boolean {
  const scope = el ? scopeOf(el) ?? el.querySelector('[data-find-scope]') : scopeOf(document.activeElement) ?? (lastPointer?.isConnected ? scopeOf(lastPointer) : null)
  const open = scope && scopes.get(scope)
  if (!open) return false
  open()
  return true
}
