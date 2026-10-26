import * as path from 'path'
import type { BranchVsRemote, ChatBranchStatus, ChatMergeResult, WorktreeRecord } from '@shared/types'
import { broadcast } from '../context'
import { rawGit as git } from '../git/gitService'
import { getWorktree, touchWorktree } from './worktreeService'
import { checkPushable } from '../git/gitService'

// Branches worked on in parallel. Each chat works in its own worktree (in Claude Deck's data folder)
// on a sub-branch off a target branch, and "Merge into <target>" brings its work back:
//  1. the chat's branch first takes in the target's newer commits, in the chat's worktree, so any
//     conflicts are resolved there (by the user or the chat), never in the user's folder;
//  2. then the target moves forward to it, in the folder that has it checked out: the user's own (their
//     "selected" branch) or the branch's copy held in Claude Deck's data folder (an active branch). It's
//     fast-forwarded right away, unless it has uncommitted changes: then the update is held until they
//     say so. A target that isn't checked out anywhere isn't merged into ('inactive'): it's made
//     active first. Nothing is pushed here; that's done from the target's folder.
// Nothing here overwrites a branch that has diverged; that is reported for the user to resolve.

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
const count = async (cwd: string, range: string): Promise<number> => +(await git(cwd, ['rev-list', '--count', range])).stdout.trim() || 0

/** Where each local branch is checked out (from `git worktree list --porcelain`). */
async function checkouts(repo: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  let at = ''
  for (const l of (await git(repo, ['worktree', 'list', '--porcelain'])).stdout.split('\n')) {
    if (l.startsWith('worktree ')) at = path.normalize(l.slice(9).trim())
    else if (l.startsWith('branch refs/heads/')) out.set(l.slice(18).trim(), at)
  }
  return out
}

/** File paths from `git status --porcelain` (each line is "XY path"; the leading space is significant, so no trimming). */
const statusFiles = (out: string): string[] =>
  out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.replace(/\r$/, '').slice(3))

/** Tracked files with changes (staged or not) in a checkout; untracked files don't block a fast-forward. */
const trackedChanges = async (cwd: string): Promise<string[]> => statusFiles((await git(cwd, ['status', '--porcelain', '--untracked-files=no'])).stdout)

const conflictsIn = async (cwd: string): Promise<string[]> => lines((await git(cwd, ['diff', '--name-only', '--diff-filter=U'])).stdout)

function needChat(id: string): WorktreeRecord & { branch: string; target: string } {
  const w = getWorktree(id)
  if (!w || w.deleted) throw new Error('That worktree is gone.')
  if (!w.branch || !w.target) throw new Error("This worktree isn't working toward a branch, so there's nothing to merge it into.")
  return w as WorktreeRecord & { branch: string; target: string }
}

export async function chatBranchStatus(id: string): Promise<ChatBranchStatus> {
  const w = needChat(id)
  const [ahead, behind, dirty, conflicts, where] = await Promise.all([
    count(w.path, `${w.target}..${w.branch}`),
    count(w.path, `${w.branch}..${w.target}`),
    git(w.path, ['status', '--porcelain']).then((r) => lines(r.stdout).length),
    conflictsIn(w.path),
    checkouts(w.repoRoot)
  ])
  return { branch: w.branch, target: w.target, ahead, behind, dirty, conflicts, targetCheckout: where.get(w.target) }
}

/**
 * Merge a chat's worktree branch into its target (see the top of this file). `stashLocal`: the
 * target's checkout has uncommitted changes and the user chose to update anyway (they're stashed
 * and re-applied).
 */
