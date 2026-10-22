import hljs from 'highlight.js'
import type { Token, Tokens } from 'marked'
import { languageFromShebang } from '@shared/languages'
import { langForFile, resolveLang } from '../highlight'

// Claude often opens a code fence without a language tag. Guessing against every
// highlight.js language gets short snippets badly wrong (Lua comes out as Fortran or
// Ada), so before rendering we fill in a tag from context, strongest signal first:
//   1. a file named in the text just before the fence ("Update `init.lua`:")
//   2. a shebang on the first line
//   3. a language named in the text just before the fence ("Here's the Lua version:")
//   4. the one language the message's other fences are tagged with
//   5. a guess limited to common languages, kept only when it's clearly ahead
// Anything else is shown as plain text rather than coloured wrongly.

/** A file in backticks or a link target (bare words like "Node.js" don't count). */
const FILE_IN_TEXT = /`([^`\s]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+(?:[-:]\d+)?)?`|\]\(([^)\s#]+)/g

/** Language names that are safe to spot in prose (no "Go", "C", "R"…). */
const NAMED: [RegExp, string][] = [
  [/\blua(u)?\b/i, 'lua'],
  [/\bpython\b/i, 'python'],
  [/\btypescript\b/i, 'typescript'],
  [/\bjavascript\b/i, 'javascript'],
  [/\brust\b/i, 'rust'],
  [/\bgolang\b/i, 'go'],
  [/\bc\+\+/i, 'cpp'],
  [/\bc#/i, 'csharp'],
  [/\bjava\b(?!script)/i, 'java'],
  [/\bkotlin\b/i, 'kotlin'],
  [/\bruby\b/i, 'ruby'],
  [/\bphp\b/i, 'php'],
  [/\bpowershell\b/i, 'powershell'],
  [/\bbash\b/i, 'bash'],
  [/\bsql\b/i, 'sql'],
  [/\byaml\b/i, 'yaml'],
  [/\bjson\b/i, 'json'],
  [/\bhaskell\b/i, 'haskell'],
  [/\belixir\b/i, 'elixir']
]

/** What auto-detection may pick from. */
const AUTO_SUBSET = [
  'typescript', 'javascript', 'python', 'rust', 'go', 'c', 'cpp', 'csharp', 'java', 'kotlin', 'swift', 'ruby', 'php', 'lua',
  'bash', 'powershell', 'sql', 'json', 'yaml', 'xml', 'css', 'scss', 'markdown', 'dockerfile', 'makefile', 'ini', 'r', 'perl',
  'scala', 'haskell', 'elixir', 'dart', 'objectivec'
]
const AUTO_MIN_RELEVANCE = 5
const AUTO_MIN_LEAD = 2

const known = (l: string | undefined): string | undefined => {
  const r = resolveLang(l)
  return r && r !== 'plaintext' ? r : undefined
}

function fromContext(before: string): string | undefined {
  const files = [...before.matchAll(FILE_IN_TEXT)].map((m) => m[1] ?? m[2])
  for (let i = files.length - 1; i >= 0; i--) {
    const l = langForFile(files[i])
    if (l !== 'plaintext') return l
  }
  // Only the last sentence: an earlier mention is usually about something else.
  const tail = before.split(/[.!?]\s|\n/).filter((s) => s.trim()).pop() ?? ''
  for (const [re, lang] of NAMED) if (re.test(tail)) return lang
  return undefined
}

function guess(code: string): string | undefined {
  const r = hljs.highlightAuto(code, AUTO_SUBSET)
  const lead = r.relevance - (r.secondBest?.relevance ?? 0)
  return r.language && r.relevance >= AUTO_MIN_RELEVANCE && lead >= AUTO_MIN_LEAD ? r.language : undefined
}

/**
 * Pick a language for an untagged fence. `before` is the prose just above it and
 * `messageLang` the single language the message's tagged fences use, if any.
 */
export function inferFenceLang(code: string, before = '', messageLang?: string): string {
  const first = code.slice(0, 200).split('\n', 1)[0]
  return fromContext(before) ?? known(languageFromShebang(first)) ?? messageLang ?? guess(code) ?? 'plaintext'
}

const fenceTag = (t: Tokens.Code): string => (t.lang ?? '').trim().split(/\s+/)[0] ?? ''

/** Fill in `lang` on untagged code fences, in place. `walk` is the Marked instance's walkTokens. */
export function tagFences(tokens: Token[], walk: (tokens: Token[], cb: (t: Token) => void) => void): void {
  const codes: Tokens.Code[] = []
  walk(tokens, (t) => {
    if (t.type === 'code' && (t as Tokens.Code).codeBlockStyle !== 'indented') codes.push(t as Tokens.Code)
  })
  const tagged = new Set(codes.map((c) => known(fenceTag(c))).filter((l): l is string => !!l && l !== 'diff'))
  const messageLang = tagged.size === 1 ? [...tagged][0] : undefined

  let before = ''
  walk(tokens, (t) => {
    if (t.type === 'paragraph' || t.type === 'heading' || (t.type === 'text' && 'tokens' in t)) before = t.raw
    else if (t.type === 'code') {
      const c = t as Tokens.Code
      if (c.codeBlockStyle !== 'indented' && !fenceTag(c)) c.lang = inferFenceLang(c.text, before, messageLang)
      before = ''
    }
  })
}
