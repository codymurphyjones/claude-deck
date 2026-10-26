import * as fs from 'fs'
import * as path from 'path'
import { globToRegExp } from '@shared/paths'
import type { WorktreeRecord } from '@shared/types'
import { settings, state, toast, updateState } from '../context'
import { mustGit, rawGit as git, headSha, toplevel } from '../git/gitService'
import { findProjectForFolder, emitLibrary } from '../library'
import { runtime } from '../runtime'
import { ensureDir, run, shortId } from '../util'
import { withProgress, type Progress } from '../progress'
import { NO_PUSH_REMOTE } from '../git/pushGuard'
import * as os from 'os'

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

/** Ignored files that are always worth bringing into a worktree (local Claude settings). */
const ALWAYS_COPY = ['CLAUDE.local.md', '.claude/settings.local.json']

/**
 * A .worktreeinclude pattern (gitignore style) as git pathspecs that find the same files, so git
 * only searches for them instead of listing every ignored file (node_modules alone can be tens of
 * thousands, taking seconds). Results are still checked against the exact pattern afterwards.
 */
function includePathspecs(pattern: string): string[] {
  const p = pattern.replace(/\\/g, '/').replace(/\/$/, '/**')
  if (p.startsWith('/')) return [`:(glob)${p.slice(1)}`]
  return p.includes('/') && !p.startsWith('**/') ? [`:(glob)${p}`, `:(glob)**/${p}`] : [`:(glob)${p}`, `:(glob)**/${p.replace(/^\*\*\//, '')}`]
}

async function copyIncluded(repoRoot: string, dest: string): Promise<number> {
  const incFile = path.join(repoRoot, '.worktreeinclude')
  const patterns: RegExp[] = []
  const lines: string[] = []
  if (fs.existsSync(incFile)) {
    for (const line of fs.readFileSync(incFile, 'utf8').split(/\r?\n/)) {
      const l = line.trim()
      if (l && !l.startsWith('#')) {
        patterns.push(globToRegExp(l))
        lines.push(l)
      }
    }
  }
  const pathspecs = [...new Set([...ALWAYS_COPY, ...lines].flatMap(includePathspecs))]
  const r = await git(repoRoot, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...pathspecs])
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

/**
 * Make the repo's installed packages available in a worktree without reinstalling: each
 * node_modules folder (at the root and up to two levels down, e.g. packages/x/node_modules) is
 * linked in (a junction on Windows). The links are added to the repo's info/exclude, because git
 * doesn't treat a link as the ignored `node_modules/` folder and `git add -A` would commit it.
 */
async function linkNodeModules(repoRoot: string, dest: string): Promise<void> {
  const found: string[] = []
  const walk = (rel: string, depth: number): void => {
    let ents: fs.Dirent[] = []
    try {
      ents = fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git') continue
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.name === 'node_modules') found.push(r)
      else if (depth < 2 && !e.name.startsWith('.')) walk(r, depth + 1)
    }
  }
  walk('', 0)
  if (!found.length) return
  const linked: string[] = []
  for (const r of found) {
    const link = path.join(dest, r)
    if (fs.existsSync(link) || !fs.existsSync(path.dirname(link))) continue
    try {
      fs.symlinkSync(path.join(repoRoot, r), link, process.platform === 'win32' ? 'junction' : 'dir')
      linked.push(r)
    } catch {
      /* not fatal: the chat can still install packages itself */
    }
  }
  if (!linked.length) return
  const common = (await git(repoRoot, ['rev-parse', '--git-common-dir'])).stdout.trim()
  const exclude = path.join(path.resolve(repoRoot, common), 'info', 'exclude')
  try {
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : ''
    const add = linked.map((r) => `/${r}`).filter((l) => !cur.split(/\r?\n/).includes(l))
    if (add.length) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true })
      fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}# Claude Deck: node_modules links in worktrees\n${add.join('\n')}\n`)
    }
  } catch {
    /* best effort */
  }
}

/** Remove node_modules links from a worktree first, so deleting it can never reach through them into the repo's packages. */
function unlinkNodeModules(dir: string): void {
  const walk = (d: string, depth: number): void => {
    let ents: fs.Dirent[] = []
    try {
      ents = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.name === 'node_modules') {
        try {
          if (fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p)
        } catch {
          /* leave it */
        }
      } else if (e.isDirectory() && depth < 2 && e.name !== '.git' && !e.name.startsWith('.')) walk(p, depth + 1)
    }
  }
  walk(dir, 0)
}

