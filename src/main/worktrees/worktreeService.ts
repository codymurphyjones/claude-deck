import * as fs from 'fs'
import * as path from 'path'
import { globToRegExp } from '@shared/paths'
import type { WorktreeRecord } from '@shared/types'
import { settings, state, toast, updateState } from '../context'
import { mustGit, rawGit as git, headSha, toplevel } from '../git/gitService'
import { findProjectForFolder, emitLibrary } from '../library'
import { runtime } from '../runtime'
import { ensureDir, shortId } from '../util'

const worktreeRoot = (): string => ensureDir(settings().worktrees.root || path.join(runtime.userData, 'worktrees'))

export const getWorktree = (id?: string): WorktreeRecord | undefined =>
  id ? state().worktrees.find((w) => w.id === id) : undefined

export function findWorktreeByPath(p: string): WorktreeRecord | undefined {
  const n = path.normalize(p).toLowerCase()
  return state().worktrees.find((w) => !w.deleted && n.startsWith(path.normalize(w.path).toLowerCase()))
}

/** Capture all working-tree changes (including untracked) as a commit, without changing files. */
async function captureChanges(cwd: string): Promise<string | undefined> {
  await git(cwd, ['add', '-A'])
  const r = await git(cwd, ['stash', 'create', 'claude-deck snapshot'])
  await git(cwd, ['reset', '-q'])
  return r.stdout.trim() || undefined
}

async function copyIncluded(repoRoot: string, dest: string): Promise<number> {
  const incFile = path.join(repoRoot, '.worktreeinclude')
  const patterns: RegExp[] = []
  if (fs.existsSync(incFile)) {
    for (const line of fs.readFileSync(incFile, 'utf8').split(/\r?\n/)) {
      const l = line.trim()
      if (l && !l.startsWith('#')) patterns.push(globToRegExp(l))
    }
  }
  const r = await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
  const ignored = r.stdout.split('\0').filter(Boolean)
  let copied = 0
  for (const rel of ignored) {
    const posix = rel.replace(/\\/g, '/')
    const always = /(^|\/)(CLAUDE\.local\.md|\.claude\/settings\.local\.json)$/i.test(posix)
    if (!always && !patterns.some((re) => re.test(posix))) continue
    const src = path.join(repoRoot, rel)
    const dst = path.join(dest, rel)
    try {
      const st = fs.lstatSync(src)
      if (st.isSymbolicLink() || !st.isFile() || fs.existsSync(dst)) continue
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      copied++
    } catch {
      /* skip unreadable files */
    }
  }
  return copied
}

export async function createWorktree(opts: {
  repoCwd: string
  baseRef?: string
  permanent?: boolean
  carryChanges?: boolean
  name?: string
  reuse?: WorktreeRecord
}): Promise<WorktreeRecord> {
  const repoRoot = await toplevel(opts.repoCwd)
  if (!repoRoot) throw new Error('Worktrees need a Git repository. This folder is not under version control.')
  const id = opts.reuse?.id ?? shortId()
  const dir = opts.reuse?.path ?? path.join(worktreeRoot(), `${path.basename(repoRoot)}-${opts.name ? opts.name.replace(/[^\w.-]+/g, '-') + '-' : ''}${id}`)
  const carried = opts.carryChanges ? await captureChanges(repoRoot) : undefined
  const base = opts.baseRef || 'HEAD'
  await mustGit(repoRoot, ['worktree', 'add', '--detach', dir, base])
  if (carried) {
    const r = await git(dir, ['stash', 'apply', carried])
    if (r.code === 0) await git(dir, ['reset', '-q'])
    else toast('Could not carry local changes into the worktree: ' + r.stderr.trim(), 'error')
  }
  const copied = await copyIncluded(repoRoot, dir)
  const rec: WorktreeRecord = {
    id,
    path: dir,
    repoRoot,
    projectId: findProjectForFolder(repoRoot)?.id,
    baseRef: base === 'HEAD' ? (await headSha(repoRoot)) ?? 'HEAD' : base,
    permanent: !!opts.permanent,
    createdAt: opts.reuse?.createdAt ?? Date.now(),
    lastUsed: Date.now(),
    chatId: opts.reuse?.chatId
  }
  updateState((s) => {
    s.worktrees = s.worktrees.filter((w) => w.id !== id)
    s.worktrees.unshift(rec)
  })
  emitLibrary()
  if (copied) toast(`Copied ${copied} ignored file(s) listed in .worktreeinclude`, 'info')
  return rec
}

export function touchWorktree(id: string, patch: Partial<WorktreeRecord> = {}): void {
  updateState((s) => {
    const w = s.worktrees.find((x) => x.id === id)
    if (w) Object.assign(w, { lastUsed: Date.now() }, patch)
  })
  emitLibrary()
}

