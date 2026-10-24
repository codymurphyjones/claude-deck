import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeRecord } from '@shared/types'

// Merging a chat's worktree branch into its target, against real git repos: the user's folder (with
// the selected branch checked out), chat worktrees on sub-branches, and a bare "origin".

vi.setConfig({ testTimeout: 60_000 })
vi.mock('electron', () => ({}))
const records = new Map<string, WorktreeRecord>()
vi.mock('../src/main/worktrees/worktreeService', () => ({ getWorktree: (id: string) => records.get(id), touchWorktree: () => undefined }))
vi.mock('../src/main/context', () => ({ broadcast: () => undefined }))

let tmp: string
let repo: string
let origin: string
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd, encoding: 'utf8' }).trim()
const write = (dir: string, f: string, s: string): void => fs.writeFileSync(path.join(dir, f), s)
const read = (dir: string, f: string): string => fs.readFileSync(path.join(dir, f), 'utf8')

/** A chat worktree on its own sub-branch off `target`, as createWorktree makes it. */
function chat(id: string, target: string): string {
  const dir = path.join(tmp, `wt-${id}`)
  const branch = `claude/${target}-${id}`
  g(repo, 'worktree', 'add', '-q', '-b', branch, dir, target)
  records.set(id, { id, path: dir, repoRoot: repo, baseRef: g(dir, 'rev-parse', 'HEAD'), branch, target, permanent: false, createdAt: 0, lastUsed: 0 })
  return dir
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-branches-'))
  origin = path.join(tmp, 'origin.git')
  repo = path.join(tmp, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin])
  fs.mkdirSync(repo)
  g(repo, 'init', '-q', '-b', 'master')
  // The code under test commits merges itself, so the repo needs an identity of its own (CI machines
  // have no global one), and no line-ending conversion, so file contents are the same everywhere.
  g(repo, 'config', 'user.email', 't@t')
  g(repo, 'config', 'user.name', 'Tester')
  g(repo, 'config', 'core.autocrlf', 'false')
  write(repo, 'f.txt', 'one\ntwo\nthree\n')
  g(repo, 'add', '.')
  g(repo, 'commit', '-qm', 'base')
  g(repo, 'remote', 'add', 'origin', origin)
  g(repo, 'push', '-q', '-u', 'origin', 'master')
  g(repo, 'branch', 'release')
  g(repo, 'push', '-q', '-u', 'origin', 'release')
  records.clear()
  // Building real repos takes a few seconds per test when git is slow to start (antivirus etc.).
}, 60_000)

