import * as path from 'path'
import type { WorktreeRecord } from '@shared/types'
import { settings, state, toast } from '../context'
import { currentBranch, ghPath, rawGit as git } from '../git/gitService'
import { run } from '../util'
import { deleteWorktree } from './worktreeService'

const INTERVAL = 10 * 60_000
const NET_TIMEOUT = 60_000

interface MergedPr {
  number: number
  url: string
  headRefName: string
  headRefOid: string
}

/** Recently merged PRs of a repo, keyed by head branch (newest PR wins). */
async function mergedPrs(gh: string, repoRoot: string): Promise<Map<string, MergedPr>> {
  const out = new Map<string, MergedPr>()
  const r = await run(gh, ['pr', 'list', '--state', 'merged', '--limit', '100', '--json', 'number,url,headRefName,headRefOid'], { cwd: repoRoot, timeout: NET_TIMEOUT })
  if (r.code !== 0) return out
  try {
    for (const p of JSON.parse(r.stdout) as MergedPr[]) if (!out.has(p.headRefName)) out.set(p.headRefName, p)
  } catch {
    /* unexpected gh output: treat as nothing merged */
  }
  return out
}

/**
 * Deletes worktrees whose branch was merged on GitHub, then the branch itself (local and,
 * if enabled, remote). Only acts when nothing would be lost: the worktree is clean and its
 * tip is the merged PR head (or an ancestor of it), and the remote branch wasn't pushed to since.
 */
export class MergedWorktreeCleanup {
  private timer: NodeJS.Timeout | undefined
  private first: NodeJS.Timeout | undefined
  private busy = false

  constructor(private isProtected: (w: WorktreeRecord) => boolean) {}

  start(): void {
    this.first = setTimeout(() => void this.check(), 60_000)
    this.timer = setInterval(() => void this.check(), INTERVAL)
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.timer) clearInterval(this.timer)
  }

  async check(): Promise<void> {
    const cfg = settings().worktrees
    const gh = ghPath()
    if (!cfg.cleanupMerged || !gh || this.busy) return
    this.busy = true
    try {
      const byRepo = new Map<string, WorktreeRecord[]>()
      for (const w of state().worktrees) {
        if (w.deleted || w.permanent || this.isProtected(w)) continue
        byRepo.set(w.repoRoot, [...(byRepo.get(w.repoRoot) ?? []), w])
      }
      for (const [repoRoot, wts] of byRepo) {
        const branches = new Map<WorktreeRecord, string>()
        for (const w of wts) {
          const b = (await currentBranch(w.path)) ?? w.branch
          if (b) branches.set(w, b)
        }
        if (!branches.size) continue
        const merged = await mergedPrs(gh, repoRoot)
        for (const [w, branch] of branches) {
          const pr = merged.get(branch)
          if (!pr) continue
          try {
            await this.cleanup(w, branch, pr, cfg.deleteRemoteMerged)
          } catch (e) {
            toast(`Could not clean up merged worktree ${path.basename(w.path)}: ${(e as Error).message}`, 'error')
          }
        }
      }
    } finally {
      this.busy = false
    }
  }

  private async cleanup(w: WorktreeRecord, branch: string, pr: MergedPr, deleteRemote: boolean): Promise<void> {
    // Skip anything that could hold unmerged work.
    if ((await git(w.path, ['status', '--porcelain'])).stdout.trim()) return
    if ((await git(w.path, ['merge-base', '--is-ancestor', 'HEAD', pr.headRefOid])).code !== 0) return
    if (this.isProtected(w)) return

    const remote = (await git(w.repoRoot, ['config', '--get', `branch.${branch}.remote`])).stdout.trim() || 'origin'
    await deleteWorktree(w.id)
    await git(w.repoRoot, ['branch', '-D', branch])

    let remoteNote = ''
    if (deleteRemote) {
      const ls = await git(w.repoRoot, ['ls-remote', remote, `refs/heads/${branch}`], undefined, NET_TIMEOUT)
      const sha = ls.stdout.trim().split(/\s+/)[0]
      if (sha === pr.headRefOid) {
        const r = await git(w.repoRoot, ['push', remote, '--delete', branch], undefined, NET_TIMEOUT)
        remoteNote = r.code === 0 ? ` and ${remote}/${branch}` : ` (remote branch kept: ${r.stderr.trim().split('\n')[0]})`
      } else if (sha) remoteNote = ` (${remote}/${branch} has newer commits, kept)`
    }
    toast(`PR #${pr.number} was merged: removed worktree ${path.basename(w.path)}, branch ${branch}${remoteNote}`, 'success')
  }
}
