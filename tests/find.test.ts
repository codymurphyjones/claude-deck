import { describe, expect, it } from 'vitest'
import { locate, segmentAt } from '../src/renderer/src/find'

describe('locate', () => {
  it('finds every match, ignoring case', () => {
    expect(locate('Foo bar FOO foo', 'foo')).toEqual([
      [0, 3],
      [8, 11],
      [12, 15]
    ])
  })
  it('returns non-overlapping matches, including adjacent ones', () => {
    expect(locate('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4]
    ])
  })
  it('returns nothing for an empty query or no match', () => {
    expect(locate('abc', '')).toEqual([])
    expect(locate('abc', 'x')).toEqual([])
  })
})

describe('segmentAt', () => {
  // Segments "const", " x", " = 1" joined: "const x = 1"
  const starts = [0, 5, 7]
  it('maps offsets to the segment that contains them', () => {
    expect(segmentAt(starts, 0)).toBe(0)
    expect(segmentAt(starts, 4)).toBe(0)
    expect(segmentAt(starts, 5)).toBe(1)
    expect(segmentAt(starts, 6)).toBe(1)
    expect(segmentAt(starts, 10)).toBe(2)
  })
  it('handles a single segment', () => {
    expect(segmentAt([0], 3)).toBe(0)
  })
})