/** Snapshot then remove a managed worktree. The snapshot can be restored later. */
export async function deleteWorktree(id: string): Promise<void> {
  const w = getWorktree(id)
  if (!w || w.deleted) return
  let snap: string | undefined
  let head: string | undefined
  if (fs.existsSync(w.path)) {
    head = await headSha(w.path)
    snap = (await captureChanges(w.path)) ?? head
    if (snap) await git(w.repoRoot, ['update-ref', `refs/claude-deck/snapshots/${w.id}`, snap])
  }
  await git(w.repoRoot, ['worktree', 'remove', '--force', w.path])
  if (fs.existsSync(w.path)) {
    try {
      fs.rmSync(w.path, { recursive: true, force: true })
    } catch {
      /* in use; git prune will catch it later */
    }
  }
  await git(w.repoRoot, ['worktree', 'prune'])
  touchWorktree(id, { deleted: true, snapshot: snap, snapshotHead: head })
}

export async function restoreWorktree(id: string): Promise<WorktreeRecord> {
  const w = getWorktree(id)
  if (!w) throw new Error('Unknown worktree')
  if (!w.deleted) return w
  const target = w.snapshot || w.baseRef
  await mustGit(w.repoRoot, ['worktree', 'add', '--detach', w.path, target])
  if (w.snapshot && w.snapshotHead && w.snapshot !== w.snapshotHead) await git(w.path, ['reset', '-q', w.snapshotHead])
  await copyIncluded(w.repoRoot, w.path)
  touchWorktree(id, { deleted: false })
  return getWorktree(id)!
}

export async function createBranchHere(id: string, name: string): Promise<string> {
  const w = getWorktree(id)
  if (!w) throw new Error('Unknown worktree')
  const prefix = settings().worktrees.branchPrefix
  const branch = name.startsWith(prefix) ? name : prefix + name
  await mustGit(w.path, ['switch', '-c', branch])
  touchWorktree(id, { branch })
  return branch
}

/** Keep only the N most recent managed worktrees; pinned/running/permanent ones are protected. */
export async function enforceLimit(isProtected: (w: WorktreeRecord) => boolean): Promise<void> {
  const cfg = settings().worktrees
  if (!cfg.autoDelete) return
  const managed = state()
    .worktrees.filter((w) => !w.permanent && !w.deleted)
    .sort((a, b) => b.lastUsed - a.lastUsed)
  const victims = managed.slice(cfg.keep).filter((w) => !isProtected(w))
  for (const v of victims) {
    try {
      await deleteWorktree(v.id)
    } catch (e) {
      toast(`Could not clean up worktree ${path.basename(v.path)}: ${(e as Error).message}`, 'error')
    }
  }
}

/** Move a worktree chat's code into the local checkout. Returns the local folder. */
export async function handoffToLocal(id: string): Promise<string> {
  const w = getWorktree(id)
  if (!w || w.deleted) throw new Error('Worktree not found')
  const repo = w.repoRoot
  const changes = await captureChanges(w.path)
  const wtHead = await headSha(w.path)
  const localHead = await headSha(repo)
  let branch = w.branch
  if (!branch && wtHead && wtHead !== localHead && wtHead !== w.baseRef) {
    branch = `${settings().worktrees.branchPrefix}handoff-${w.id}`
    await mustGit(repo, ['branch', '-f', branch, wtHead])
  }
  const localDirty = (await git(repo, ['status', '--porcelain'])).stdout.trim()
  if (localDirty) {
    await mustGit(repo, ['stash', 'push', '-u', '-m', `claude-deck: local changes before handoff from ${path.basename(w.path)}`])
    toast('Your local changes were stashed before the handoff (git stash list).', 'info')
  }
  await deleteWorktree(id)
  if (branch) await mustGit(repo, ['switch', branch])
  if (changes) {
    const r = await git(repo, ['stash', 'apply', changes])
    if (r.code !== 0) throw new Error('Handoff applied the branch but changes conflicted: ' + r.stderr.trim())
    await git(repo, ['reset', '-q'])
  }
  return repo
}

/** Move local changes into a (new or previously associated) worktree. Returns the worktree record. */
export async function handoffToWorktree(repoCwd: string, previous?: WorktreeRecord): Promise<WorktreeRecord> {
  const repo = await toplevel(repoCwd)
  if (!repo) throw new Error('Not a Git repository')
  const changes = await captureChanges(repo)
  if (changes) {
    await mustGit(repo, ['stash', 'store', '-m', 'claude-deck: handoff to worktree', changes])
    await mustGit(repo, ['reset', '-q', '--hard'])
    await git(repo, ['clean', '-fdq'])
  }
  const rec = await createWorktree({ repoCwd: repo, reuse: previous?.deleted ? previous : undefined })
  if (changes) {
    const r = await git(rec.path, ['stash', 'apply', changes])
    if (r.code === 0) await git(rec.path, ['reset', '-q'])
    else toast('Changes are in `git stash list`; applying them in the worktree failed: ' + r.stderr.trim(), 'error')
  }
  return rec
}
