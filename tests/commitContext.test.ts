import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// What the commit-message drafter is given while concluding a merge: the merge itself (branch,
// incoming commits, conflicted files, how each conflict was resolved), not just a raw staged diff.

vi.mock('electron', () => ({}))

let dir: string
const sh = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd: dir, encoding: 'utf8' })
const write = (f: string, s: string): void => fs.writeFileSync(path.join(dir, f), s)

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-merge-'))
  sh('init', '-q', '-b', 'main')
  write('f.txt', 'a\nshared line\nz\n')
  write('other.txt', 'base\n')
  sh('add', '.')
  sh('commit', '-qm', 'base')
  sh('checkout', '-qb', 'feature')
  write('f.txt', 'a\nfeature version\nz\n')
  write('added.txt', 'new\n')
  sh('add', '.')
  sh('commit', '-qm', 'Add feature version and added.txt')
  sh('checkout', '-q', 'main')
  write('f.txt', 'a\nmain version\nz\n')
  sh('commit', '-qam', 'Change shared line on main')
  try {
    sh('merge', 'feature')
  } catch {
    /* conflicts, as intended */
  }
  write('f.txt', 'a\nmain version + feature version\nz\n')
  sh('add', 'f.txt')
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('commit message context during a merge', () => {
  it('describes the merge instead of only the staged diff', async () => {
    const { rawDiffForMessage } = await import('../src/main/git/gitService')
    const ctx = await rawDiffForMessage(dir)
    expect(ctx).toContain('concludes a merge in progress')
    expect(ctx).toContain("Merge branch 'feature'")
    expect(ctx).toContain('Add feature version and added.txt')
    expect(ctx).toContain('Files that had conflicts, resolved by the user: f.txt')
    // The resolution, against each side.
    expect(ctx).toMatch(/== f\.txt: resolved version vs ours \(HEAD\) ==[\s\S]*\+main version \+ feature version/)
    expect(ctx).toMatch(/== f\.txt: resolved version vs theirs \(MERGE_HEAD\) ==[\s\S]*-feature version/)
    // The incoming file is summarized, not dumped.
    expect(ctx).toContain('added.txt')
    expect(ctx).not.toContain('+new')
  })
})
