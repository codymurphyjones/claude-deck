/**
 * Convert a DOM selection inside the chat back into Markdown. Walks the live DOM (not a clone) so it can
 * read computed styles and the original structure, keeping only what the range covers: rendered code
 * blocks become fences, KaTeX becomes $…$, tables/lists/quotes/callouts are rebuilt.
 */

const styles = new WeakMap<Element, CSSStyleDeclaration>()
const css = (el: Element): CSSStyleDeclaration => {
  let s = styles.get(el)
  if (!s) styles.set(el, (s = getComputedStyle(el)))
  return s
}

const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'DETAILS', 'SUMMARY'])
const INLINE_WRAPPERS = new Set(['STRONG', 'B', 'EM', 'I', 'DEL', 'S', 'A', 'CODE', 'KBD'])

const hidden = (el: Element): boolean => css(el).display === 'none'
const isBlock = (el: Element): boolean => {
  if (BLOCK_TAGS.has(el.tagName)) return true
  const d = css(el).display
  return !!d && !d.startsWith('inline') && d !== 'contents' && d !== 'none'
}
const preWhitespace = (el: Element): boolean => css(el).whiteSpace.startsWith('pre') || css(el).whiteSpace === 'break-spaces'

function textOf(node: Text, r: Range): string {
  const start = node === r.startContainer ? r.startOffset : 0
  const end = node === r.endContainer ? r.endOffset : node.data.length
  return node.data.slice(start, end)
}

/** Selected text of a subtree, verbatim. */
function rawText(node: Node, r: Range): string {
  if (node.nodeType === Node.TEXT_NODE) return textOf(node as Text, r)
  let s = ''
  for (const c of node.childNodes) if (r.intersectsNode(c)) s += rawText(c, r)
  return s
}

function fence(body: string, info = ''): string {
  const run = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(Math.max(3, run + 1))
  return `${f}${info}\n${body.replace(/\n$/, '')}\n${f}`
}

function codeSpan(s: string): string {
  if (!s) return ''
  const run = Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length))
  const f = '`'.repeat(run + 1)
  return run ? `${f} ${s} ${f}` : `${f}${s}${f}`
}

const quote = (s: string): string =>
  s
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')

const tex = (el: Element): string => el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? ''

function preText(pre: Element, r: Range): string {
  // Diffs render one span per line with no newline characters between them.
  const lines = [...pre.querySelectorAll('.d-line')]
  if (lines.length)
    return lines
      .filter((l) => r.intersectsNode(l))
      .map((l) => rawText(l, r).replace(/^ $/, ''))
      .join('\n')
  return rawText(pre, r)
}

function inlineKids(el: Node, r: Range): string {
  let s = ''
  for (const c of el.childNodes) if (r.intersectsNode(c)) s += inline(c, r)
  return s
}

function inline(node: Node, r: Range): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = textOf(node as Text, r)
    const p = node.parentElement
    return p && preWhitespace(p) ? t : t.replace(/\s+/g, ' ')
  }
  if (!(node instanceof Element) || hidden(node)) return ''
  const el = node
  if (el.matches('.katex')) {
    const t = tex(el)
    return t ? `$${t}$` : ''
  }
  if (el.matches('button, svg, input, .task-box')) return ''
  const wrap = (m: string): string => {
    const s = inlineKids(el, r)
    const t = s.trim()
    if (!t) return s
    return `${s.match(/^\s*/)![0]}${m}${t}${m}${s.match(/\s*$/)![0]}`
  }
  switch (el.tagName) {
    case 'BR':
      return '\n'
    case 'STRONG':
    case 'B':
      return wrap('**')
    case 'EM':
    case 'I':
      return wrap('*')
    case 'DEL':
    case 'S':
      return wrap('~~')
    case 'CODE':
      return codeSpan(rawText(el, r))
    case 'KBD':
      return `<kbd>${rawText(el, r)}</kbd>`
    case 'A': {
      const text = inlineKids(el, r).trim()
      if (el.classList.contains('ext-link')) {
        const href = el.getAttribute('href') ?? ''
        return !href || text === href ? text || href : `[${text}](${href})`
      }
      const path = el.getAttribute('data-path')
      if (path) {
        const line = el.getAttribute('data-line')
        return `[${text}](${encodeURI(path)}${line ? `#L${line}` : ''})`
      }
      return text
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? ''
      return src && !src.startsWith('data:') ? `![${el.getAttribute('alt') ?? ''}](${src})` : ''
    }
    default:
      return inlineKids(el, r)
  }
}

/** Children as Markdown blocks: consecutive inline content becomes one paragraph. */
function blocks(parent: Node, r: Range, skip?: (el: Element) => boolean): string {
  const out: string[] = []
  let run = ''
  const flush = (): void => {
    const t = run.replace(/[ \t]+\n/g, '\n').trim()
    if (t) out.push(t)
    run = ''
  }
  for (const c of parent.childNodes) {
    if (!r.intersectsNode(c)) continue
    if (c instanceof Element && (hidden(c) || skip?.(c))) continue
    if (c instanceof Element && isBlock(c)) {
      flush()
      const b = block(c, r)
      if (b.trim()) out.push(b)
    } else run += inline(c, r)
  }
  flush()
  return out.join('\n\n')
}