/**
 * A commit of `cwd`'s working tree (tracked and new files; ignored ones aside) on top of its HEAD,
 * made through a temporary index so the checkout's own index and files are left alone.
 */
async function snapshotCommit(cwd: string): Promise<string> {
  const idx = path.join(os.tmpdir(), `deck-index-${shortId()}`)
  const env = { ...process.env, GIT_INDEX_FILE: idx }
  const g = async (args: string[]): Promise<string> => {
    const r = await run('git', args, { cwd, env, timeout: 120_000 })
    if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`)
    return r.stdout.trim()
  }
  try {
    await g(['read-tree', 'HEAD'])
    await g(['add', '-A'])
    const tree = await g(['write-tree'])
    return await g(['-c', 'user.name=Claude Deck', '-c', 'user.email=deck@localhost', 'commit-tree', tree, '-p', 'HEAD', '-m', 'Claude Deck: snapshot'])
  } finally {
    fs.rmSync(idx, { force: true })
  }
}

export { NO_PUSH_REMOTE }

/**
 * A chat's branch tracks the same upstream as the branch it works toward (e.g. origin/main), so
 * `git pull` in its worktree brings down the remote's updates. Its work still goes into the local
 * branch with "Merge into"; pushes from it are refused (pushRemote: a remote that doesn't exist),
 * even from the user's own terminal, so tracking origin/main can't send its commits there.
 * Worktrees share the repo's remotes, so origin is already the parent's. Idempotent.
 */
export async function trackParentUpstream(repoRoot: string, branch: string, target: string): Promise<void> {
  const get = async (key: string): Promise<string> => (await git(repoRoot, ['config', '--get', key])).stdout.trim()
  let remote = await get(`branch.${target}.remote`)
  let merge = await get(`branch.${target}.merge`)
  if (!remote || !merge || remote === '.') {
    // The target doesn't track anything (or tracks a local branch): its namesake on origin, if any.
    if ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${target}`])).code !== 0) {
      await git(repoRoot, ['config', `branch.${branch}.pushRemote`, NO_PUSH_REMOTE])
      return
    }
    remote = 'origin'
    merge = `refs/heads/${target}`
  }
  await git(repoRoot, ['config', `branch.${branch}.remote`, remote])
  await git(repoRoot, ['config', `branch.${branch}.merge`, merge])
  await git(repoRoot, ['config', `branch.${branch}.pushRemote`, NO_PUSH_REMOTE])
}

/**
 * A new detached worktree holding another checkout's current state (e.g. a chat's worktree): its
 * commits, with its uncommitted changes as uncommitted changes. The source is not modified.
 */
export async function worktreeFromCheckout(from: string, opts: { name?: string; onBranch?: boolean } = {}): Promise<WorktreeRecord> {
  const snap = await snapshotCommit(from)
  const repo = state().worktrees.find((w) => !w.deleted && path.resolve(w.path).toLowerCase() === path.resolve(from).toLowerCase())?.repoRoot ?? from
  const wt = await createWorktree({ repoCwd: repo, baseRef: snap, name: opts.name })
  await mustGit(wt.path, ['reset', '-q', 'HEAD~1'])
  const patch: Partial<WorktreeRecord> = { baseRef: (await headSha(wt.path)) ?? wt.baseRef }
  // Working toward the source's branch, on a sub-branch of its own (as a chat's worktree does).
  const target = opts.onBranch ? await currentBranchOf(from) : undefined
  if (target) {
    patch.branch = `${settings().worktrees.branchPrefix}${target.replace(/[^\w./-]+/g, '-')}-${wt.id}`
    patch.target = target
    // Marked (and tracking the target's upstream) before it's checked out.
    await mustGit(wt.path, ['branch', patch.branch, 'HEAD'])
    await trackParentUpstream(repo, patch.branch, target)
    await mustGit(wt.path, ['switch', '-q', patch.branch])
  }
  touchWorktree(wt.id, patch)
  emitLibrary()
  return { ...wt, ...patch }
}

async function currentBranchOf(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['branch', '--show-current'])
  return r.stdout.trim() || undefined
}

/**
 * The local branch to work toward for `name`. A remote branch ("origin/feature") maps to its local
 * branch, created tracking it when there isn't one yet, so the chat merges into a real branch.
 */
export async function localBranchFor(repoRoot: string, name: string): Promise<string> {
  const has = async (ref: string): Promise<boolean> => (await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref])).code === 0
  if (await has(`refs/heads/${name}`)) return name
  if (!(await has(`refs/remotes/${name}`))) return name
  const local = name.slice(name.indexOf('/') + 1)
  if (!(await has(`refs/heads/${local}`))) await mustGit(repoRoot, ['branch', '--track', local, name])
  return local
}

