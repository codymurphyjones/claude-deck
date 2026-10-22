// Basic symbol outline for the file editor: regex-based, so it works for any language
// without a parser. `lang` is a highlight.js language id (see languages.ts).

export type SymbolKind = 'class' | 'interface' | 'type' | 'enum' | 'function' | 'method' | 'variable' | 'module' | 'heading' | 'selector' | 'target' | 'key'

export interface SymbolInfo {
  name: string
  kind: SymbolKind
  /** 1-based line number. */
  line: number
  /** Nesting level from indentation (headings: level - 1). */
  depth: number
}

type Rule = [RegExp, SymbolKind]

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'try', 'with', 'new', 'await', 'typeof', 'sizeof', 'elif', 'until', 'unless', 'foreach', 'using', 'lock', 'fixed', 'match', 'loop', 'when', 'select', 'case'])

const JS: Rule[] = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
  [/^\s*(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, 'type'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z_$][\w$.]*)/, 'module'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, 'function'],
  [/^\s+(?:(?:public|private|protected|static|readonly|override|abstract|async|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^{=;]+)?\{\s*$/, 'method'],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'variable']
]

const RULES: Record<string, Rule[]> = {
  javascript: JS,
  typescript: JS,
  python: [
    [/^\s*class\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, 'function'],
    [/^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/, 'variable']
  ],
  go: [
    [/^func\s+\([^)]*\)\s*([A-Za-z_]\w*)/, 'method'],
    [/^func\s+([A-Za-z_]\w*)/, 'function'],
    [/^type\s+([A-Za-z_]\w*)\s+interface\b/, 'interface'],
    [/^type\s+([A-Za-z_]\w*)\s+struct\b/, 'class'],
    [/^type\s+([A-Za-z_]\w*)/, 'type']
  ],
  rust: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, 'function'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, 'class'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, 'enum'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+([A-Za-z_]\w*)/, 'interface'],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>, ]+\s+for\s+)?([A-Za-z_][\w:<>]*)/, 'class'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, 'module'],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+([A-Za-z_]\w*)/, 'type'],
    [/^\s*macro_rules!\s*([A-Za-z_]\w*)/, 'function']
  ],
  ruby: [
    [/^\s*class\s+([A-Z][\w:]*)/, 'class'],
    [/^\s*module\s+([A-Z][\w:]*)/, 'module'],
    [/^\s*def\s+((?:self\.)?[\w?!=]+)/, 'method']
  ],
  php: [
    [/^\s*(?:abstract\s+|final\s+)?class\s+(\w+)/, 'class'],
    [/^\s*interface\s+(\w+)/, 'interface'],
    [/^\s*trait\s+(\w+)/, 'interface'],
    [/^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?(\w+)/, 'function']
  ],
  lua: [[/^\s*(?:local\s+)?function\s+([\w.:]+)/, 'function']],
  bash: [
    [/^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\)\s*\{?/, 'function'],
    [/^\s*function\s+([A-Za-z_][\w-]*)/, 'function']
  ],
  powershell: [[/^\s*function\s+([\w-]+)/i, 'function'], [/^\s*class\s+(\w+)/i, 'class']],
  kotlin: [
    [/^\s*(?:[a-z]+\s+)*(?:class|object)\s+(\w+)/, 'class'],
    [/^\s*(?:[a-z]+\s+)*interface\s+(\w+)/, 'interface'],
    [/^\s*(?:[a-z]+\s+)*fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?(\w+)/, 'function']
  ],
  swift: [
    [/^\s*(?:[a-z]+\s+)*(?:class|struct|actor|extension)\s+(\w+)/, 'class'],
    [/^\s*(?:[a-z]+\s+)*protocol\s+(\w+)/, 'interface'],
    [/^\s*(?:[a-z]+\s+)*enum\s+(\w+)/, 'enum'],
    [/^\s*(?:[a-z@]+\s+)*func\s+(\w+)/, 'function']
  ],
  elixir: [
    [/^\s*defmodule\s+([\w.]+)/, 'module'],
    [/^\s*defp?\s+([\w?!]+)/, 'function']
  ],
  haskell: [[/^([a-z_][\w']*)\s*::/, 'function'], [/^(?:data|newtype)\s+(\w+)/, 'type'], [/^class\s+(?:\([^)]*\)\s*=>\s*)?(\w+)/, 'interface']],
  markdown: [],
  css: [],
  scss: [],
  less: [],
  makefile: [[/^([A-Za-z0-9_.\-/$()%]+)\s*:(?!=)/, 'target']],
  yaml: [[/^([A-Za-z_][\w.-]*)\s*:/, 'key']],
  ini: [[/^\s*\[([^\]]+)\]/, 'module']],
  sql: [[/^\s*create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?(table|view|function|procedure|trigger|index|type|schema)\s+(?:if\s+not\s+exists\s+)?([\w."[\]`]+)/i, 'type']],
  dockerfile: [[/^\s*FROM\s+\S+(?:\s+AS\s+(\S+))/i, 'module']]
}

/** C-family languages: types by keyword, functions/methods by "type name(...)" heuristics. */
const C_LIKE = new Set(['c', 'cpp', 'csharp', 'java', 'scala', 'dart', 'objectivec', 'groovy', 'glsl', 'arduino', 'vbnet', 'd', 'zig'])
const C_RULES: Rule[] = [
  [/^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|final|partial|export|data|case|open)\s+)*(?:class|struct|record|object|union)\s+([A-Za-z_]\w*)/, 'class'],
  [/^\s*(?:(?:public|private|protected|internal|static|sealed)\s+)*interface\s+([A-Za-z_]\w*)/, 'interface'],
  [/^\s*(?:(?:public|private|protected|internal)\s+)*enum\s+(?:class\s+)?([A-Za-z_]\w*)/, 'enum'],
  [/^\s*namespace\s+([\w.:]+)/, 'module'],
  [/^\s*(?:[\w:<>,*&[\]?]+\s+)+\**&?([A-Za-z_~][\w:]*)\s*\([^;]*$/, 'function']
]

const SCALAR = /^(?:const|let|var)\b/

/** Indentation width in columns (tabs count as 4). */
function indentOf(s: string): number {
  return /^[\t ]*/.exec(s)![0].replace(/\t/g, '    ').length
}

/** Extract an outline of `text`. Unknown languages get a union of the common rules. */
export function extractSymbols(text: string, lang?: string): SymbolInfo[] {
  const lines = text.split(/\r?\n/)
  const out: SymbolInfo[] = []
  if (lines.length > 50_000) return out

  if (lang === 'markdown') {
    let fence = false
    lines.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence
      const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
      if (m) out.push({ name: m[2], kind: 'heading', line: i + 1, depth: m[1].length - 1 })
    })
    return out
  }
  if (lang === 'css' || lang === 'scss' || lang === 'less') {
    let depth = 0
    lines.forEach((l, i) => {
      const m = /^\s*([^{}@/][^{}]*?|@media[^{]*|@keyframes[^{]*|@mixin[^{]*)\s*\{/.exec(l)
      // Skip "prop: value {" lookalikes, but keep at-rules such as @media (max-width: …).
      if (m && (m[1].startsWith('@') || !/:\s*[^&]/.test(m[1].replace(/::?[\w-]+(\([^)]*\))?/g, '')))) out.push({ name: m[1].trim(), kind: 'selector', line: i + 1, depth })
      depth = Math.max(0, depth + (l.match(/\{/g)?.length ?? 0) - (l.match(/\}/g)?.length ?? 0))
    })
    return out
  }

  const rules: Rule[] = (lang ? RULES[lang] : undefined) ?? (lang && C_LIKE.has(lang) ? C_RULES : [...JS, ...RULES.python, ...RULES.rust, ...C_RULES])
  let inBlockComment = false
  lines.forEach((l, i) => {
    const t = l.trim()
    if (inBlockComment) {
      if (t.includes('*/')) inBlockComment = false
      return
    }
    if (t.startsWith('/*') && !t.includes('*/')) {
      inBlockComment = true
      return
    }
    if (!t || t.startsWith('//') || t.startsWith('*') || (t.startsWith('#') && lang !== 'c' && lang !== 'cpp' && !t.startsWith('#['))) return
    for (const [re, kind] of rules) {
      const m = re.exec(l)
      if (!m) continue
      // sql captures (kind, name); everything else captures the name first.
      const name = lang === 'sql' ? m[2] : m[1]
      if (!name || CONTROL.has(name)) continue
      if (kind === 'variable' && SCALAR.test(t) && indentOf(l) > 0) continue
      out.push({ name, kind, line: i + 1, depth: indentOf(l) })
      break
    }
  })
  // Indentation widths → nesting levels (works for 2-space, 4-space and tab indents).
  const widths = [...new Set(out.map((s) => s.depth))].sort((a, b) => a - b)
  for (const s of out) s.depth = widths.indexOf(s.depth)
  return out
}
