import * as fs from 'fs'
import * as path from 'path'
import { parseUnifiedDiff } from '@shared/diff'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseConflicts,
  parseLog,
  parseRemotes,
  parseStashes,
  parseTags,
  STASH_FORMAT,
  summarizeChecks,
  TAG_FORMAT,
  type BranchInfo,
  type CommitAction,
  type CurrentPr,
  type RemoteInfo,
  type RepoOperation,
  type RepoStatus,
  type StashAction,
  type StashInfo,
  type TagInfo
} from '@shared/repo'
import type { CommitInfo, DiffFile } from '@shared/types'
import { run } from '../util'
import { diff, ghPath, info, mustGit, rawGit as git, toplevel } from './gitService'

// Repo manager: the git/GitHub operations behind the Repository view. Every call
// resolves the repo root from `cwd`, so any folder inside a repo works.

const NET_TIMEOUT = 180_000

async function rootOf(cwd: string): Promise<string> {
  const r = await toplevel(cwd)
  if (!r) throw new Error(`${cwd} is not inside a Git repository`)
  return r
}

/** Like mustGit, with a longer timeout and stdout+stderr in the result (for network commands). */
async function netGit(root: string, args: string[]): Promise<string> {
  const r = await git(root, args, undefined, NET_TIMEOUT)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`)
  return (r.stdout + r.stderr).trim()
}

async function operation(root: string): Promise<RepoOperation | undefined> {
  const r = await git(root, ['rev-parse', '--path-format=absolute', '--git-dir'], undefined, 10_000)
  if (r.code !== 0) return undefined
  const dir = r.stdout.trim()
  const has = (f: string): boolean => fs.existsSync(path.join(dir, f))
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return undefined
}

export async function status(cwd: string): Promise<RepoStatus> {
  const gi = await info(cwd)
  if (!gi.isRepo || !gi.root) return { info: gi, conflicted: [], staged: [], unstaged: [] }
  const root = gi.root
  const [op, st, staged, unstaged] = await Promise.all([operation(root), git(root, ['status', '--porcelain=v2']), diff(root, 'staged'), diff(root, 'unstaged')])
  const conflicted = parseConflicts(st.stdout)
  const isConflict = (f: DiffFile): boolean => conflicted.includes(f.newPath || f.oldPath)
  return { info: gi, operation: op, conflicted, staged: staged.filter((f) => !isConflict(f)), unstaged: unstaged.filter((f) => !isConflict(f)) }
}

export async function init(cwd: string): Promise<void> {
  await mustGit(cwd, ['init'])
}

// ------------------------------------------------------------------ remote sync
export async function fetch(cwd: string): Promise<string> {
  return netGit(await rootOf(cwd), ['fetch', '--all', '--prune'])
}

export async function pull(cwd: string, mode: 'rebase' | 'merge' = 'rebase'): Promise<string> {
  return netGit(await rootOf(cwd), ['pull', mode === 'rebase' ? '--rebase' : '--no-rebase', '--autostash'])
}

export async function push(cwd: string, opts: { force?: boolean; tags?: boolean } = {}): Promise<string> {
  const root = await rootOf(cwd)
  if (opts.tags) return netGit(root, ['push', '--tags'])
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const args = up.code === 0 ? ['push'] : ['push', '-u', 'origin', 'HEAD']
  if (opts.force) args.push('--force-with-lease')
  return netGit(root, args)
}

// ------------------------------------------------------------------ branches
export async function branchList(cwd: string): Promise<BranchInfo[]> {
  const r = await git(await rootOf(cwd), ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'])
  return parseBranches(r.stdout)
}

export async function createBranch(cwd: string, name: string, opts: { from?: string; checkout?: boolean } = {}): Promise<void> {
  const root = await rootOf(cwd)
  const from = opts.from ? [opts.from] : []
  await mustGit(root, opts.checkout === false ? ['branch', name, ...from] : ['switch', '-c', name, ...from])
}

/** Switch to a local branch, or create a local tracking branch for a remote one ("origin/x"). */
export async function checkout(cwd: string, name: string, remote = false): Promise<void> {
  const root = await rootOf(cwd)
  if (!remote) return void (await mustGit(root, ['switch', name]))
  const local = name.slice(name.indexOf('/') + 1)
  const exists = (await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`])).code === 0
  await mustGit(root, exists ? ['switch', local] : ['switch', '--track', name])
}

export async function deleteBranch(cwd: string, name: string, opts: { force?: boolean; remote?: boolean } = {}): Promise<void> {
  const root = await rootOf(cwd)
  if (opts.remote) {
    const i = name.indexOf('/')
    await netGit(root, ['push', name.slice(0, i), '--delete', name.slice(i + 1)])
    return
  }
  await mustGit(root, ['branch', opts.force ? '-D' : '-d', name])
}

export async function renameBranch(cwd: string, from: string, to: string): Promise<void> {
  await mustGit(await rootOf(cwd), ['branch', '-m', from, to])
}

export async function merge(cwd: string, name: string): Promise<string> {
  return mustGit(await rootOf(cwd), ['merge', '--no-edit', name])
}

export async function rebase(cwd: string, onto: string): Promise<string> {
  return mustGit(await rootOf(cwd), ['rebase', '--autostash', onto])
}