/** The folder that has local branch `name` checked out ('' if git doesn't say where), or undefined. */
export async function checkedOutAt(repoRoot: string, name: string): Promise<string | undefined> {
  for (const block of (await git(repoRoot, ['worktree', 'list', '--porcelain'])).stdout.replace(/\r/g, '').split(/\n\s*\n/)) {
    if (block.split('\n').includes(`branch refs/heads/${name}`)) return /^worktree (.+)$/m.exec(block)?.[1]?.trim() ?? ''
  }
  return undefined
}

/**
 * A chat working toward `target` merges into its local checkout, so make sure there is one: a
 * branch not checked out anywhere is checked out in Claude Deck (made active). Returns the local
 * branch name (a remote branch maps to its local one).
 */
export async function ensureActiveBranch(repoCwd: string, target: string): Promise<string> {
  const repoRoot = (await toplevel(repoCwd)) ?? repoCwd
  const name = await localBranchFor(repoRoot, target)
  if ((await checkedOutAt(repoRoot, name)) === undefined) await checkoutBranch(repoRoot, name)
  return name
}

/**
 * Make `branch` an active branch of the repo by checking it out in Claude Deck's data folder (a
 * permanent worktree that holds it). A remote branch gets a local branch tracking it; with `from`,
 * a new branch is created off that ref. Fails if the branch is already checked out somewhere.
 */
export async function checkoutBranch(repoCwd: string, branch: string, opts: { from?: string } = {}): Promise<WorktreeRecord> {
  const repoRoot = state().worktrees.find((w) => !w.deleted && path.resolve(w.path).toLowerCase() === path.resolve(repoCwd).toLowerCase())?.repoRoot ?? (await toplevel(repoCwd))
  if (!repoRoot) throw new Error('This folder is not a Git repository.')
  const exists = async (ref: string): Promise<boolean> => (await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref])).code === 0
  let name = branch
  if (opts.from) {
    if (await exists(`refs/heads/${branch}`)) throw new Error(`A branch named ${branch} already exists.`)
  } else name = await localBranchFor(repoRoot, branch)
  // A branch can only be checked out in one place.
  const at = await checkedOutAt(repoRoot, name)
  if (at !== undefined) throw new Error(`${name} is already checked out${at ? ` in ${at}` : ''}.`)
  const id = shortId()
  const dir = path.join(worktreeRoot(), `${path.basename(repoRoot)}-${name.replace(/[^\w.-]+/g, '-')}-${id}`)
  await withProgress(`worktree:${repoRoot.toLowerCase()}`, `Checking out ${name} in Claude Deck`, async (p) => {
    p.step('Checking out files…')
    await mustGit(repoRoot, opts.from ? ['worktree', 'add', '-b', name, dir, opts.from] : ['worktree', 'add', dir, name])
    p.step('Copying local files (.worktreeinclude)…')
    await copyIncluded(repoRoot, dir)
    if (settings().worktrees.linkNodeModules) {
      p.step('Linking node_modules…')
      await linkNodeModules(repoRoot, dir)
    }
  })
  const rec: WorktreeRecord = {
    id,
    path: dir,
    repoRoot,
    projectId: findProjectForFolder(repoRoot)?.id,
    baseRef: (await headSha(dir)) ?? name,
    permanent: true,
    holdsBranch: true,
    branch: name,
    createdAt: Date.now(),
    lastUsed: Date.now()
  }
  updateState((s) => {
    s.worktrees.unshift(rec)
  })
  emitLibrary()
  return rec
}

/**
 * Stop holding a branch in the data folder: removes its checkout there; the branch itself stays.
 * Refuses while it has uncommitted changes, or while chats work toward it (`inUse`), unless `force`:
 * then uncommitted changes are kept as a snapshot ref (refs/claude-deck/snapshots/<id>).
 */
