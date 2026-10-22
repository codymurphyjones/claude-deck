// Progressive loading: cut incoming text at the last complete record so what has arrived
// can be rendered now, and carry the unfinished tail into the next iteration. Small data
// arrives in one piece and comes out as a single batch; large data comes out in batches
// that grow as the load goes on (quick first paint, then fewer, bigger updates).

export type DataFormat =
  /** One JSON value per line. */
  | 'ndjson'
  /** A top-level JSON array; records are its elements. */
  | 'json-array'
  /** `git diff` output; records are whole files. */
  | 'unified-diff'
  /** Comma-separated rows; newlines inside quoted fields don't end a row. */
  | 'csv'
  /** Plain lines. */
  | 'lines'
  /** No usable record pattern (e.g. a single JSON object): delivered when complete. */
  | 'whole'

/** Summary returned when a progressive load finishes (the records went out as batches). */
export interface LoadResult {
  format: DataFormat
  records: number
  chars: number
  batches: number
}

/** Below this much text with no newline, detection waits for more data. */
const DETECT_SAMPLE = 4096

/** Guess the record pattern from the start of the data. Undefined: not enough data yet. */
export function detectFormat(sample: string, final = false): DataFormat | undefined {
  const s = sample.replace(/^﻿/, '').trimStart()
  if (!s) return final ? 'lines' : undefined
  if (s.startsWith('diff --git ')) return 'unified-diff'
  if (s.startsWith('[')) return 'json-array'
  const nl = s.indexOf('\n')
  if (nl < 0 && !final && s.length < DETECT_SAMPLE) return undefined
  const first = (nl < 0 ? s : s.slice(0, nl)).trim()
  if (first.startsWith('{')) {
    try {
      JSON.parse(first)
      return 'ndjson'
    } catch {
      return 'whole'
    }
  }
  // CSV vs plain lines needs a few complete rows to compare.
  const rows = decodeSegment(s, 'csv') as string[]
  const complete = (final || s.endsWith('\n') ? rows : rows.slice(0, -1)).filter((r) => r.trim()).slice(0, 6)
  if (complete.length && csvFields(complete[0]) === 1) return 'lines'
  if (complete.length < 3 && !final && s.length < DETECT_SAMPLE) return undefined
  const n = csvFields(complete[0] ?? '')
  return n > 1 && complete.every((r) => csvFields(r) === n) ? 'csv' : 'lines'
}

/** Field count of a CSV row (commas inside quotes don't count). */
function csvFields(row: string): number {
  let n = 1
  let quoted = false
  for (const ch of row) {
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) n++
  }
  return n
}

/**
 * Incremental boundary finder for one format. It scans each character once and tracks:
 * `start` where record content begins, `boundary` where the last complete record ends,
 * and `resume` where the next record's content begins.
 */
class Scanner {
  start = 0
  boundary = 0
  resume = 0
  private pos = 0
  private lineStart = 0
  private depth = 0
  private inString = false
  private escape = false
  private opened = false
  closed = false

  constructor(readonly format: DataFormat) {}

  scan(buf: string): void {
    const f = this.format
    for (let i = this.pos; i < buf.length; i++) {
      const ch = buf[i]
      if (f === 'json-array') {
        if (this.closed) continue
        if (this.inString) {
          if (this.escape) this.escape = false
          else if (ch === '\\') this.escape = true
          else if (ch === '"') this.inString = false
          continue
        }
        if (ch === '"') this.inString = true
        else if (ch === '[' || ch === '{') {
          if (!this.opened && ch === '[') {
            this.opened = true
            this.start = this.boundary = this.resume = i + 1
          } else this.depth++
        } else if (ch === ']' || ch === '}') {
          if (this.depth === 0 && ch === ']') {
            this.closed = true
            this.boundary = i
            this.resume = i + 1
          } else this.depth--
        } else if (ch === ',' && this.depth === 0) {
          this.boundary = i
          this.resume = i + 1
        }
      } else if (f === 'csv') {
        if (ch === '"') this.inString = !this.inString
        else if (ch === '\n' && !this.inString) this.boundary = this.resume = i + 1
      } else if (f === 'unified-diff') {
        if (ch === '\n') this.lineStart = i + 1
        else if (i === this.lineStart && i > 0 && buf.startsWith('diff --git ', i)) this.boundary = this.resume = i
      } else if (f !== 'whole' && ch === '\n') this.boundary = this.resume = i + 1
    }
    this.pos = buf.length
  }

