import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { WorktreeRecord } from '@shared/types'

// Chat worktree branches never leave the machine: every push and PR the app makes is checked here.

vi.mock('electron', () => ({}))
const base = path.resolve('/data/worktrees')
const rec = (p: Partial<WorktreeRecord>): WorktreeRecord => ({ id: 'x', path: '', repoRoot: path.resolve('/repo'), baseRef: 'abc', permanent: false, createdAt: 0, lastUsed: 0, ...p })
const worktrees: WorktreeRecord[] = [
  rec({ id: 'chat', path: path.join(base, 'repo-1'), branch: 'claude/main-1', target: 'main' }),
  rec({ id: 'old', path: path.join(base, 'repo-2'), branch: 'claude/main-2', target: 'main', deleted: true }),
  rec({ id: 'held', path: path.join(base, 'repo-release'), branch: 'release', holdsBranch: true, permanent: true }),
  rec({ id: 'job', path: path.join(base, 'repo-job'), branch: 'jobs/lint-1' })
]

describe('pushing', () => {
  it('refuses a chat worktree and a chat branch from anywhere, even a deleted chat’s', async () => {
    const { pushRefusal, setWorktreeSource } = await import('../src/main/git/pushGuard')
    setWorktreeSource(() => worktrees)
    expect(pushRefusal(path.join(base, 'repo-1'), 'claude/main-1')).toMatch(/chat's worktree/)
    expect(pushRefusal(path.join(base, 'repo-1', 'src'), undefined)).toMatch(/chat's worktree/)
    // Checked out in the user's folder, it's still a chat branch.
    expect(pushRefusal(path.resolve('/repo'), 'claude/main-1')).toMatch(/chat's own branch/)
    expect(pushRefusal(path.resolve('/repo'), 'claude/main-2')).toMatch(/chat's own branch/)
  })

  it('allows the user’s branches, branches held in Claude Deck and job branches', async () => {
    const { pushRefusal, setWorktreeSource } = await import('../src/main/git/pushGuard')
    setWorktreeSource(() => worktrees)
    expect(pushRefusal(path.resolve('/repo'), 'main')).toBeUndefined()
    expect(pushRefusal(path.join(base, 'repo-release'), 'release')).toBeUndefined()
    expect(pushRefusal(path.join(base, 'repo-job'), 'jobs/lint-1')).toBeUndefined()
    // A folder whose name merely starts like a chat worktree's isn't inside it.
    expect(pushRefusal(path.join(base, 'repo-10'), 'feature')).toBeUndefined()
  })
})

describe('git run in a chat worktree (any agent or shell)', () => {
  it('cannot push anywhere, by remote name or URL, but can still fetch; outside it, pushing works', async () => {
    const { execFileSync, spawnSync } = await import('child_process')
    const fs = await import('fs')
    const os = await import('os')
    const { pushBlockEnv, setWorktreeSource, BLOCKED_PUSH_URL } = await import('../src/main/git/pushGuard')
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-push-'))
    const g = (cwd: string, ...a: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=T', ...a], { cwd, encoding: 'utf8' }).trim()
    const origin = path.join(tmp, 'origin.git')
    const repo = path.join(tmp, 'repo')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    fs.mkdirSync(repo)
    g(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
    g(repo, 'add', '.')
    g(repo, 'commit', '-qm', 'base')
    g(repo, 'remote', 'add', 'origin', origin)
    g(repo, 'push', '-q', 'origin', 'main')
    const wt = path.join(tmp, 'wt')
    g(repo, 'worktree', 'add', '-q', '-b', 'claude/main-9', wt, 'main')
    setWorktreeSource(() => [rec({ id: 'c', path: wt, repoRoot: repo, branch: 'claude/main-9', target: 'main' })])

    const env = { ...process.env, ...pushBlockEnv(path.join(wt, 'sub'), process.env) }
    const push = (...a: string[]) => spawnSync('git', ['push', ...a], { cwd: wt, env, encoding: 'utf8' })
    for (const args of [['-u', 'origin', 'HEAD'], ['origin', 'claude/main-9'], [origin, 'HEAD:refs/heads/x'], [`file://${origin.split(path.sep).join('/')}`, 'HEAD:refs/heads/y']]) {
      const r = push(...args)
      expect(r.status, `git push ${args.join(' ')}`).not.toBe(0)
      expect(r.stderr).toContain(BLOCKED_PUSH_URL.replace('://', ''))
    }
    // GitHub-style remotes too: the address is rewritten before git ever connects.
    g(wt, 'remote', 'add', 'gh', 'https://github.invalid/acme/app.git')
    g(wt, 'remote', 'add', 'gh-ssh', 'git@github.invalid:acme/app.git')
    for (const remote of ['gh', 'gh-ssh', 'https://github.invalid/acme/other.git']) {
      const r = push(remote, 'HEAD')
      expect(r.status).not.toBe(0)
      expect(r.stderr).toContain(BLOCKED_PUSH_URL.replace('://', ''))
    }
    expect(g(origin, 'branch', '--list')).not.toMatch(/claude|\bx\b|\by\b/)
    expect(spawnSync('git', ['fetch', '-q', 'origin'], { cwd: wt, env }).status).toBe(0)
    // Outside a chat worktree nothing is changed.
    expect(pushBlockEnv(repo, process.env)).toEqual({})
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})
