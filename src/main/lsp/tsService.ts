import * as fs from 'fs'
import * as path from 'path'
import type * as TS from 'typescript'
import type { TsCompletion, TsCompletionDetails, TsDiagnostic, TsLocation, TsQuickInfo } from '@shared/tsLang'

// TypeScript/JavaScript intelligence for the editor: one LanguageService per project (a tsconfig /
// jsconfig, or an inferred project for folders without one), over the files on disk plus an
// in-memory overlay of the documents open in the editor (so unsaved edits count).
// Pure logic, no Electron: runs in the TypeScript utility process (tsWorker.ts) and in unit tests.
// Positions in open documents are offsets into the overlay text the editor sent (LF line endings).

export type TsModule = typeof TS

/** Files bigger than this are not analysed (diagnostics etc. return nothing). */
export const MAX_FILE_CHARS = 1_500_000
const MAX_COMPLETIONS = 1500

const TS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i
export const isTsFile = (p: string): boolean => TS_FILE.test(p)

const slash = (p: string): string => p.replace(/\\/g, '/')

interface Overlay {
  /** The file name as given (keys are canonical: lower case on Windows). */
  name: string
  text: string
  version: number
}

interface Project {
  key: string
  configPath?: string
  dir: string
  options: TS.CompilerOptions
  /** Canonical name -> file name, from the config. */
  files: Map<string, string>
  refs?: readonly TS.ProjectReference[]
  ls: TS.LanguageService
  parsedAt: number
}

/** Re-read a tsconfig's file list at most this often (new/deleted files). */
const CONFIG_TTL = 10_000
/** Re-stat files on disk at most this often per request burst. */
const STAT_TTL = 1_000

export class TsProjects {
  private readonly overlays = new Map<string, Overlay>()
  private readonly projects = new Map<string, Project>()
  /** Canonical open-file name -> project key. */
  private readonly fileProject = new Map<string, string>()
  private readonly registry: TS.DocumentRegistry
  private readonly diskVersions = new Map<string, { at: number; v: string }>()
  private readonly canon: (p: string) => string

  constructor(private readonly ts: TsModule) {
    this.registry = ts.createDocumentRegistry(ts.sys.useCaseSensitiveFileNames)
    this.canon = ts.sys.useCaseSensitiveFileNames ? (p) => slash(p) : (p) => slash(p).toLowerCase()
  }

  get version(): string {
    return this.ts.version
  }

  // ------------------------------------------------------------------ documents
  /** Open or update an editor document. `root` is the editor's folder (for files with no tsconfig). */
  update(file: string, text: string, root?: string): void {
    file = slash(file)
    const k = this.canon(file)
    const cur = this.overlays.get(k)
    if (cur && cur.text === text) return
    this.overlays.set(k, { name: file, text, version: (cur?.version ?? 0) + 1 })
    if (!this.fileProject.has(k)) this.fileProject.set(k, this.findProject(file, root).key)
  }

  close(file: string): void {
    const k = this.canon(slash(file))
    this.overlays.delete(k)
    this.fileProject.delete(k)
    // Drop projects nothing is open in any more.
    const used = new Set(this.fileProject.values())
    for (const [key, p] of this.projects)
      if (!used.has(key)) {
        p.ls.dispose()
        this.projects.delete(key)
      }
  }

  openFiles(): string[] {
    return [...this.overlays.keys()]
  }

  // ------------------------------------------------------------------ queries
  diagnostics(file: string): TsDiagnostic[] {
    const r = this.service(file)
    if (!r) return []
    const { ls, name, text } = r
    const out: TsDiagnostic[] = []
    const add = (d: TS.Diagnostic, severity?: TsDiagnostic['severity']): void => {
      const from = Math.min(d.start ?? 0, text.length)
      const to = Math.min(from + (d.length ?? 0), text.length)
      const lc = lineCol(text, from)
      out.push({
        from,
        to,
        severity: severity ?? this.severity(d.category),
        message: this.ts.flattenDiagnosticMessageText(d.messageText, '\n'),
        code: d.code,
        line: lc.line,
        col: lc.col
      })
    }
    for (const d of ls.getSyntacticDiagnostics(name)) add(d)
    for (const d of ls.getSemanticDiagnostics(name)) add(d)
    return out.sort((a, b) => a.from - b.from)
  }

  quickInfo(file: string, pos: number): TsQuickInfo | null {
    const r = this.service(file)
    if (!r) return null
    const q = r.ls.getQuickInfoAtPosition(r.name, pos)
    if (!q) return null
    const text = this.ts.displayPartsToString(q.displayParts)
    const doc = [this.ts.displayPartsToString(q.documentation), ...(q.tags ?? []).map((t) => `@${t.name}${t.text ? ' ' + this.ts.displayPartsToString(t.text) : ''}`)].filter(Boolean).join('\n')
    if (!text && !doc) return null
    return { from: q.textSpan.start, to: q.textSpan.start + q.textSpan.length, text, doc }
  }

