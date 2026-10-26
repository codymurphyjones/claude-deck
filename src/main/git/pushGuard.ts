import * as path from 'path'
import type { WorktreeRecord } from '@shared/types'

// A chat's worktree branch (claude/<target>-<id>) never leaves the machine: its work goes into the
// target branch's local folder with "Merge into", and is pushed from there. Every push and PR the
// app makes passes through here, so no button, view or agent tool can publish one.

/** Where the guard reads the app's worktrees from: registered at startup (index.ts), kept out of
 *  this module so the git layer doesn't depend on app state. */
let worktreeSource: () => WorktreeRecord[] = () => []
export function setWorktreeSource(fn: () => WorktreeRecord[]): void {
  worktreeSource = fn
}

const inside = (p: string, dir: string): boolean => {
  const rel = path.relative(path.resolve(dir).toLowerCase(), path.resolve(p).toLowerCase())
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * A chat branch's push remote, set in git itself when the branch is made (before its worktree
 * exists): no such remote exists, so a plain `git push` fails, naming why, from any terminal. It also
 * marks the branch as a chat's for this guard, without waiting on the app's records.
 */
export const NO_PUSH_REMOTE = 'claude-deck-chat-branches-are-never-pushed'

/**
 * Why pushing `branch` from `root` isn't allowed, or undefined if it is. `pushRemote`: the branch's
 * `branch.<name>.pushRemote` from git config, when the caller has read it.
 */
export function pushRefusal(root: string, branch: string | undefined, pushRemote?: string): string | undefined {
  if (pushRemote === NO_PUSH_REMOTE) return `${branch} is a chat's own branch: its work goes into its target branch with "Merge into", and that branch is pushed from its own folder. Chat branches are never pushed.`
  const wts = worktreeSource()
  const chatWt = chatWorktreeAt(root)
  if (chatWt) return `This is a chat's worktree (${chatWt.branch ?? 'detached'}): its work goes into ${chatWt.target} with "Merge into ${chatWt.target}", and ${chatWt.target} is pushed from its own folder. Chat branches are never pushed.`
  const chatBranch = branch ? wts.find((w) => w.target && w.branch === branch) : undefined
  if (chatBranch) return `${branch} is a chat's own branch: merge it into ${chatBranch.target} and push ${chatBranch.target} instead. Chat branches are never pushed.`
  return undefined
}

/** The chat worktree `dir` is in, if any (a branch held in Claude Deck isn't one). */
export function chatWorktreeAt(dir: string): WorktreeRecord | undefined {
  return worktreeSource().find((w) => !w.deleted && w.target && !w.holdsBranch && inside(dir, w.path))
}

/** Where blocked pushes go: no git remote helper exists for it, so git refuses, naming why. */
export const BLOCKED_PUSH_URL = 'claude-deck-chat-branches-are-never-pushed://'

/**
 * Git configuration, as environment variables, for every process the app starts in a chat's
 * worktree (any agent: Claude, Codex…, their terminals, scripts): each push destination is rewritten
 * (url.<x>.pushInsteadOf) to an address git can't push to, so `git push`, `git push <url>` and
 * `gh pr create` fail whichever program runs them. Fetching and pulling are unaffected, and so is
 * git outside these processes (the user's own terminal and tools).
 */
export function pushBlockEnv(cwd: string | undefined, base: Record<string, string | undefined> = process.env): Record<string, string> {
  if (!cwd || !chatWorktreeAt(cwd)) return {}
  const prefixes = ['https://', 'http://', 'ssh://', 'git://', 'file://', 'git@', '/', './', '../', '\\\\']
  for (let c = 65; c <= 90; c++) prefixes.push(`${String.fromCharCode(c)}:`, `${String.fromCharCode(c + 32)}:`)
  // Keep any config the environment already passes this way (GIT_CONFIG_COUNT), adding after it.
  const start = Number(base.GIT_CONFIG_COUNT) || 0
  const env: Record<string, string> = {}
  prefixes.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = `url.${BLOCKED_PUSH_URL}.pushInsteadOf`
    env[`GIT_CONFIG_VALUE_${start + i}`] = p
  })
  env.GIT_CONFIG_COUNT = String(start + prefixes.length)
  env.CLAUDE_DECK_NO_PUSH = '1'
  return env
}

/** Throws if pushing `branch` from `root` would publish a chat's worktree branch. */
export function assertPushable(root: string, branch: string | undefined, pushRemote?: string): void {
  const why = pushRefusal(root, branch, pushRemote)
  if (why) throw new Error(why)
}
