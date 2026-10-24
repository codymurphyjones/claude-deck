import { app, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess, type WebContents } from 'electron'
import * as path from 'path'
import { logDiag } from '../diagnostics'

// Main-process side of the editor's TypeScript support: starts the TypeScript utility process
// (tsWorker.ts) on first use, forwards the renderer's requests to it and returns the answers.
// It remembers the open documents' text, so a restarted worker gets them back before the next
// request. The worker exits after a while with no open documents; if it keeps crashing, TypeScript
// support turns itself off until the app restarts.

type Handler = (e: IpcMainInvokeEvent, ...args: never[]) => unknown

const REQUEST_TIMEOUT = 30_000
const IDLE_EXIT = 5 * 60_000
const MAX_CRASHES = 3

let child: UtilityProcess | undefined
const stopped = new WeakSet<UtilityProcess>()
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
/** Open documents (by canonical path): what the worker has been sent. */
const docs = new Map<string, { file: string; text: string; root?: string; owner: number }>()
const watched = new Set<number>()
let crashes = 0
let idleTimer: ReturnType<typeof setTimeout> | undefined

const key = (f: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? f.replace(/\\/g, '/').toLowerCase() : f)

function start(): UtilityProcess {
  const c = utilityProcess.fork(path.join(__dirname, 'tsWorker.js'), [], { serviceName: 'Claude Deck TypeScript', stdio: 'ignore' })
  c.on('message', (m: { id: number; result?: unknown; error?: string }) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    clearTimeout(p.timer)
    if (m.error !== undefined) p.reject(new Error(m.error))
    else p.resolve(m.result)
  })
  c.on('exit', (code) => {
    if (child === c) child = undefined
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new Error('TypeScript stopped'))
      pending.delete(id)
    }
    if (!stopped.has(c)) {
      crashes++
      logDiag('warn', 'typescript', `TypeScript process exited (code ${code})${crashes >= MAX_CRASHES ? '; TypeScript support is off until restart' : ''}`)
    }
  })
  // A fresh worker: give it the open documents back.
  for (const d of docs.values()) c.postMessage({ id: ++seq, method: 'update', args: [d.file, d.text, d.root] })
  return c
}

function stop(): void {
  if (!child) return
  stopped.add(child)
  child.kill()
  child = undefined
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  if (crashes >= MAX_CRASHES) return Promise.reject(new Error('TypeScript support is off after repeated crashes'))
  child ??= start()
  const c = child
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`TypeScript ${method} timed out`))
    }, REQUEST_TIMEOUT)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    c.postMessage({ id, method, args })
  })
}

function touch(): void {
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (!docs.size && !pending.size) stop()
  }, IDLE_EXIT)
}

function closeDoc(file: string): void {
  if (!docs.delete(key(file))) return
  if (child) void call('close', file).catch(() => undefined)
  touch()
}

/** Forget a window's documents when it goes away (closed or reloaded without closing them). */
function watchOwner(wc: WebContents): void {
  if (watched.has(wc.id)) return
  watched.add(wc.id)
  const id = wc.id
  const drop = (): void => {
    for (const d of [...docs.values()]) if (d.owner === id) closeDoc(d.file)
  }
  wc.once('destroyed', () => {
    watched.delete(id)
    drop()
  })
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) drop()
  })
}

/**
 * IPC handlers for the editor ('ts.*'). Positions are offsets into the text last sent with
 * ts.update; queries for files that aren't open answer null.
 */
export function tsHandlers(): Record<string, Handler> {
  app.once('will-quit', stop)
  const q =
    <T>(method: string) =>
    (_e: IpcMainInvokeEvent, ...args: unknown[]): Promise<T | null> => {
      touch()
      if (!docs.has(key(args[0] as string))) return Promise.resolve(null)
      return call<T>(method, ...args)
    }
  return {
    'ts.status': (_e, root?: string) => call('status', root),
    'ts.update': async (e, file: string, text: string, root?: string) => {
      touch()
      watchOwner(e.sender)
      const k = key(file)
      const prev = docs.get(k)
      docs.set(k, { file, text, root, owner: e.sender.id })
      try {
        const r = await call<{ available: boolean }>('update', file, text, root)
        if (!r?.available) docs.delete(k)
        return r
      } catch (err) {
        if (!prev) docs.delete(k)
        throw err
      }
    },
    'ts.close': (_e, file: string) => closeDoc(file),
    'ts.diagnostics': q('diagnostics'),
    'ts.quickInfo': q('quickInfo'),
    'ts.definition': q('definition'),
    'ts.completions': q('completions'),
    'ts.completionDetails': q('completionDetails')
  }
}