  definition(file: string, pos: number): TsLocation[] {
    const r = this.service(file)
    if (!r) return []
    const defs = r.ls.getDefinitionAtPosition(r.name, pos) ?? []
    const program = r.ls.getProgram()
    const out: TsLocation[] = []
    for (const d of defs) {
      const f = slash(d.fileName)
      const overlay = this.overlays.get(this.canon(f))
      let lc: { line: number; col: number }
      if (overlay) lc = lineCol(overlay.text, d.textSpan.start)
      else {
        const sf = program?.getSourceFile(d.fileName)
        if (sf) {
          const p = sf.getLineAndCharacterOfPosition(d.textSpan.start)
          lc = { line: p.line + 1, col: p.character + 1 }
        } else lc = { line: 1, col: 1 }
      }
      if (!out.some((o) => o.file === f && o.line === lc.line && o.col === lc.col)) out.push({ file: f, ...lc })
    }
    return out
  }

  /** Completions at `pos`; `prefix` (the word typed so far) trims the list before it's sent. */
  completions(file: string, pos: number, prefix = ''): { items: TsCompletion[]; isMember: boolean } {
    const r = this.service(file)
    if (!r) return { items: [], isMember: false }
    const c = r.ls.getCompletionsAtPosition(r.name, pos, {
      includeCompletionsWithInsertText: true,
      includeCompletionsForModuleExports: false,
      includeAutomaticOptionalChainCompletions: true
    })
    if (!c) return { items: [], isMember: false }
    const q = prefix.toLowerCase()
    const items: TsCompletion[] = []
    for (const e of c.entries) {
      if (q && !subsequence(e.name.toLowerCase(), q)) continue
      items.push({
        name: e.name,
        kind: e.kind,
        sortText: e.sortText,
        insertText: e.insertText,
        from: e.replacementSpan?.start,
        to: e.replacementSpan ? e.replacementSpan.start + e.replacementSpan.length : undefined,
        source: e.source,
        data: e.data
      })
    }
    items.sort((a, b) => (a.sortText < b.sortText ? -1 : a.sortText > b.sortText ? 1 : a.name.localeCompare(b.name)))
    return { items: items.slice(0, MAX_COMPLETIONS), isMember: c.isMemberCompletion }
  }

  completionDetails(file: string, pos: number, name: string, source?: string, data?: unknown): TsCompletionDetails | null {
    const r = this.service(file)
    if (!r) return null
    const d = r.ls.getCompletionEntryDetails(r.name, pos, name, {}, source, {}, data as TS.CompletionEntryData | undefined)
    if (!d) return null
    return {
      text: this.ts.displayPartsToString(d.displayParts),
      doc: [this.ts.displayPartsToString(d.documentation), ...(d.tags ?? []).map((t) => `@${t.name}${t.text ? ' ' + this.ts.displayPartsToString(t.text) : ''}`)].filter(Boolean).join('\n')
    }
  }

  dispose(): void {
    for (const p of this.projects.values()) p.ls.dispose()
    this.projects.clear()
    this.overlays.clear()
    this.fileProject.clear()
  }

  // ------------------------------------------------------------------ internals
  private severity(c: TS.DiagnosticCategory): TsDiagnostic['severity'] {
    const C = this.ts.DiagnosticCategory
    return c === C.Error ? 'error' : c === C.Warning ? 'warning' : c === C.Suggestion ? 'hint' : 'info'
  }

  /** The language service for an open file, or undefined if it isn't open or is too big. */
  private service(file: string): { ls: TS.LanguageService; name: string; text: string } | undefined {
    const name = slash(file)
    const k = this.canon(name)
    const overlay = this.overlays.get(k)
    if (!overlay || overlay.text.length > MAX_FILE_CHARS) return undefined
    const key = this.fileProject.get(k)
    let p = key ? this.projects.get(key) : undefined
    if (!p) {
      p = this.findProject(name)
      this.fileProject.set(k, p.key)
    }
    this.refreshConfig(p)
    return { ls: p.ls, name, text: overlay.text }
  }