afterEach(() => {
  try {
    g(repo, 'worktree', 'prune')
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const sync = () => import('../src/main/worktrees/branchSync')

describe('merging a chat into its target', () => {
  it('fast-forwards the selected branch in the user’s folder right away, without pushing', async () => {
    const wt = chat('a', 'master')
    write(wt, 'new.txt', 'from chat\n')
    g(wt, 'add', '.')
    g(wt, 'commit', '-qm', 'chat work')
    const { mergeIntoTarget, chatBranchStatus } = await sync()
    expect(await chatBranchStatus('a')).toMatchObject({ ahead: 1, behind: 0, dirty: 0 })
    const r = await mergeIntoTarget('a')
    expect(r).toMatchObject({ status: 'merged', target: 'master', commits: 1, pushed: undefined })
    expect(read(repo, 'new.txt')).toBe('from chat\n')
    expect(g(repo, 'status', '--porcelain')).toBe('')
    expect(g(repo, 'rev-parse', 'origin/master')).not.toBe(g(repo, 'rev-parse', 'master'))
  })

  it('takes in commits the target got meanwhile before moving it', async () => {
    const wt = chat('a', 'master')
    write(wt, 'new.txt', 'from chat\n')
    g(wt, 'add', '.')
    g(wt, 'commit', '-qm', 'chat work')
    write(repo, 'other.txt', 'user work\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'user work')
    const { mergeIntoTarget } = await sync()
    expect(await mergeIntoTarget('a')).toMatchObject({ status: 'merged' })
    expect(read(repo, 'new.txt')).toBe('from chat\n')
    expect(read(repo, 'other.txt')).toBe('user work\n')
  })

  it('stops on conflicts inside the chat’s worktree, then merges once they are resolved', async () => {
    const wt = chat('a', 'master')
    write(wt, 'f.txt', 'one\nCHAT\nthree\n')
    g(wt, 'commit', '-qam', 'chat edits line 2')
    write(repo, 'f.txt', 'one\nUSER\nthree\n')
    g(repo, 'commit', '-qam', 'user edits line 2')
    const { mergeIntoTarget } = await sync()
    expect(await mergeIntoTarget('a')).toEqual({ status: 'conflicts', target: 'master', files: ['f.txt'] })
    // The user's folder is untouched.
    expect(read(repo, 'f.txt')).toBe('one\nUSER\nthree\n')
    expect(g(repo, 'status', '--porcelain')).toBe('')
    // Resolved in the worktree (by the user or the chat), then merge again.
    write(wt, 'f.txt', 'one\nUSER+CHAT\nthree\n')
    g(wt, 'add', 'f.txt')
    g(wt, 'commit', '-qm', 'Merge master, keep both')
    expect(await mergeIntoTarget('a')).toMatchObject({ status: 'merged' })
    expect(read(repo, 'f.txt')).toBe('one\nUSER+CHAT\nthree\n')
  })

  it('holds the update while the user’s folder has uncommitted changes, and keeps them when told to go ahead', async () => {
    const wt = chat('a', 'master')
    write(wt, 'new.txt', 'from chat\n')
    g(wt, 'add', '.')
    g(wt, 'commit', '-qm', 'chat work')
    write(repo, 'f.txt', 'one\ntwo\nthree\nmy local edit\n')
    const { mergeIntoTarget } = await sync()
    const held = await mergeIntoTarget('a')
    expect(held).toMatchObject({ status: 'held', target: 'master', files: ['f.txt'] })
    expect(fs.existsSync(path.join(repo, 'new.txt'))).toBe(false)
    expect(await mergeIntoTarget('a', { stashLocal: true })).toMatchObject({ status: 'merged', stashConflict: false })
    expect(read(repo, 'new.txt')).toBe('from chat\n')
    expect(read(repo, 'f.txt')).toBe('one\ntwo\nthree\nmy local edit\n')
  })

  it('updates and pushes a branch the user isn’t on, entirely outside their folder', async () => {
    const wt = chat('r', 'release')
    write(wt, 'fix.txt', 'release fix\n')
    g(wt, 'add', '.')
    g(wt, 'commit', '-qm', 'release fix')
    const { mergeIntoTarget } = await sync()
    expect(await mergeIntoTarget('r')).toMatchObject({ status: 'merged', target: 'release', pushed: true, updated: undefined })
    expect(g(repo, 'rev-parse', 'release')).toBe(g(origin, 'rev-parse', 'release'))
    // The user's folder (on master) never changed.
    expect(fs.existsSync(path.join(repo, 'fix.txt'))).toBe(false)
    expect(g(repo, 'branch', '--show-current')).toBe('master')
  })

  it('refuses uncommitted chat work and reports nothing to merge', async () => {
    const wt = chat('a', 'master')
    const { mergeIntoTarget } = await sync()
    expect(await mergeIntoTarget('a')).toEqual({ status: 'nothing', target: 'master' })
    write(wt, 'wip.txt', 'not committed\n')
    expect(await mergeIntoTarget('a')).toEqual({ status: 'uncommitted', files: ['wip.txt'] })
  })
})

describe('a branch against origin, before switching to it', () => {
  it('counts commits on each side', async () => {
    const { branchVsRemote } = await sync()
    expect(await branchVsRemote(repo, 'release')).toMatchObject({ remote: 'origin', ahead: 0, behind: 0 })
    // Local work not pushed yet.
    g(repo, 'switch', '-q', 'release')
    write(repo, 'a.txt', 'a\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'local only')
    g(repo, 'switch', '-q', 'master')
    expect(await branchVsRemote(repo, 'release')).toMatchObject({ ahead: 1, behind: 0 })
    // Someone else pushed to origin meanwhile: diverged.
    const other = path.join(tmp, 'other')
    execFileSync('git', ['clone', '-q', '-b', 'release', origin, other])
    write(other, 'b.txt', 'b\n')
    g(other, 'add', '.')
    g(other, 'commit', '-qm', 'remote only')
    g(other, 'push', '-q')
    expect(await branchVsRemote(repo, 'release')).toMatchObject({ ahead: 1, behind: 1 })
  })
})
