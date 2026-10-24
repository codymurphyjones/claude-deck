import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorktreeRecord } from '@shared/types'

// A chat's own worktree, made for real: its sub-branch off the target, the repo's node_modules
// linked in but invisible to git, and deleting it never touching the repo's real packages.

vi.setConfig({ testTimeout: 60_000 })
vi.mock('electron', () => ({}))
let tmp = ''
// The app state the service reads and writes (updateState reassigns s.worktrees).
const st: { worktrees: WorktreeRecord[] } = { worktrees: [] }
vi.mock('../src/main/context', () => ({
  settings: () => ({ worktrees: { root: path.join(tmp, 'wts'), branchPrefix: 'claude/', linkNodeModules: true } }),
  state: () => st,
  updateState: (fn: (s: { worktrees: WorktreeRecord[] }) => void) => fn(st),
  toast: () => undefined
}))
vi.mock('../src/main/library', () => ({ findProjectForFolder: () => undefined, emitLibrary: () => undefined }))
vi.mock('../src/main/runtime', () => ({ runtime: { userData: os.tmpdir() } }))
vi.mock('../src/main/progress', () => ({ withProgress: (_key: string, _label: string, fn: (p: unknown) => unknown) => fn({ step: () => undefined, done: () => undefined, fail: () => undefined }) }))

let repo: string
const g = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd, encoding: 'utf8' }).trim()

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-wt-'))
  repo = path.join(tmp, 'repo')
  fs.mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\nsecrets/\nCLAUDE.local.md\nbuild/\n')
  // Ignored files a worktree should get: listed in .worktreeinclude, or always (local Claude notes).
  fs.writeFileSync(path.join(repo, '.worktreeinclude'), '.env\nsecrets/\n')
  fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=1\n')
  fs.mkdirSync(path.join(repo, 'secrets'))
  fs.writeFileSync(path.join(repo, 'secrets', 'key.txt'), 'k\n')
  fs.writeFileSync(path.join(repo, 'CLAUDE.local.md'), 'notes\n')
  // …and one it shouldn't.
  fs.mkdirSync(path.join(repo, 'build'))
  fs.writeFileSync(path.join(repo, 'build', 'out.js'), 'x\n')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  g(repo, 'init', '-q', '-b', 'master')
  g(repo, 'config', 'core.autocrlf', 'false')
  g(repo, 'add', '.')
  g(repo, 'commit', '-qm', 'base')
}, 60_000)

