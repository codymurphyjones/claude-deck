// Language detection for syntax highlighting. Returns highlight.js language ids;
// highlight.js also resolves most extensions itself via its aliases (rs, kt, ex, hs…),
// so EXT only lists the ones it doesn't know or gets wrong.

/** Extension → highlight.js language (where the extension isn't already an alias). */
const EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python', pyi: 'python', gd: 'python', bzl: 'python', star: 'python',
  sc: 'scala', fsx: 'fsharp', phtml: 'php', jl: 'julia', hrl: 'erlang', lhs: 'haskell', purs: 'haskell',
  cljs: 'clojure', cljc: 'clojure', mli: 'ocaml', res: 'reasonml', resi: 'reasonml', vhd: 'vhdl',
  h: 'cpp', hh: 'cpp', hpp: 'cpp', hxx: 'cpp', cu: 'cpp', cuh: 'cpp', ino: 'cpp',
  cfg: 'ini', conf: 'ini', env: 'ini', toml: 'ini', editorconfig: 'ini', npmrc: 'ini', properties: 'properties',
  htm: 'xml', xhtml: 'xml', vue: 'xml', svelte: 'xml', astro: 'xml', xaml: 'xml', csproj: 'xml', fsproj: 'xml', vbproj: 'xml', props: 'xml', targets: 'xml', resx: 'xml', plist: 'xml', svg: 'xml', xsd: 'xml', xsl: 'xml', wsdl: 'xml',
  sass: 'scss', mdx: 'markdown', markdown: 'markdown', bib: 'latex', psql: 'pgsql',
  fish: 'bash', sed: 'bash', bashrc: 'bash', zshrc: 'bash', profile: 'bash',
  psm1: 'powershell', psd1: 'powershell', asm: 'x86asm', s: 'x86asm', nasm: 'x86asm', wat: 'wasm', wast: 'wasm',
  ll: 'llvm', f: 'fortran', for: 'fortran', adb: 'ada', ads: 'ada', rkt: 'scheme', ss: 'scheme', el: 'lisp',
  au3: 'autoit', nsi: 'nsis', nsh: 'nsis', bas: 'vbnet', frm: 'vbnet',
  glsl: 'glsl', frag: 'glsl', vert: 'glsl', geom: 'glsl', comp: 'glsl', hlsl: 'glsl', wgsl: 'glsl', shader: 'glsl', fx: 'glsl',
  ipynb: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', har: 'json', geojson: 'json', babelrc: 'json', eslintrc: 'json', prettierrc: 'json',
  yml: 'yaml', gql: 'graphql', proto: 'protobuf', tf: 'ini', tfvars: 'ini', hcl: 'ini', patch: 'diff', rej: 'diff'
}

/** Whole file names (lower-case) that say what they are. */
const NAMES: Record<string, string> = {
  dockerfile: 'dockerfile', containerfile: 'dockerfile',
  makefile: 'makefile', gnumakefile: 'makefile', 'cmakelists.txt': 'cmake',
  gemfile: 'ruby', rakefile: 'ruby', podfile: 'ruby', vagrantfile: 'ruby', brewfile: 'ruby', guardfile: 'ruby', fastfile: 'ruby', appfile: 'ruby',
  jenkinsfile: 'groovy', 'build.gradle': 'gradle', 'settings.gradle': 'gradle',
  build: 'python', workspace: 'python', 'build.bazel': 'python', 'workspace.bazel': 'python', tiltfile: 'python', sconstruct: 'python', sconscript: 'python',
  'nginx.conf': 'nginx', '.htaccess': 'apache', 'httpd.conf': 'apache',
  '.bashrc': 'bash', '.bash_profile': 'bash', '.zshrc': 'bash', '.profile': 'bash', '.envrc': 'bash', pkgbuild: 'bash', apkbuild: 'bash',
  '.gitconfig': 'ini', '.gitmodules': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', '.env': 'ini', 'pipfile': 'ini', 'cargo.lock': 'ini', 'poetry.lock': 'ini',
  'go.mod': 'go', 'go.sum': 'plaintext', 'yarn.lock': 'yaml', 'pnpm-lock.yaml': 'yaml', procfile: 'yaml',
  '.babelrc': 'json', '.eslintrc': 'json', '.prettierrc': 'json', 'tsconfig.json': 'json', '.swcrc': 'json',
  'requirements.txt': 'plaintext', license: 'plaintext', 'license.txt': 'plaintext', '.gitignore': 'plaintext', '.dockerignore': 'plaintext'
}

/** Interpreter in a shebang line → language. */
const INTERPRETERS: [RegExp, string][] = [
  [/\b(ba|z|k|da|fi)?sh\b/, 'bash'],
  [/\bpython[\d.]*\b/, 'python'],
  [/\b(node|deno|bun)\b/, 'javascript'],
  [/\bts-node\b|\btsx\b/, 'typescript'],
  [/\bruby\b/, 'ruby'],
  [/\bperl\b/, 'perl'],
  [/\bphp\b/, 'php'],
  [/\blua\b/, 'lua'],
  [/\b(pwsh|powershell)\b/, 'powershell'],
  [/\bRscript\b/, 'r'],
  [/\bawk\b/, 'awk'],
  [/\btclsh\b/, 'tcl']
]

/** Markdown fence tags people use that aren't highlight.js names or aliases. */
const FENCE_ALIAS: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', terminal: 'bash', fish: 'bash', ps1: 'powershell', pwsh: 'powershell', ps: 'powershell',
  luau: 'lua', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', node: 'javascript', py: 'python', python3: 'python', rs: 'rust', golang: 'go',
  'c++': 'cpp', 'c#': 'csharp', cs: 'csharp', 'f#': 'fsharp', 'objective-c': 'objectivec', objc: 'objectivec',
  yml: 'yaml', toml: 'ini', env: 'ini', dotenv: 'ini', hcl: 'ini', terraform: 'ini', html: 'xml', vue: 'xml', svelte: 'xml', svg: 'xml',
  jsonc: 'json', json5: 'json', md: 'markdown', mdx: 'markdown', gql: 'graphql', proto: 'protobuf', docker: 'dockerfile', make: 'makefile',
  text: 'plaintext', txt: 'plaintext', plain: 'plaintext', output: 'plaintext', log: 'plaintext', sass: 'scss', glsl: 'glsl', hlsl: 'glsl', wgsl: 'glsl', solidity: 'javascript', sol: 'javascript'
}

const baseOf = (p: string): string => p.split(/[\\/]/).pop() ?? p

/** The language for a file path (and optionally its first line, for shebangs), or undefined if unknown. */
export function languageForPath(p: string, firstLine?: string): string | undefined {
  const name = baseOf(p).toLowerCase()
  if (NAMES[name]) return NAMES[name]
  if (/^dockerfile[.-]/.test(name) || name.endsWith('.dockerfile')) return 'dockerfile'
  if (/^makefile[.-]/.test(name) || name.endsWith('.mk')) return 'makefile'
  if (/^\.env(\.|$)/.test(name)) return 'ini'
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1) : ''
  if (ext && EXT[ext]) return EXT[ext]
  if (firstLine?.startsWith('#!')) return languageFromShebang(firstLine)
  return ext || undefined
}

export function languageFromShebang(line: string): string | undefined {
  if (!line.startsWith('#!')) return undefined
  for (const [re, lang] of INTERPRETERS) if (re.test(line)) return lang
  return undefined
}

/** Normalise a markdown fence tag (```ts, ```c++ …) to a highlight.js name. */
export function normalizeLang(tag: string): string {
  const t = tag.trim().toLowerCase()
  return FENCE_ALIAS[t] ?? t
}