function list(el: Element, r: Range): string {
  const ordered = el.tagName === 'OL'
  let n = Number(el.getAttribute('start') ?? 1) || 1
  const items: string[] = []
  for (const li of el.children) {
    if (li.tagName !== 'LI') continue
    const idx = n++
    if (!r.intersectsNode(li)) continue
    const marker = ordered ? `${idx}. ` : '- '
    const task = li.classList.contains('task') ? (li.classList.contains('done') ? '[x] ' : '[ ] ') : ''
    // Keep nested lists tight under their item text.
    const body = blocks(li, r).replace(/\n\n(?=(?:[-*]|\d+\.) )/g, '\n')
    if (!body) continue
    const pad = ' '.repeat(marker.length)
    items.push(marker + task + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n'))
  }
  return items.join('\n')
}

function table(el: Element, r: Range): string {
  const trs = [...el.querySelectorAll('tr')].filter((tr) => r.intersectsNode(tr))
  const rows = trs.map((tr) =>
    [...tr.children]
      .filter((c) => r.intersectsNode(c))
      .map((c) =>
        blocks(c, r)
          .replace(/\n+/g, ' ')
          .replace(/\|/g, '\\|')
          .trim()
      )
  )
  if (!rows.length) return ''
  if (rows.length === 1 && rows[0].length === 1) return rows[0][0]
  const width = Math.max(...rows.map((c) => c.length))
  const line = (cells: string[]): string => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
  const align = [...trs[0].children]
    .filter((c) => r.intersectsNode(c))
    .map((c) => {
      const a = (c as HTMLElement).style.textAlign
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---'
    })
  while (align.length < width) align.push('---')
  return [line(rows[0]), `| ${align.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

function block(el: Element, r: Range): string {
  if (el.matches('.code-block')) {
    const pre = el.querySelector('pre')
    if (!pre || !r.intersectsNode(pre)) return ''
    const file = el.querySelector('.code-file')?.textContent ?? ''
    const lang = el.querySelector('.code-lang')?.textContent ?? ''
    const info = file ? `${file.split('.').pop()?.toLowerCase() ?? ''} ${file}` : lang && lang !== 'text' ? lang : ''
    return fence(preText(pre, r), info)
  }
  if (el.matches('.md-mermaid, .md-chart')) {
    const src = el.getAttribute('data-src') ?? el.querySelector('.md-src')?.textContent ?? ''
    return src ? fence(src, el.matches('.md-mermaid') ? 'mermaid' : 'chart') : ''
  }
  if (el.matches('.md-math')) {
    const t = tex(el)
    return t ? `$$\n${t}\n$$` : ''
  }
  if (el.matches('.callout')) {
    const title = (el.querySelector('.callout-title')?.textContent ?? 'Note').trim().toUpperCase()
    const body = blocks(el, r, (c) => c.matches('.callout-title'))
    return quote(`[!${title}]\n${body}`)
  }
  switch (el.tagName) {
    case 'H1':
    case 'H2':
    case 'H3':
    case 'H4':
    case 'H5':
    case 'H6': {
      const t = blocks(el, r).replace(/\s*\n+\s*/g, ' ')
      return t && `${'#'.repeat(Number(el.tagName[1]))} ${t}`
    }
    case 'PRE':
      return fence(preText(el, r))
    case 'BLOCKQUOTE': {
      const t = blocks(el, r)
      return t && quote(t)
    }
    case 'UL':
    case 'OL':
      return list(el, r)
    case 'TABLE':
      return table(el, r)
    case 'HR':
      return '---'
    default:
      return blocks(el, r)
  }
}

function rangeToMarkdown(r: Range): string {
  const start = r.commonAncestorContainer
  const anchor = start instanceof Element ? start : start.parentElement
  if (!anchor) return ''
  // Atomic renders (code, math, diagrams) must convert as a whole; partial tables need their rows' table.
  let root = anchor.closest('.code-block, .md-math, .md-mermaid, .md-chart, .katex') ?? anchor.closest('table') ?? anchor
  // Climb through inline formatting so a selection inside **bold** keeps its markers. The range
  // filter keeps the climb from pulling in unselected text.
  while (root.parentElement && INLINE_WRAPPERS.has(root.parentElement.tagName) && !root.parentElement.closest('pre')) root = root.parentElement
  const md = isBlock(root) ? block(root, r) : inline(root, r)
  return md.replace(/\n{3,}/g, '\n\n').trim()
}

export function selectionToMarkdown(sel: Selection): string {
  const parts: string[] = []
  for (let i = 0; i < sel.rangeCount; i++) {
    const md = rangeToMarkdown(sel.getRangeAt(i))
    if (md) parts.push(md)
  }
  return parts.join('\n\n')
}
