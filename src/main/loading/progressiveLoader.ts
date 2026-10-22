import { spawn } from 'child_process'
import * as fs from 'fs'
import { net } from 'electron'
import { ProgressiveCutter, type CutterOptions, type DataFormat, type LoadResult } from '@shared/progressive'

export type { LoadResult }

/** Text arriving in pieces: a process, a file, a response body, or a payload sliced up. */
export type TextSource = AsyncIterable<string>

/** Stream a process's stdout. Throws with stderr on a non-zero exit; killed on abort. */
export async function* fromProcess(file: string, args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): TextSource {
  const child = spawn(file, args, { cwd: opts.cwd, windowsHide: true, shell: /\.(cmd|bat)$/i.test(file) })
  child.stdin.end()
  child.stdout.setEncoding('utf8')
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
  const exit = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (e) => {
      stderr ||= e.message
      resolve(1)
    })
  })
  const kill = (): void => void child.kill()
  opts.signal?.addEventListener('abort', kill)
  try {
    for await (const chunk of child.stdout) yield chunk as string
    if ((await exit) !== 0 && !opts.signal?.aborted) throw new Error(stderr.trim() || `${file} failed`)
  } finally {
    opts.signal?.removeEventListener('abort', kill)
    kill()
  }
}

export async function* fromFile(file: string): TextSource {
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 64 * 1024 })) yield chunk as string
}

/** An HTTP response body as it downloads. */
export async function* fromHttp(url: string, init?: RequestInit): TextSource {
  const res = await net.fetch(url, init)
  if (!res.ok) throw new Error(`${url} returned ${res.status}`)
  if (!res.body) return yield await res.text()
  const decoder = new TextDecoder()
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    yield decoder.decode(value, { stream: true })
  }
  const rest = decoder.decode()
  if (rest) yield rest
}

/**
 * A payload that is already complete (a plain HTTP response, a big string). Sliced so
 * the first part is decoded and shown while the rest waits its turn.
 */
export async function* fromText(text: string, slice = 64 * 1024): TextSource {
  for (let i = 0; i < text.length; i += slice) {
    yield text.slice(i, i + slice)
    await new Promise((r) => setImmediate(r))
  }
}

export interface LoadOptions extends CutterOptions {
  signal?: AbortSignal
  /** Flush complete records at least this often while data keeps coming (ms). */
  flushMs?: number
}

/**
 * Feed a source through a ProgressiveCutter and emit decoded records as they become
 * complete. If everything arrives within `flushMs`, it is emitted as one batch.
 */
export async function loadProgressive<T>(source: TextSource, decode: (segment: string, format: DataFormat) => T[], emit: (records: T[]) => void, opts: LoadOptions = {}): Promise<LoadResult> {
  const cutter = new ProgressiveCutter(opts)
  const flushMs = opts.flushMs ?? 40
  let last = Date.now()
  let records = 0
  const out = (seg: string | undefined): void => {
    if (seg === undefined) return
    const items = decode(seg, cutter.format!)
    last = Date.now()
    if (!items.length) return
    records += items.length
    emit(items)
  }
  for await (const chunk of source) {
    if (opts.signal?.aborted) break
    out(cutter.push(chunk))
    if (Date.now() - last >= flushMs) out(cutter.take())
  }
  if (!opts.signal?.aborted) out(cutter.end())
  return { format: cutter.format ?? 'lines', records, chars: cutter.received, batches: cutter.batches }
}

/** Groups records produced one at a time into time-based batches. */
export class Batcher<T> {
  private items: T[] = []
  private last = Date.now()

  constructor(
    private emit: (records: T[]) => void,
    private flushMs = 40
  ) {}

  add(...items: T[]): void {
    this.items.push(...items)
    if (Date.now() - this.last >= this.flushMs) this.flush()
  }

  flush(): void {
    this.last = Date.now()
    if (!this.items.length) return
    const batch = this.items
    this.items = []
    this.emit(batch)
  }
}
