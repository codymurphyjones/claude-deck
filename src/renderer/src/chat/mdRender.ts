import { Lexer, Marked, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import { highlight, langForFile } from '../highlight'
import { tagFences } from './fenceLang'
import katex from 'katex'
import 'katex/dist/katex.min.css'

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Highlighting lives in ../highlight (full highlight.js, every language); re-exported for chat code.
export { highlight }

/** highlight.js language for a file path ('plaintext' when unknown). */
export const langFromPath = (p: string): string => langForFile(p)

const FILE_REF = /^((?:[A-Za-z]:)?[\w.\-@~/\\]+\.[A-Za-z0-9]{1,8})(?::(\d+)(?:[-:]\d+)?)?$/

const CALLOUTS: Record<string, string> = { NOTE: 'note', TIP: 'tip', IMPORTANT: 'important', WARNING: 'warning', CAUTION: 'caution' }

function mathExtension() {
  return {
    extensions: [
      {
        name: 'blockMath',
        level: 'block' as const,
        start: (src: string) => src.indexOf('$$'),
        tokenizer(src: string) {
          const m = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src)
          if (m) return { type: 'blockMath', raw: m[0], text: m[1].trim() }
          return undefined
        },
        renderer(t: Tokens.Generic) {
          try {
            return `<div class="md-math">${katex.renderToString(t.text, { displayMode: true, throwOnError: false })}</div>`
          } catch {
            return `<pre>${esc(t.text)}</pre>`
          }
        }
      },
      {
        name: 'inlineMath',
        level: 'inline' as const,
        start: (src: string) => src.indexOf('$'),
        tokenizer(src: string) {
          const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src)
          if (m) return { type: 'inlineMath', raw: m[0], text: m[1] }
          return undefined
        },
        renderer(t: Tokens.Generic) {
          try {
            return katex.renderToString(t.text, { throwOnError: false })
          } catch {
            return esc(t.raw)
          }
        }
      }
    ]
  }
}

const md = new Marked({ gfm: true, breaks: false })
md.use(mathExtension())
md.use({
  renderer: {
    code(t: Tokens.Code) {
      const info = (t.lang ?? '').trim()
      const [langRaw, ...rest] = info.split(/\s+/)
      const lang = (langRaw ?? '').toLowerCase()
      const file = rest.join(' ').replace(/^(title|file)=/, '').replace(/^["']|["']$/g, '')
      if (lang === 'mermaid') return `<div class="md-mermaid"><pre class="md-src">${esc(t.text)}</pre></div>`
      if (lang === 'chart') return `<div class="md-chart"><pre class="md-src">${esc(t.text)}</pre></div>`
      const hl = lang === 'diff' ? diffHtml(t.text) : highlight(t.text, lang || (file ? langFromPath(file) : undefined))
      const label = file ? `<span class="code-file" data-path="${esc(file)}">${esc(file)}</span>` : `<span class="code-lang">${esc(lang && lang !== 'plaintext' ? lang : 'text')}</span>`
      return `<div class="code-block"><div class="code-head">${label}<button class="code-copy" data-copy="${esc(t.text)}" title="Copy">Copy</button></div><pre><code class="hljs${lang === 'diff' ? ' diff' : ''}">${hl}</code></pre></div>`
    },
    codespan(t: Tokens.Codespan) {
      const raw = t.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      const m = FILE_REF.exec(raw)
      if (m && /[/\\]|\.\w+:\d+$/.test(raw)) return `<code class="file-ref" data-path="${esc(m[1])}" data-line="${m[2] ?? ''}">${t.text}</code>`
      return `<code>${t.text}</code>`
    },
    link(t: Tokens.Link) {
      const href = t.href ?? ''
      const text = this.parser.parseInline(t.tokens)
      if (/^(https?:|mailto:)/i.test(href)) return `<a href="${esc(href)}" class="ext-link" title="${esc(href)}">${text}</a>`
      const m = /^(.*?)(?:#L(\d+)(?:-L?\d+)?)?$/.exec(href)
      return `<a class="file-ref" data-path="${esc(decodeURI(m?.[1] ?? href))}" data-line="${m?.[2] ?? ''}">${text}</a>`
    },
    blockquote(t: Tokens.Blockquote) {
      const first = t.tokens[0] as Tokens.Paragraph | undefined
      const m = first?.type === 'paragraph' ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.text) : null
      if (m) {
        const kind = CALLOUTS[m[1].toUpperCase()]
        first!.text = first!.text.slice(m[0].length)
        first!.tokens = Lexer.lexInline(first!.text)
        const body = this.parser.parse(t.tokens)
        return `<div class="callout callout-${kind}"><div class="callout-title">${m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()}</div>${body}</div>`
      }
      return `<blockquote>${this.parser.parse(t.tokens)}</blockquote>`
    },
    listitem(item: Tokens.ListItem) {
      let body = this.parser.parse(item.tokens)
      if (item.task) {
        body = body.replace(/^<input[^>]*>\s*/, '')
        return `<li class="task ${item.checked ? 'done' : ''}"><span class="task-box">${item.checked ? '✓' : ''}</span><div>${body}</div></li>`
      }
      return `<li>${body}</li>`
    },
    table(t: Tokens.Table) {
      const head = t.header.map((h, i) => `<th${t.align[i] ? ` style="text-align:${t.align[i]}"` : ''}>${this.parser.parseInline(h.tokens)}</th>`).join('')
      const rows = t.rows.map((r) => `<tr>${r.map((c, i) => `<td${t.align[i] ? ` style="text-align:${t.align[i]}"` : ''}>${this.parser.parseInline(c.tokens)}</td>`).join('')}</tr>`).join('')
      return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
    }
  }
})

export function diffHtml(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+') && !l.startsWith('+++') ? 'd-add' : l.startsWith('-') && !l.startsWith('---') ? 'd-del' : l.startsWith('@@') ? 'd-hunk' : ''
      return `<span class="d-line ${cls}">${esc(l) || ' '}</span>`
    })
    .join('')
}

DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (data.attrName.startsWith('data-')) data.forceKeepAttr = true
})

/** Close an unterminated code fence so streaming output renders as a code block, not as prose. */
function closeOpenFence(text: string): string {
  const fences = text.match(/^\s{0,3}(```|~~~)/gm)
  return fences && fences.length % 2 === 1 ? text + '\n```' : text
}

export function renderMarkdown(text: string, streaming = false): string {
  const src = streaming ? closeOpenFence(text) : text
  // Lex and parse separately so untagged fences can get a language in between.
  const tokens = md.lexer(src, md.defaults)
  tagFences(tokens, (ts, cb) => md.walkTokens(ts, cb))
  const html = md.parser(tokens, md.defaults)
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['details', 'summary', 'kbd', 'semantics', 'annotation', 'math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mtext', 'mspace', 'mover', 'munder', 'msqrt', 'mtable', 'mtr', 'mtd'],
    ADD_ATTR: ['data-path', 'data-line', 'data-copy', 'data-src', 'target', 'aria-hidden', 'encoding'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'form']
  })
}
