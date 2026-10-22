import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../src/shared/diff'
import { decodeSegment, detectFormat, ProgressiveCutter, type CutterOptions, type DataFormat } from '../src/shared/progressive'

/** Feed `text` in `size`-char chunks, flushing with take() after each one; return the segments. */
function cutAll(text: string, size: number, opts: CutterOptions = {}): { segs: string[]; format: DataFormat | undefined } {
  const c = new ProgressiveCutter({ firstBatch: 1, ...opts })
  const segs: string[] = []
  for (let i = 0; i < text.length; i += size) {
    const a = c.push(text.slice(i, i + size))
    if (a !== undefined) segs.push(a)
    const b = c.take()
    if (b !== undefined) segs.push(b)
  }
  const e = c.end()
  if (e !== undefined) segs.push(e)
  return { segs, format: c.format }
}

const decodeAll = (text: string, size: number): unknown[] => {
  const { segs, format } = cutAll(text, size)
  return segs.flatMap((s) => decodeSegment(s, format!))
}

describe('detectFormat', () => {
  it('recognizes the record patterns', () => {
    expect(detectFormat('diff --git a/x b/x\n')).toBe('unified-diff')
    expect(detectFormat('  [{"a":1},')).toBe('json-array')
    expect(detectFormat('{"a":1}\n{"a":2}\n')).toBe('ndjson')
    expect(detectFormat('{\n  "a": 1\n}\n')).toBe('whole')
    expect(detectFormat('a,b,c\n1,2,3\n4,5,6\n')).toBe('csv')
    expect(detectFormat('hello\nworld\n')).toBe('lines')
  })

  it('waits for a full first line unless the data is complete', () => {
    expect(detectFormat('{"a":')).toBeUndefined()
    expect(detectFormat('{"a":1}', true)).toBe('ndjson')
  })
})

describe('ProgressiveCutter', () => {
  const ndjson = Array.from({ length: 50 }, (_, i) => JSON.stringify({ i, s: 'x'.repeat(i % 7) })).join('\n') + '\n'
  const array = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ i, nested: [i, { s: `a,]}"\\${i}` }] })))

  it('never splits an ndjson record, whatever the chunk size', () => {
    for (const size of [1, 3, 17, 4096]) expect(decodeAll(ndjson, size)).toEqual(ndjson.trim().split('\n').map((l) => JSON.parse(l)))
  })

  it('cuts a JSON array between elements, ignoring commas and brackets inside strings and nesting', () => {
    for (const size of [1, 5, 64, 100_000]) expect(decodeAll(array, size)).toEqual(JSON.parse(array))
  })

  it('keeps newlines inside quoted CSV fields in the same row', () => {
    const csv = 'id,note\n1,"two\nlines"\n2,plain\n3,"x,y"\n'
    const { segs, format } = cutAll(csv, 2)
    expect(format).toBe('csv')
    expect(segs.flatMap((s) => decodeSegment(s, 'csv'))).toEqual(['id,note', '1,"two\nlines"', '2,plain', '3,"x,y"'])
    // Every segment ends at a row boundary: no segment leaves a quote open.
    for (const s of segs) expect((s.match(/"/g) ?? []).length % 2).toBe(0)
  })

  it('cuts a diff only at file boundaries', () => {
    const diff = ['a', 'b', 'c']
      .map((n) => `diff --git a/${n}.ts b/${n}.ts\nindex 1..2 100644\n--- a/${n}.ts\n+++ b/${n}.ts\n@@ -1,2 +1,2 @@\n-old ${n}\n+new ${n}\n context\n`)
      .join('')
    for (const size of [1, 7, 50]) {
      const { segs } = cutAll(diff, size)
      const files = segs.flatMap((s) => parseUnifiedDiff(s))
      expect(files).toEqual(parseUnifiedDiff(diff))
      for (const s of segs) expect(s.startsWith('diff --git ')).toBe(true)
    }
  })

  it('emits small data as one batch', () => {
    const c = new ProgressiveCutter()
    expect(c.push(ndjson.slice(0, 200))).toBeUndefined()
    expect(c.end()).toBe(ndjson.slice(0, 200))
    expect(c.batches).toBe(1)
  })

  it('grows the batch size as the load goes on', () => {
    const c = new ProgressiveCutter({ firstBatch: 100, maxBatch: 400 })
    const sizes: number[] = []
    for (const line of ndjson.repeat(20).split(/(?<=\n)/)) {
      const s = c.push(line)
      if (s) sizes.push(s.length)
    }
    expect(sizes.length).toBeGreaterThan(3)
    expect(sizes[0]).toBeLessThan(sizes[sizes.length - 1])
    expect(Math.max(...sizes)).toBeLessThan(400 + 100)
  })

  it('delivers a pattern-less payload whole', () => {
    const obj = JSON.stringify({ a: [1, 2, 3], b: 'x' }, null, 2)
    const { segs, format } = cutAll(obj, 4)
    expect(format).toBe('whole')
    expect(segs).toHaveLength(1)
    expect(decodeSegment(segs[0], 'whole')).toEqual([JSON.parse(obj)])
  })
})
