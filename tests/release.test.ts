import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without type declarations
import { bump, classifyCommit, decideBump } from '../scripts/release-bump.mjs'

describe('release bump', () => {
  it('classifies commit messages', () => {
    const level = (m: string): string => classifyCommit(m).level
    expect(level('feat!: drop Node 18')).toBe('major')
    expect(level('refactor(api)!: rename endpoints')).toBe('major')
    expect(level('fix: crash\n\nBREAKING CHANGE: config moved')).toBe('major')
    expect(level('CJ | rework settings [major]')).toBe('major')
    expect(level('feat(jobs): repo jobs')).toBe('minor')
    expect(level('CJ | adding release script')).toBe('minor')
    expect(level('Add support for GitHub triggers')).toBe('minor')
    expect(level('CJ | tidy things #minor')).toBe('minor')
    expect(level('fix: off by one')).toBe('patch')
    expect(level('chore: add lint config')).toBe('patch')
    expect(level('CJ | fixing release version issue')).toBe('patch')
    expect(level('CJ | improving automation systems')).toBe('patch')
    expect(level('CJ | adding a breaking new parser [patch]')).toBe('patch')
    // Wording alone never makes a major release.
    expect(level('breaking: everything')).toBe('patch')
  })

  it('takes the highest bump and explains it', () => {
    const r = decideBump(['fix: a', 'feat: b', 'CJ | adding c', 'Release v0.2.1', 'docs: d'])
    expect(r.level).toBe('minor')
    expect(r.decisive.map((d: { subject: string }) => d.subject)).toEqual(['feat: b', 'CJ | adding c'])
    expect(decideBump(['Release v1.0.0']).level).toBe('patch')
    expect(decideBump(['fix: a', 'feat!: b']).level).toBe('major')
  })

  it('bumps versions', () => {
    expect(bump([0, 2, 1], 'patch')).toEqual([0, 2, 2])
    expect(bump([0, 2, 1], 'minor')).toEqual([0, 3, 0])
    expect(bump([0, 2, 1], 'major')).toEqual([1, 0, 0])
  })
})
