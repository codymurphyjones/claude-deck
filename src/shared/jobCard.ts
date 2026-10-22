// Job cards: a routine or repo job copied to the clipboard as an image.
//
// The image shows a readable summary card, and the definition itself is stored
// losslessly in the RGB channels of a strip of opaque pixels below it:
//
//   "CDCK" | version (1) | kind (1) | length (4, BE) | crc32 (4, BE) | deflate-raw(JSON)
//
// Three bytes per pixel, row-major from the strip's first pixel. Pixels are fully
// opaque so clipboard round-trips (PNG or DIB) never premultiply them.

import { normalizeJob, type JobDef, type JobSource } from './jobs'

const MAGIC = [0x43, 0x44, 0x43, 0x4b] // "CDCK"
const VERSION = 1
const HEADER = 14
const KIND_BYTE: Record<JobSource, number> = { routine: 1, repo: 2 }

export interface JobCard {
  kind: JobSource
  job: JobDef
}

let crcTable: Uint32Array | undefined
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xffffffff
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

/** The bytes stored in a card's data strip. */
export async function encodeJobCard(card: JobCard): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify({ ...card.job }))
  const body = await pipe(json, new CompressionStream('deflate-raw'))
  const out = new Uint8Array(HEADER + body.length)
  const dv = new DataView(out.buffer)
  out.set(MAGIC, 0)
  out[4] = VERSION
  out[5] = KIND_BYTE[card.kind]
  dv.setUint32(6, body.length)
  dv.setUint32(10, crc32(body))
  out.set(body, HEADER)
  return out
}

/** Rows of `width` pixels needed to hold `byteLength` bytes. */
export function dataRows(byteLength: number, width: number): number {
  return Math.ceil(byteLength / 3 / width)
}

/** Write `bytes` into opaque pixels of an RGBA buffer, starting at row `startRow`. */
export function writeDataStrip(bytes: Uint8Array, rgba: Uint8ClampedArray | Uint8Array, width: number, startRow: number): void {
  const rows = dataRows(bytes.length, width)
  for (let p = 0; p < rows * width; p++) {
    const o = (startRow * width + p) * 4
    rgba[o] = bytes[p * 3] ?? 0
    rgba[o + 1] = bytes[p * 3 + 1] ?? 0
    rgba[o + 2] = bytes[p * 3 + 2] ?? 0
    rgba[o + 3] = 255
  }
}

/** Find and decode a card in an RGBA image; undefined if the image isn't one (or is damaged). */
export async function decodeJobCard(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Promise<JobCard | undefined> {
  const byteAt = (start: number, i: number): number => rgba[start + Math.floor(i / 3) * 4 + (i % 3)]
  for (let y = 0; y < height; y++) {
    const start = y * width * 4
    if (MAGIC.some((m, i) => byteAt(start, i) !== m) || byteAt(start, 4) !== VERSION) continue
    const kind = (Object.keys(KIND_BYTE) as JobSource[]).find((k) => KIND_BYTE[k] === byteAt(start, 5))
    const head = Uint8Array.from({ length: HEADER }, (_, i) => byteAt(start, i))
    const dv = new DataView(head.buffer)
    const len = dv.getUint32(6)
    const avail = Math.floor((rgba.length - start) / 4) * 3 - HEADER
    if (!kind || len > avail) continue
    const body = Uint8Array.from({ length: len }, (_, i) => byteAt(start, HEADER + i))
    if (crc32(body) !== dv.getUint32(10)) continue
    try {
      const raw = JSON.parse(new TextDecoder().decode(await pipe(body, new DecompressionStream('deflate-raw'))))
      const job = normalizeJob(raw, typeof raw?.slug === 'string' ? raw.slug : undefined)
      if (job.steps.length) return { kind, job }
    } catch {
      /* not a card after all */
    }
  }
  return undefined
}

/** Whether two definitions are the same apart from their slug. */
export function sameJob(a: JobDef, b: JobDef): boolean {
  return JSON.stringify({ ...a, slug: '' }) === JSON.stringify({ ...b, slug: '' })
}