export async function releaseBranch(id: string, inUse: string[] = [], opts: { force?: boolean } = {}): Promise<void> {
  const w = getWorktree(id)
  if (!w || !w.holdsBranch) throw new Error('That branch is no longer held in Claude Deck.')
  if (inUse.length && !opts.force) throw new Error(`${inUse.length} chat${inUse.length === 1 ? ' works' : 's work'} toward ${w.branch}: ${inUse.join(', ')}. Merge or close them first.`)
  if (fs.existsSync(w.path)) {
    if ((await git(w.path, ['status', '--porcelain'])).stdout.trim()) {
      if (!opts.force) throw new Error(`${w.branch} has uncommitted changes in Claude Deck's copy (${w.path}). Commit or discard them first.`)
      const snap = await captureChanges(w.path)
      if (snap) {
        await git(w.repoRoot, ['update-ref', `refs/claude-deck/snapshots/${w.id}`, snap])
        toast(`${w.branch}'s uncommitted changes in Claude Deck were kept: git stash apply refs/claude-deck/snapshots/${w.id}`, 'info')
      }
    }
    unlinkNodeModules(w.path)
  }
  await git(w.repoRoot, ['worktree', 'remove', '--force', w.path])
  if (fs.existsSync(w.path)) fs.rmSync(w.path, { recursive: true, force: true })
  await git(w.repoRoot, ['worktree', 'prune'])
  updateState((s) => {
    s.worktrees = s.worktrees.filter((x) => x.id !== id)
  })
  emitLibrary()
}

interface CreateOpts {
  repoCwd: string
  baseRef?: string
  permanent?: boolean
  carryChanges?: boolean
  name?: string
  reuse?: WorktreeRecord
  /** Work toward this local branch: the worktree gets its own sub-branch off it. */
  target?: string
}

/** A new worktree, with progress (and an ETA learned per repo) shown while it's made. */
export async function createWorktree(opts: CreateOpts): Promise<WorktreeRecord> {
  const repoRoot = await toplevel(opts.repoCwd)
  if (!repoRoot) throw new Error('Worktrees need a Git repository. This folder is not under version control.')
  return withProgress(`worktree:${repoRoot.toLowerCase()}`, `Preparing a worktree of ${path.basename(repoRoot)}`, (p) => makeWorktree(repoRoot, opts, p))
}