export async function mergeIntoTarget(id: string, opts: { stashLocal?: boolean } = {}): Promise<ChatMergeResult> {
  let w: ReturnType<typeof needChat>
  try {
    w = needChat(id)
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
  const { branch, target, path: wt, repoRoot: repo } = w
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${target}`])).code !== 0) return { status: 'error', message: `The branch ${target} no longer exists.` }

  // 1. The chat's work must be committed, and any earlier merge finished.
  const pending = await conflictsIn(wt)
  if (pending.length) return { status: 'conflicts', target, files: pending }
  const dirty = statusFiles((await git(wt, ['status', '--porcelain'])).stdout)
  if (dirty.length) return { status: 'uncommitted', files: dirty }
  const ahead = await count(wt, `${target}..${branch}`)
  if (!ahead) return { status: 'nothing', target }
  // Work is only merged into a local checkout of the target: the user's folder, or the branch held in
  // Claude Deck's data folder. Pushing is done from there, never straight from a chat's worktree.
  if (!(await checkouts(repo)).get(target)) return { status: 'inactive', target }

  // 2. Take in the target's newer commits here, so conflicts surface in the chat's worktree.
  if (await count(wt, `${branch}..${target}`)) {
    const m = await git(wt, ['merge', '--no-edit', '-m', `Merge ${target} into ${branch}`, target])
    if (m.code !== 0) {
      const files = await conflictsIn(wt)
      if (files.length) return { status: 'conflicts', target, files }
      await git(wt, ['merge', '--abort'])
      return { status: 'error', message: m.stderr.trim() || `Couldn't bring ${target} into ${branch}.` }
    }
  }
  const tip = (await git(wt, ['rev-parse', branch])).stdout.trim()

  // 3. Move the target forward in the folder that has it checked out.
  const where = (await checkouts(repo)).get(target)
  if (!where) return { status: 'inactive', target }
  let stashConflict = false
  const local = await trackedChanges(where)
  if (local.length && !opts.stashLocal) return { status: 'held', target, checkout: where, files: local }
  let stashed = false
  if (local.length) {
    const st = await git(where, ['stash', 'push', '-m', `claude-deck: local changes before merging ${branch}`])
    stashed = st.code === 0 && !/No local changes/i.test(st.stdout)
  }
  const ff = await git(where, ['merge', '--ff-only', tip])
  if (ff.code !== 0) {
    if (stashed) await git(where, ['stash', 'pop'])
    return { status: 'error', message: ff.stderr.trim() || `Couldn't fast-forward ${target}.` }
  }
  if (stashed && (await git(where, ['stash', 'pop'])).code !== 0) stashConflict = true
  touchWorktree(id)
  broadcast('branches:changed', { repo, branch: target })
  return { status: 'merged', target, commits: ahead, updated: where, stashConflict }
}

/** Push one local branch (not necessarily the checked-out one) to its remote. */
export async function pushBranch(repo: string, branch: string): Promise<void> {
  await checkPushable(repo, branch)
  const remote = (await git(repo, ['config', `branch.${branch}.remote`])).stdout.trim() || ((await git(repo, ['remote'])).stdout.split('\n')[0] ?? '').trim()
  if (!remote) throw new Error('This repository has no remote to push to.')
  const p = await git(repo, ['push', remote, `refs/heads/${branch}:refs/heads/${branch}`], undefined, 120_000)
  if (p.code !== 0) throw new Error(p.stderr.trim() || `Couldn't push ${branch}.`)
}

/**
 * A local branch against its remote copy, after a fetch: how far apart they are. Used before the
 * user's folder switches to a branch whose work may have happened in Claude Deck's worktrees.
 */
export async function branchVsRemote(repo: string, branch: string): Promise<BranchVsRemote> {
  const remote = (await git(repo, ['config', `branch.${branch}.remote`])).stdout.trim() || ((await git(repo, ['remote'])).stdout.split('\n')[0] ?? '').trim()
  if (!remote) return { ahead: 0, behind: 0 }
  const fetched = await git(repo, ['fetch', '--quiet', remote, branch], undefined, 30_000)
  const remoteRef = `refs/remotes/${remote}/${branch}`
  if ((await git(repo, ['rev-parse', '--verify', '--quiet', remoteRef])).code !== 0) return { remote, ahead: 0, behind: 0, missing: true, offline: fetched.code !== 0 && !/couldn't find remote ref/i.test(fetched.stderr) }
  const lr = (await git(repo, ['rev-list', '--left-right', '--count', `refs/heads/${branch}...${remoteRef}`])).stdout.trim().split(/\s+/)
  return { remote, ahead: +lr[0] || 0, behind: +lr[1] || 0, offline: fetched.code !== 0 }
}