/** Continue or abort a stopped merge/rebase/cherry-pick/revert. */
export async function resolveOperation(cwd: string, action: 'continue' | 'abort'): Promise<void> {
  const root = await rootOf(cwd)
  const op = await operation(root)
  if (!op) throw new Error('Nothing is in progress')
  // GIT_EDITOR=true accepts the prepared message instead of opening an editor.
  const r = await run('git', ['-c', 'core.editor=true', op, `--${action}`], { cwd: root, timeout: 60_000, env: { ...process.env, GIT_EDITOR: 'true' } })
  if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `git ${op} --${action} failed`)
}

export async function markResolved(cwd: string, file: string): Promise<void> {
  await mustGit(await rootOf(cwd), ['add', '--', file])
}

// ------------------------------------------------------------------ history
export async function log(cwd: string, opts: { limit?: number; skip?: number; ref?: string } = {}): Promise<CommitInfo[]> {
  const args = ['log', `-${opts.limit ?? 40}`, `--skip=${opts.skip ?? 0}`, `--format=${LOG_FORMAT}`]
  if (opts.ref) args.push(opts.ref)
  const r = await git(await rootOf(cwd), args)
  return parseLog(r.stdout)
}

export async function lastMessage(cwd: string): Promise<string> {
  return (await mustGit(await rootOf(cwd), ['log', '-1', '--format=%B'])).trim()
}

export async function commitAction(cwd: string, sha: string, action: CommitAction): Promise<string> {
  const root = await rootOf(cwd)
  switch (action) {
    case 'checkout':
      return mustGit(root, ['switch', '--detach', sha])
    case 'cherry-pick':
      return mustGit(root, ['cherry-pick', sha])
    case 'revert':
      return mustGit(root, ['revert', '--no-edit', sha])
    default:
      return mustGit(root, ['reset', `--${action.slice(6)}`, sha])
  }
}

/** Files changed between `base` and the working tree (from their merge base). */
export async function compare(cwd: string, base: string): Promise<DiffFile[]> {
  return diff(await rootOf(cwd), 'branch', { base })
}

// ------------------------------------------------------------------ stashes
export async function stashes(cwd: string): Promise<StashInfo[]> {
  const r = await git(await rootOf(cwd), ['stash', 'list', `--format=${STASH_FORMAT}`])
  return parseStashes(r.stdout)
}

export async function stashSave(cwd: string, message: string, opts: { untracked?: boolean; staged?: boolean } = {}): Promise<void> {
  const args = ['stash', 'push']
  if (opts.untracked) args.push('--include-untracked')
  if (opts.staged) args.push('--staged')
  if (message.trim()) args.push('-m', message.trim())
  await mustGit(await rootOf(cwd), args)
}

export async function stashAction(cwd: string, index: number, action: StashAction): Promise<void> {
  await mustGit(await rootOf(cwd), ['stash', action, `stash@{${index}}`])
}

export async function stashDiff(cwd: string, index: number): Promise<DiffFile[]> {
  const root = await rootOf(cwd)
  let r = await git(root, ['stash', 'show', '-p', '--include-untracked', '--no-color', '--find-renames', `stash@{${index}}`])
  // --include-untracked for `stash show` needs git 2.32+.
  if (r.code !== 0) r = await git(root, ['stash', 'show', '-p', '--no-color', '--find-renames', `stash@{${index}}`])
  return parseUnifiedDiff(r.stdout)
}

// ------------------------------------------------------------------ tags
export async function tags(cwd: string): Promise<TagInfo[]> {
  const r = await git(await rootOf(cwd), ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags'])
  return parseTags(r.stdout)
}

export async function createTag(cwd: string, name: string, opts: { ref?: string; message?: string } = {}): Promise<void> {
  const args = opts.message?.trim() ? ['tag', '-a', name, '-m', opts.message.trim()] : ['tag', name]
  if (opts.ref) args.push(opts.ref)
  await mustGit(await rootOf(cwd), args)
}

export async function deleteTag(cwd: string, name: string, remote?: string): Promise<void> {
  const root = await rootOf(cwd)
  if (remote) await netGit(root, ['push', remote, '--delete', `refs/tags/${name}`])
  else await mustGit(root, ['tag', '-d', name])
}

export async function pushTag(cwd: string, name: string, remote = 'origin'): Promise<string> {
  return netGit(await rootOf(cwd), ['push', remote, `refs/tags/${name}`])
}

// ------------------------------------------------------------------ remotes & GitHub
export async function remotes(cwd: string): Promise<RemoteInfo[]> {
  const r = await git(await rootOf(cwd), ['remote', '-v'])
  return parseRemotes(r.stdout)
}

/** The open pull request for the current branch, if gh is available and one exists. */
export async function currentPr(cwd: string): Promise<CurrentPr | null> {
  const gh = ghPath()
  if (!gh) return null
  const r = await run(gh, ['pr', 'view', '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup'], { cwd: await rootOf(cwd), timeout: 30_000 })
  if (r.code !== 0) return null
  try {
    const p = JSON.parse(r.stdout)
    return { number: p.number, title: p.title, url: p.url, state: p.state, isDraft: !!p.isDraft, reviewDecision: p.reviewDecision || undefined, checks: summarizeChecks(p.statusCheckRollup) }
  } catch {
    return null
  }
}