async function makeWorktree(repoRoot: string, opts: CreateOpts, p: Progress): Promise<WorktreeRecord> {
  if (opts.target) opts = { ...opts, target: await localBranchFor(repoRoot, opts.target) }
  p.step('Checking out files…')
  const id = opts.reuse?.id ?? shortId()
  const dir = opts.reuse?.path ?? path.join(worktreeRoot(), `${path.basename(repoRoot)}-${opts.name ? opts.name.replace(/[^\w.-]+/g, '-') + '-' : ''}${id}`)
  const carried = opts.carryChanges ? await captureChanges(repoRoot) : undefined
  const base = opts.target || opts.baseRef || 'HEAD'
  // Re-creating a worktree that has a branch: check that branch out (pulled) rather than detaching.
  const onBranch = opts.reuse?.branch && !carried ? await addOnBranch({ ...opts.reuse, path: dir, snapshot: undefined }) : false
  // A chat working toward a branch gets its own sub-branch off it, merged back with "Merge into".
  let chatBranch: string | undefined
  if (!onBranch && opts.target) {
    chatBranch = `${settings().worktrees.branchPrefix}${opts.target.replace(/[^\w./-]+/g, '-')}-${id}`
    // The branch first, marked unpushable and tracking the target's upstream, then its worktree: it's
    // never checked out anywhere without its push block.
    await mustGit(repoRoot, ['branch', chatBranch, opts.target])
    await trackParentUpstream(repoRoot, chatBranch, opts.target)
    const added = await git(repoRoot, ['worktree', 'add', dir, chatBranch])
    if (added.code !== 0) {
      await git(repoRoot, ['branch', '-D', chatBranch])
      throw new Error(added.stderr.trim() || `Couldn't create the worktree for ${chatBranch}`)
    }
  } else if (!onBranch) await mustGit(repoRoot, ['worktree', 'add', '--detach', dir, base])
  if (carried) {
    const r = await git(dir, ['stash', 'apply', carried])
    if (r.code === 0) await git(dir, ['reset', '-q'])
    else toast('Could not carry local changes into the worktree: ' + r.stderr.trim(), 'error')
  }
  p.step('Copying local files (.worktreeinclude)…')
  const copied = await copyIncluded(repoRoot, dir)
  if (settings().worktrees.linkNodeModules) {
    p.step('Linking node_modules…')
    await linkNodeModules(repoRoot, dir)
  }
  const rec: WorktreeRecord = {
    id,
    path: dir,
    repoRoot,
    projectId: findProjectForFolder(repoRoot)?.id,
    // On a branch, the worktree's own HEAD is where its changes start from.
    baseRef: onBranch || chatBranch ? ((await headSha(dir)) ?? base) : base === 'HEAD' ? ((await headSha(repoRoot)) ?? 'HEAD') : base,
    permanent: !!opts.permanent,
    branch: chatBranch ?? (onBranch ? opts.reuse?.branch : undefined),
    target: opts.target ?? opts.reuse?.target,
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
    unlinkNodeModules(w.path)
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

const refExists = async (cwd: string, ref: string): Promise<boolean> => (await git(cwd, ['rev-parse', '--verify', '--quiet', ref])).code === 0

/**
 * Re-create a worktree on its branch, brought up to date with the remote ("pull it down"), instead
 * of a detached snapshot. Returns false (nothing created) if that isn't possible, e.g. the branch is
 * checked out in another worktree; the caller then falls back to the detached snapshot. Every
 * fallback or partial result is reported, so the user knows why they got what they got.
 */
async function addOnBranch(w: WorktreeRecord): Promise<boolean> {
  const b = w.branch
  if (!b) return false
  // Short: this blocks the restore. Offline, the branch is restored as of the last fetch.
  const f = await git(w.repoRoot, ['fetch', '--quiet', 'origin', b], undefined, 15_000)
  const remote = (await refExists(w.repoRoot, `refs/remotes/origin/${b}`)) ? `origin/${b}` : undefined
  const local = await refExists(w.repoRoot, `refs/heads/${b}`)
  if (!local && !remote) {
    toast(`Branch ${b} no longer exists locally or on origin; restored the worktree from its snapshot instead.`, 'info')
    return false
  }
  if (f.code !== 0 && remote) toast(`Couldn't fetch ${b} from origin (${f.stderr.trim() || 'timed out'}); restored it as of the last fetch.`, 'info')
  const r = local ? await git(w.repoRoot, ['worktree', 'add', w.path, b]) : await git(w.repoRoot, ['worktree', 'add', '--track', '-b', b, w.path, remote!])
  if (r.code !== 0) {
    toast(`Couldn't check out ${b} (${r.stderr.trim()}); restored the worktree as a detached snapshot instead.`, 'info')
    return false
  }
  // Take the remote's newer commits; a diverged branch is left alone for the user to reconcile.
  if (local && remote && (await git(w.path, ['merge', '--ff-only', '--quiet', remote])).code !== 0) toast(`${b} has diverged from ${remote}; pull or rebase it in the worktree.`, 'info')
  // Uncommitted work captured when the worktree was cleaned up.
  if (w.snapshot && w.snapshot !== w.snapshotHead) {
    const a = await git(w.path, ['stash', 'apply', w.snapshot])
    if (a.code === 0) await git(w.path, ['reset', '-q'])
    else {
      // Don't leave a half-applied, conflicted tree. The worktree is brand new, so going back to the
      // branch tip loses nothing; the changes stay in the snapshot ref.
      await git(w.path, ['reset', '--hard', '-q', 'HEAD'])
      await git(w.path, ['clean', '-fdq'])
      toast(`Restored ${b}, but its uncommitted changes conflict with the branch now, so they weren't applied. They're kept in refs/claude-deck/snapshots/${w.id} (git stash apply ${w.snapshot.slice(0, 10)}).`, 'error')
    }
  }
  return true
}

export async function restoreWorktree(id: string): Promise<WorktreeRecord> {
  const w = getWorktree(id)
  if (!w) throw new Error('Unknown worktree')
  if (!w.deleted) return w
  await withProgress(`worktree:${w.repoRoot.toLowerCase()}`, `Restoring ${w.branch ?? path.basename(w.path)}`, async (p) => {
    p.step('Checking out files…')
    // Once the worktree has a branch, restore that branch rather than the snapshot.
    if (!(await addOnBranch(w))) {
      const target = w.snapshot || w.baseRef
      await mustGit(w.repoRoot, ['worktree', 'add', '--detach', w.path, target])
      if (w.snapshot && w.snapshotHead && w.snapshot !== w.snapshotHead) await git(w.path, ['reset', '-q', w.snapshotHead])
    }
    p.step('Copying local files (.worktreeinclude)…')
    await copyIncluded(w.repoRoot, w.path)
    if (settings().worktrees.linkNodeModules) {
      p.step('Linking node_modules…')
      await linkNodeModules(w.repoRoot, w.path)
    }
  })
  touchWorktree(id, { deleted: false })
  return getWorktree(id)!
}

/** Put the worktree on a new branch at its current commit. `exact` uses the name as given (no prefix). */
export async function createBranchHere(id: string, name: string, exact = false): Promise<string> {
  const w = getWorktree(id)
  if (!w) throw new Error('Unknown worktree')
  const prefix = settings().worktrees.branchPrefix
  const branch = exact || name.startsWith(prefix) ? name : prefix + name
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
