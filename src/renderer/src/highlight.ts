import hljs from 'highlight.js/lib/common'
import { languageForPath, normalizeLang } from '@shared/languages'
import { bumpRenderVersion } from './lazyRender'

// Syntax highlighting for everything the app renders as code: markdown code blocks,
// tool cards, diffs. Token colours are the .hljs-* rules in chat/chat.css.
// Startup ships highlight.js's common set (~40 languages); the full set (190+, ~1.2 MB) loads
// on demand: when an unknown language is asked for, and in idle time shortly after launch.
// Code rendered before it lands is plain text until a re-render (see lazyRender.ts).

let allLoaded = false
let allLoading: Promise<void> | undefined

/** Register every highlight.js language (same hljs instance: both bundles share lib/core). */
export function loadAllLanguages(): Promise<void> {
  allLoading ??= import('highlight.js').then(
    () => {
      allLoaded = true
      bumpRenderVersion()
    },
    () => {
      allLoading = undefined
    }
  )
  return allLoading
}

if (typeof window !== 'undefined')
  setTimeout(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 0))
    idle(() => void loadAllLanguages())
  }, 3000)

/** Larger inputs are shown unhighlighted to keep rendering fast. */
const MAX_CHARS = 300_000
const AUTO_MAX_CHARS = 20_000

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A highlight.js language name for a tag/alias, or undefined if it has none. */
export function resolveLang(lang?: string): string | undefined {
  if (!lang) return undefined
  const l = normalizeLang(lang)
  if (l === 'plaintext') return l
  if (hljs.getLanguage(l)) return l
  if (!allLoaded) void loadAllLanguages()
  return undefined
}

/** Language for a file: by name/extension, then shebang; 'plaintext' if unknown (no guessing). */
export function langForFile(path: string, content?: string): string {
  const first = content?.slice(0, 200).split('\n', 1)[0]
  return resolveLang(languageForPath(path, first)) ?? 'plaintext'
}

/**
 * Highlight `code` as HTML. With no `lang`, the language is guessed (short snippets only);
 * an unknown `lang` renders as plain escaped text.
 */
export function highlight(code: string, lang?: string): string {
  if (code.length > MAX_CHARS) return esc(code)
  try {
    const l = resolveLang(lang)
    if (l === 'plaintext') return esc(code)
    if (l) return hljs.highlight(code, { language: l, ignoreIllegals: true }).value
    if (!lang && code.length < AUTO_MAX_CHARS) return hljs.highlightAuto(code).value
  } catch {
    /* fall through */
  }
  return esc(code)
}

/** Split highlighted HTML into lines, closing and reopening spans that cross line breaks. */
export function splitHtmlLines(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let cur = ''
  let last = 0
  const re = /<span[^>]*>|<\/span>|\n/g
  for (let m = re.exec(html); m; m = re.exec(html)) {
    cur += html.slice(last, m.index)
    last = m.index + m[0].length
    if (m[0] === '\n') {
      out.push(cur + '</span>'.repeat(open.length))
      cur = open.join('')
    } else if (m[0] === '</span>') {
      open.pop()
      cur += m[0]
    } else {
      open.push(m[0])
      cur += m[0]
    }
  }
  out.push(cur + html.slice(last) + '</span>'.repeat(open.length))
  return out
}

/** Highlight a whole text and return one HTML string per line (multi-line strings/comments stay correct). */
export function highlightLines(code: string, lang?: string): string[] {
  return splitHtmlLines(highlight(code, lang))
}

/**
 * Highlight unified-diff lines (each prefixed with ' ', '+', '-' or '\'). The old and new
 * sides are highlighted as continuous text so constructs spanning lines colour correctly.
 * Returns the HTML of each line's content, without its prefix.
 */
export function highlightDiffLines(lines: string[], lang?: string): string[] {
  if (!lang || lang === 'plaintext') return lines.map((l) => esc(l.slice(1)))
  const oldSrc: string[] = []
  const newSrc: string[] = []
  // For each input line: which side it comes from and its index there.
  const where: [side: 'old' | 'new' | 'none', idx: number][] = []
  for (const l of lines) {
    const c = l[0]
    const body = l.slice(1)
    if (c === '+') where.push(['new', newSrc.push(body) - 1])
    else if (c === '-') where.push(['old', oldSrc.push(body) - 1])
    else if (c === '\\') where.push(['none', -1])
    else {
      oldSrc.push(body)
      where.push(['new', newSrc.push(body) - 1])
    }
  }
  const oldHtml = oldSrc.length ? highlightLines(oldSrc.join('\n'), lang) : []
  const newHtml = newSrc.length ? highlightLines(newSrc.join('\n'), lang) : []
  return where.map(([side, i], k) => (side === 'old' ? oldHtml[i] : side === 'new' ? newHtml[i] : esc(lines[k].slice(1))) ?? '')
}