  private parseConfig(configPath: string): TS.ParsedCommandLine | undefined {
    const ts = this.ts
    try {
      return ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined }) ?? undefined
    } catch {
      return undefined
    }
  }

  /** The project a file belongs to: its tsconfig (or the referenced config that includes it), else an inferred one. */
  private findProject(file: string, root?: string): Project {
    const ts = this.ts
    const dir = path.posix.dirname(file)
    const k = this.canon(file)
    const configPath = ts.findConfigFile(dir, ts.sys.fileExists, 'tsconfig.json') ?? ts.findConfigFile(dir, ts.sys.fileExists, 'jsconfig.json')
    if (configPath) {
      const parsed = this.parseConfig(configPath)
      if (parsed) {
        if (parsed.fileNames.some((f) => this.canon(f) === k)) return this.project(slash(configPath), parsed)
        // A solution-style config ("files": [] + references): use the referenced project that has the file.
        for (const ref of parsed.projectReferences ?? []) {
          const refPath = ts.resolveProjectReferencePath(ref)
          const rp = this.parseConfig(refPath)
          if (rp?.fileNames.some((f) => this.canon(f) === k)) return this.project(slash(refPath), rp)
        }
        // Not included anywhere: the nearest config's options still beat the defaults.
        if (parsed.fileNames.length) return this.project(slash(configPath), parsed)
      }
    }
    return this.inferred(slash(root ?? dir))
  }

  private project(configPath: string, parsed: TS.ParsedCommandLine): Project {
    const key = this.canon(configPath)
    const existing = this.projects.get(key)
    if (existing) return existing
    const p = this.createProject(key, path.posix.dirname(configPath), parsed.options, parsed.fileNames, parsed.projectReferences, configPath)
    return p
  }

  private inferred(dir: string): Project {
    const key = `inferred:${this.canon(dir)}`
    const existing = this.projects.get(key)
    if (existing) return existing
    const ts = this.ts
    const options: TS.CompilerOptions = {
      allowJs: true,
      checkJs: false,
      allowNonTsExtensions: true,
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strictNullChecks: true,
      noEmit: true
    }
    return this.createProject(key, dir, options, [], undefined)
  }

  private createProject(key: string, dir: string, options: TS.CompilerOptions, fileNames: string[], refs: readonly TS.ProjectReference[] | undefined, configPath?: string): Project {
    const ts = this.ts
    const files = new Map(fileNames.map((f) => [this.canon(f), slash(f)]))
    const p: Project = { key, configPath, dir, options, files, refs, parsedAt: Date.now(), ls: undefined as unknown as TS.LanguageService }
    const overlayFor = (f: string): Overlay | undefined => this.overlays.get(this.canon(f))
    // useSourceOfProjectReferenceRedirect is internal API (what tsserver uses): read referenced
    // projects' sources instead of their built .d.ts output.
    const host = {
      getCompilationSettings: () => p.options,
      getScriptFileNames: () => {
        const names = new Map(p.files)
        for (const [k, proj] of this.fileProject) if (proj === p.key && !names.has(k)) names.set(k, this.originalName(k))
        return [...names.values()]
      },
      getScriptVersion: (f) => {
        const o = overlayFor(f)
        return o ? `o${o.version}` : this.diskVersion(f)
      },
      getScriptSnapshot: (f) => {
        const o = overlayFor(f)
        if (o) return ts.ScriptSnapshot.fromString(o.text)
        const text = ts.sys.readFile(f)
        return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text)
      },
      getCurrentDirectory: () => p.dir,
      getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
      getProjectReferences: () => p.refs,
      useSourceOfProjectReferenceRedirect: () => true,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
      fileExists: (f) => !!overlayFor(f) || ts.sys.fileExists(f),
      readFile: (f, enc) => overlayFor(f)?.text ?? ts.sys.readFile(f, enc),
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath
    } as TS.LanguageServiceHost
    p.ls = ts.createLanguageService(host, this.registry)
    this.projects.set(key, p)
    return p
  }

  /** The name an open file was given (overlay keys are canonical; this keeps the original case). */
  private originalName(k: string): string {
    return this.overlays.get(k)?.name ?? k
  }

  /** Pick up files added to / removed from a configured project. */
  private refreshConfig(p: Project): void {
    if (!p.configPath || Date.now() - p.parsedAt < CONFIG_TTL) return
    p.parsedAt = Date.now()
    const parsed = this.parseConfig(p.configPath)
    if (!parsed) return
    p.options = parsed.options
    p.refs = parsed.projectReferences
    p.files = new Map(parsed.fileNames.map((f) => [this.canon(f), slash(f)]))
  }

  private diskVersion(f: string): string {
    const k = this.canon(f)
    const c = this.diskVersions.get(k)
    const now = Date.now()
    if (c && now - c.at < STAT_TTL) return c.v
    let v = 'missing'
    try {
      const st = fs.statSync(f)
      v = `d${st.mtimeMs}:${st.size}`
    } catch {
      /* deleted or never existed */
    }
    this.diskVersions.set(k, { at: now, v })
    return v
  }
}

/** 1-based line and column of an offset. */
export function lineCol(text: string, pos: number): { line: number; col: number } {
  let line = 1
  let start = 0
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) {
    line++
    start = i + 1
  }
  return { line, col: pos - start + 1 }
}

/** All characters of `q` appear in `s`, in order. */
function subsequence(s: string, q: string): boolean {
  let i = 0
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true
  return i === q.length
}