  /** The buffer lost its first `n` characters. */
  shift(n: number): void {
    this.pos -= n
    this.lineStart -= n
    this.start = Math.max(0, this.start - n)
    this.boundary = this.resume = 0
  }
}

export interface CutterOptions {
  /** Skip detection when the format is known. */
  format?: DataFormat
  /** Size of the first batch; small so something shows fast. */
  firstBatch?: number
  /** Batches double in size up to this. */
  maxBatch?: number
}

/**
 * Accumulates text and hands out complete segments.
 * - `push` returns a segment once enough complete records have built up.
 * - `take` returns whatever complete records are buffered (for time-based flushing).
 * - `end` returns everything left.
 * Segments are record content only (for json-array: elements without the brackets).
 */
export class ProgressiveCutter {
  format: DataFormat | undefined
  /** Characters received / emitted so far. */
  received = 0
  emitted = 0
  /** Segments emitted. */
  batches = 0
  private buf = ''
  private scanner: Scanner | undefined
  private target: number
  private readonly maxBatch: number

  constructor(opts: CutterOptions = {}) {
    this.format = opts.format
    this.target = opts.firstBatch ?? 16 * 1024
    this.maxBatch = opts.maxBatch ?? 1024 * 1024
    if (this.format) this.scanner = new Scanner(this.format)
  }

  push(chunk: string): string | undefined {
    this.buf += chunk
    this.received += chunk.length
    if (!this.ready()) return undefined
    return this.complete() >= this.target ? this.cut() : undefined
  }

  take(): string | undefined {
    if (!this.ready()) return undefined
    return this.complete() > 0 ? this.cut() : undefined
  }

  end(): string | undefined {
    if (!this.format) this.format = detectFormat(this.buf, true) ?? 'lines'
    if (!this.scanner) this.scanner = new Scanner(this.format)
    this.scanner.scan(this.buf)
    let seg = this.buf.slice(this.scanner.start)
    if (this.format === 'json-array') seg = this.scanner.closed ? this.buf.slice(this.scanner.start, this.scanner.boundary) : seg
    this.buf = ''
    if (!seg.trim()) return undefined
    this.emitted += seg.length
    this.batches++
    return seg
  }

  private ready(): boolean {
    if (!this.format) {
      this.format = detectFormat(this.buf)
      if (!this.format) return false
    }
    if (!this.scanner) this.scanner = new Scanner(this.format)
    this.scanner.scan(this.buf)
    return true
  }

  private complete(): number {
    const s = this.scanner!
    return s.boundary - s.start
  }

  private cut(): string | undefined {
    const s = this.scanner!
    const seg = this.buf.slice(s.start, s.boundary)
    const n = s.resume
    this.buf = this.buf.slice(n)
    s.shift(n)
    this.target = Math.min(this.maxBatch, this.target * 2)
    if (!seg.trim()) return undefined
    this.emitted += seg.length
    this.batches++
    return seg
  }
}

/** Turn a segment into records for the formats that have a standard shape. */
export function decodeSegment(seg: string, format: DataFormat): unknown[] {
  switch (format) {
    case 'ndjson':
      return seg
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    case 'json-array':
      return seg.trim() ? JSON.parse(`[${seg}]`) : []
    case 'whole':
      return [JSON.parse(seg)]
    case 'csv': {
      // Rows as raw text; a newline inside a quoted field stays in its row.
      const rows: string[] = []
      let start = 0
      let quoted = false
      for (let i = 0; i < seg.length; i++) {
        if (seg[i] === '"') quoted = !quoted
        else if (seg[i] === '\n' && !quoted) {
          rows.push(seg.slice(start, i).replace(/\r$/, ''))
          start = i + 1
        }
      }
      if (start < seg.length) rows.push(seg.slice(start))
      return rows
    }
    default:
      return seg.split('\n').filter((l, i, a) => l || i < a.length - 1)
  }
}
