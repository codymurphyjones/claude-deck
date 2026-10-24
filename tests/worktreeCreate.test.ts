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
