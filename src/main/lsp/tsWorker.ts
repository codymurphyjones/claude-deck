import { createRequire } from 'module'
import * as path from 'path'
import { TsProjects, type TsModule } from './tsService'

// Entry of the TypeScript utility process (spawned by tsHost.ts). Language services are CPU- and
// memory-hungry, so they live here instead of the main process. Requests are handled one at a time;
// a query superseded by a newer one of the same kind for the same file (typing fast) is answered
// with null without running.
//
// Which TypeScript: the copy shipped with the app (a dependency, unpacked from the asar), else the
// project's own node_modules/typescript. Neither -> every query answers "unavailable".

interface Request {
  id: number
  method: string
  args: unknown[]
}

const req = createRequire(__filename)
const TS_PKG = 'typescript'

function usable(ts: unknown): ts is TsModule {
  const t = ts as TsModule | undefined
  return !!t && typeof t.createLanguageService === 'function' && Number(t.version?.split('.')[0]) >= 4
}

let bundled: TsModule | null | undefined
const workspaceTs = new Map<string, TsModule | null>()

function loadTs(root?: string): TsModule | undefined {
  if (bundled === undefined) {
    try {
      const ts = req(TS_PKG)
      bundled = usable(ts) ? ts : null
    } catch {
      bundled = null
    }
  }
  if (bundled) return bundled
  if (!root) return undefined
  if (!workspaceTs.has(root)) {
    try {
      const ts = createRequire(path.join(root, 'package.json'))(TS_PKG)
      workspaceTs.set(root, usable(ts) ? ts : null)
    } catch {
      workspaceTs.set(root, null)
    }
  }
  return workspaceTs.get(root) ?? undefined
}

const services = new Map<TsModule, TsProjects>()
/** Open file (as sent) -> the service it was opened in. */
const fileService = new Map<string, TsProjects>()
const fileKey = (f: string): string => (process.platform === 'win32' ? f.replace(/\\/g, '/').toLowerCase() : f)

function serviceFor(file: string, root?: string): TsProjects | undefined {
  const known = fileService.get(fileKey(file))
  if (known) return known
  const ts = loadTs(root ?? path.dirname(file))
  if (!ts) return undefined
  let s = services.get(ts)
  if (!s) services.set(ts, (s = new TsProjects(ts)))
  return s
}

function handle(method: string, args: unknown[]): unknown {
  const file = args[0] as string
  switch (method) {
    case 'status': {
      const ts = loadTs(args[0] as string | undefined)
      return ts ? { available: true, version: ts.version, bundled: ts === bundled } : { available: false }
    }
    case 'update': {
      const s = serviceFor(file, args[2] as string | undefined)
      if (!s) return { available: false }
      s.update(file, args[1] as string, args[2] as string | undefined)
      fileService.set(fileKey(file), s)
      return { available: true }
    }
    case 'close': {
      fileService.get(fileKey(file))?.close(file)
      fileService.delete(fileKey(file))
      return null
    }
  }
  const s = fileService.get(fileKey(file))
  if (!s) return null
  switch (method) {
    case 'diagnostics':
      return s.diagnostics(file)
    case 'quickInfo':
      return s.quickInfo(file, args[1] as number)
    case 'definition':
      return s.definition(file, args[1] as number)
    case 'completions':
      return s.completions(file, args[1] as number, args[2] as string | undefined)
    case 'completionDetails':
      return s.completionDetails(file, args[1] as number, args[2] as string, args[3] as string | undefined, args[4])
  }
  throw new Error(`Unknown TypeScript method ${method}`)
}

// Queries that a newer request of the same kind for the same file makes pointless.
const SUPERSEDABLE = new Set(['diagnostics', 'quickInfo', 'completions'])
const queue: Request[] = []
let draining = false

function drain(): void {
  draining = false
  while (queue.length) {
    const r = queue.shift()!
    const superseded = SUPERSEDABLE.has(r.method) && queue.some((q) => q.method === r.method && q.args[0] === r.args[0])
    try {
      process.parentPort.postMessage({ id: r.id, result: superseded ? null : handle(r.method, r.args) })
    } catch (e) {
      process.parentPort.postMessage({ id: r.id, error: e instanceof Error ? e.message : String(e) })
    }
  }
}

process.parentPort.on('message', (e: { data: Request }) => {
  queue.push(e.data)
  // Let messages that arrived together queue up first, so superseded ones can be skipped.
  if (!draining) {
    draining = true
    setImmediate(drain)
  }
})