afterAll(() => {
  try {
    g(repo, 'worktree', 'prune')
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('a chat worktree', () => {
  it('gets its own sub-branch off the target and shares node_modules without git seeing it', async () => {
    const { createWorktree, deleteWorktree } = await import('../src/main/worktrees/worktreeService')
    const w = await createWorktree({ repoCwd: repo, target: 'master' })
    expect(w.target).toBe('master')
    expect(w.branch).toBe(`claude/master-${w.id}`)
    expect(g(w.path, 'branch', '--show-current')).toBe(w.branch)
    // Packages are available in the worktree…
    const link = path.join(w.path, 'node_modules')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
    // …but the link isn't a change git would commit.
    expect(g(w.path, 'status', '--porcelain')).toBe('')
    // Included ignored files were copied in; other ignored files weren't.
    expect(fs.readFileSync(path.join(w.path, '.env'), 'utf8')).toBe('TOKEN=1\n')
    expect(fs.readFileSync(path.join(w.path, 'secrets', 'key.txt'), 'utf8')).toBe('k\n')
    expect(fs.readFileSync(path.join(w.path, 'CLAUDE.local.md'), 'utf8')).toBe('notes\n')
    expect(fs.existsSync(path.join(w.path, 'build'))).toBe(false)

    // Deleting the worktree never reaches through the link into the repo's packages.
    await deleteWorktree(w.id)
    expect(fs.existsSync(w.path)).toBe(false)
    expect(fs.readFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('module.exports = 1\n')
  })
})

describe('starting from another chat or branch', () => {
  it('copies a chat worktree with its uncommitted changes, without touching it, onto a sub-branch of its branch', async () => {
    const { createWorktree, worktreeFromCheckout } = await import('../src/main/worktrees/worktreeService')
    const chat = await createWorktree({ repoCwd: repo, target: 'master' })
    fs.writeFileSync(path.join(chat.path, 'a.txt'), 'changed\n')
    fs.writeFileSync(path.join(chat.path, 'new.txt'), 'new\n')
    g(chat.path, 'add', 'new.txt')
    const before = g(chat.path, 'status', '--porcelain')

    const copy = await worktreeFromCheckout(chat.path, { onBranch: true })
    // The copy has the chat's changes, still uncommitted, and works toward the chat's branch.
    expect(fs.readFileSync(path.join(copy.path, 'a.txt'), 'utf8')).toBe('changed\n')
    expect(fs.readFileSync(path.join(copy.path, 'new.txt'), 'utf8')).toBe('new\n')
    expect(g(copy.path, 'rev-parse', 'HEAD')).toBe(g(chat.path, 'rev-parse', 'HEAD'))
    expect(copy.target).toBe(chat.branch)
    expect(g(copy.path, 'branch', '--show-current')).toBe(copy.branch)
    // It belongs to the repo, not to the chat's worktree. (Compared with what git reported for the
    // chat: CI's temp dir can be an 8.3 short path, e.g. RUNNER~1, that git spells out in full.)
    expect(copy.repoRoot).toBe(chat.repoRoot)
    expect(copy.repoRoot).not.toBe(chat.path)
    // The chat's own worktree (and its staging) is left exactly as it was.
    expect(g(chat.path, 'status', '--porcelain')).toBe(before)
  })

  it('works toward the local branch for a remote-only one, creating it tracking the remote', async () => {
    const { localBranchFor } = await import('../src/main/worktrees/worktreeService')
    g(repo, 'remote', 'add', 'origin', path.join(tmp, 'origin.git'))
    g(repo, 'update-ref', 'refs/remotes/origin/feature', 'HEAD')
    expect(await localBranchFor(repo, 'origin/feature')).toBe('feature')
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'feature@{upstream}')).toBe('origin/feature')
    expect(await localBranchFor(repo, 'master')).toBe('master')
  })
})

describe('active branches held in the data folder', () => {
  it('checks a branch out in Claude Deck, refuses a second checkout, and releases it keeping the branch', async () => {
    const { checkoutBranch, releaseBranch } = await import('../src/main/worktrees/worktreeService')
    g(repo, 'branch', 'topic')
    const w = await checkoutBranch(repo, 'topic')
    expect(w).toMatchObject({ holdsBranch: true, permanent: true, branch: 'topic' })
    expect(g(w.path, 'branch', '--show-current')).toBe('topic')
    // The folder's own branch, and a branch already held, can't be checked out again.
    await expect(checkoutBranch(repo, 'master')).rejects.toThrow(/already checked out/)
    await expect(checkoutBranch(repo, 'topic')).rejects.toThrow(/already checked out/)
    // Not while chats work toward it, nor with uncommitted changes.
    await expect(releaseBranch(w.id, ['Some chat'])).rejects.toThrow(/Some chat/)
    fs.writeFileSync(path.join(w.path, 'wip.txt'), 'wip\n')
    await expect(releaseBranch(w.id)).rejects.toThrow(/uncommitted/)
    fs.rmSync(path.join(w.path, 'wip.txt'))
    await releaseBranch(w.id)
    expect(fs.existsSync(w.path)).toBe(false)
    expect(g(repo, 'branch', '--list', 'topic')).toContain('topic')
  })

  it('creates a new branch off a ref, checked out in Claude Deck', async () => {
    const { checkoutBranch } = await import('../src/main/worktrees/worktreeService')
    const w = await checkoutBranch(repo, 'fresh', { from: 'master' })
    expect(g(w.path, 'branch', '--show-current')).toBe('fresh')
    expect(g(w.path, 'rev-parse', 'HEAD')).toBe(g(repo, 'rev-parse', 'master'))
    await expect(checkoutBranch(repo, 'fresh', { from: 'master' })).rejects.toThrow(/already exists/)
  })
})
