import * as fs from 'fs'
import * as path from 'path'
import { buildFilePatch, buildHunkPatch, parseUnifiedDiff } from '@shared/diff'
import type { CommitInfo, DiffFile, DiffView, GitInfo } from '@shared/types'
import { Batcher, fromProcess, loadProgressive, type LoadResult } from '../loading/progressiveLoader'
import { run, which } from '../util'

const git = (cwd: string, args: string[], input?: string, timeout = 60_000) =>
  run('git', ['-c', 'core.quotepath=false', ...args], { cwd, input, timeout })

export const ghPath = (): string | undefined => which('gh')

export async function toplevel(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], undefined, 10_000)
  return r.code === 0 ? path.normalize(r.stdout.trim()) : undefined
}

export async function commonDir(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], undefined, 10_000)
  return r.code === 0 ? path.normalize(r.stdout.trim()) : undefined
}

export async function currentBranch(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['branch', '--show-current'], undefined, 10_000)
  const b = r.stdout.trim()
  return r.code === 0 && b ? b : undefined
}

export async function headSha(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', 'HEAD'], undefined, 10_000)
  return r.code === 0 ? r.stdout.trim() : undefined
}

export async function info(cwd: string): Promise<GitInfo> {
  const root = await toplevel(cwd)
  if (!root) return { isRepo: false }
  const [branch, st, remotes, def] = await Promise.all([
    currentBranch(root),
    git(root, ['status', '--porcelain=v2', '--branch']),
    git(root, ['remote']),
    git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  ])
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  let dirty = 0
  let tracked = 0
  let staged = 0
  for (const line of st.stdout.split('\n')) {
    if (/^[12u] /.test(line)) tracked++
    // "1 XY …" / "2 XY …": X is the index (staged) side, "." when unchanged.
    if (/^[12] [^.]/.test(line)) staged++
    if (line.startsWith('# branch.upstream ')) upstream = line.slice(18).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) {
        ahead = +m[1]
        behind = +m[2]
      }
    } else if (line && !line.startsWith('#')) dirty++
  }
  let defaultBranch = def.code === 0 ? def.stdout.trim().replace(/^origin\//, '') : undefined
  if (!defaultBranch) {
    const has = async (b: string) => (await git(root, ['rev-parse', '--verify', '--quiet', b])).code === 0
    defaultBranch = (await has('main')) ? 'main' : (await has('master')) ? 'master' : undefined
  }
  // Nothing tracked upstream (a new branch, or a worktree's detached HEAD): count the commits that
  // aren't on the default branch yet, i.e. what a push would publish.
  if (!upstream && defaultBranch && branch !== defaultBranch) {
    for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
      const r = await git(root, ['rev-list', '--count', `${base}..HEAD`])
      if (r.code === 0) {
        ahead = +r.stdout.trim() || 0
        break
      }
    }
  }
  return {
    isRepo: true,
    root,
    branch,
    upstream,
    ahead,
    behind,
    dirty,
    tracked,
    staged,
    defaultBranch,
    hasRemote: remotes.stdout.trim().length > 0,
    ghAvailable: !!ghPath()
  }
}

export async function branches(cwd: string): Promise<string[]> {
  const r = await git(cwd, ['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads', 'refs/remotes'])
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD'))
}

export async function recentCommits(cwd: string, n = 30): Promise<CommitInfo[]> {
  const r = await git(cwd, ['log', `-${n}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cr'])
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, short, subject, author, date] = l.split('\x1f')
      return { sha, short, subject, author, date }
    })
}

async function untrackedDiffs(root: string, onFile?: (f: DiffFile) => void, signal?: AbortSignal): Promise<DiffFile[]> {
  const r = await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const files = r.stdout.split('\0').filter(Boolean).slice(0, 200)
  const out: DiffFile[] = []
  const add = (d: DiffFile): void => {
    out.push(d)
    onFile?.(d)
  }
  for (const f of files) {
    if (signal?.aborted) break
    const full = path.join(root, f)
    let size = 0
    try {
      size = fs.statSync(full).size
    } catch {
      continue
    }
    if (size > 1024 * 1024) {
      add({ oldPath: f, newPath: f, headerLines: [], hunks: [], binary: true, status: 'untracked', additions: 0, deletions: 0 })
      continue
    }
    const d = await git(root, ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', f])
    const parsed = parseUnifiedDiff(d.stdout)
    for (const p of parsed) {
      p.status = 'untracked'
      p.newPath = f
      p.oldPath = f
      add(p)
    }
    if (!parsed.length) add({ oldPath: f, newPath: f, headerLines: [], hunks: [], binary: false, status: 'untracked', additions: 0, deletions: 0 })
  }
  return out
}

export async function diff(cwd: string, view: DiffView, opts: { ref?: string; base?: string } = {}): Promise<DiffFile[]> {
  const root = (await toplevel(cwd)) ?? cwd
  const base = ['diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames']
  switch (view) {
    case 'unstaged': {
      const r = await git(root, base)
      return [...parseUnifiedDiff(r.stdout), ...(await untrackedDiffs(root))]
    }
    case 'staged':
      return parseUnifiedDiff((await git(root, [...base, '--cached'])).stdout)
    case 'commit': {
      const ref = opts.ref || 'HEAD'
      return parseUnifiedDiff((await git(root, ['show', '--no-color', '--no-ext-diff', '--format=', '--find-renames', ref])).stdout)
    }
    case 'branch': {
      const target = opts.base || 'main'
      const mb = await git(root, ['merge-base', 'HEAD', target])
      if (mb.code !== 0) throw new Error(`No merge base with ${target}`)
      const r = await git(root, [...base, mb.stdout.trim()])
      return [...parseUnifiedDiff(r.stdout), ...(await untrackedDiffs(root))]
    }
    case 'lastTurn': {
      if (!opts.ref) return []
      const r = await git(root, [...base, opts.ref])
      return parseUnifiedDiff(r.stdout)
    }
  }
}

/**
 * Same result as `diff`, delivered progressively: files are emitted as soon as their part
 * of the output has arrived. A small diff comes out as a single batch.
 */
export async function diffProgressive(cwd: string, view: DiffView, opts: { ref?: string; base?: string }, emit: (files: DiffFile[]) => void, signal?: AbortSignal): Promise<LoadResult> {
  const root = (await toplevel(cwd)) ?? cwd
  const base = ['diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames']
  let args: string[] | undefined
  let untracked = false
  switch (view) {
    case 'unstaged':
      args = base
      untracked = true
      break
    case 'staged':
      args = [...base, '--cached']
      break
    case 'commit':
      args = ['show', '--no-color', '--no-ext-diff', '--format=', '--find-renames', opts.ref || 'HEAD']
      break
    case 'branch': {
      const target = opts.base || 'main'
      const mb = await git(root, ['merge-base', 'HEAD', target])
      if (mb.code !== 0) throw new Error(`No merge base with ${target}`)
      args = [...base, mb.stdout.trim()]
      untracked = true
      break
    }
    case 'lastTurn':
      if (opts.ref) args = [...base, opts.ref]
      break
  }
  const result: LoadResult = args
    ? await loadProgressive(fromProcess('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, signal }), (seg) => parseUnifiedDiff(seg), emit, { format: 'unified-diff', signal })
    : { format: 'unified-diff', records: 0, chars: 0, batches: 0 }
  if (untracked && !signal?.aborted) {
    const batcher = new Batcher(emit)
    const extra = await untrackedDiffs(root, (f) => batcher.add(f), signal)
    batcher.flush()
    result.records += extra.length
  }
  return result
}

/** Snapshot the working tree (tracked changes) without touching it. */
export async function snapshot(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['stash', 'create'])
  const sha = r.stdout.trim()
  return sha || (await headSha(cwd))
}

type HunkAction = 'stage' | 'unstage' | 'revert'

export async function applyHunk(cwd: string, file: DiffFile, hunkIndex: number, action: HunkAction): Promise<void> {
  const root = (await toplevel(cwd)) ?? cwd
  if (file.status === 'untracked') {
    if (action === 'stage') return void (await mustGit(root, ['add', '--', file.newPath]))
    if (action === 'revert') return fs.rmSync(path.join(root, file.newPath), { force: true })
  }
  const patch = buildHunkPatch(file, hunkIndex)
  const args = ['apply', '--whitespace=nowarn', '--recount']
  if (action === 'stage') args.push('--cached')
  if (action === 'unstage') args.push('--cached', '-R')
  if (action === 'revert') args.push('-R')
  args.push('-')
  const r = await git(root, args, patch)
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'git apply failed')
}

export async function applyFile(cwd: string, file: DiffFile, action: HunkAction): Promise<void> {
  const root = (await toplevel(cwd)) ?? cwd
  const p = file.newPath || file.oldPath
  if (action === 'stage') {
    await mustGit(root, ['add', '-A', '--', p, ...(file.status === 'renamed' ? [file.oldPath] : [])])
  } else if (action === 'unstage') {
    await mustGit(root, ['restore', '--staged', '--', p, ...(file.status === 'renamed' ? [file.oldPath] : [])])
  } else if (file.status === 'untracked') {
    fs.rmSync(path.join(root, p), { force: true, recursive: true })
  } else if (file.status === 'added') {
    // Added in the working tree relative to the view: drop it.
    const r = await git(root, ['apply', '-R', '-'], buildFilePatch(file))
    if (r.code !== 0) throw new Error(r.stderr.trim())
  } else {
    const r = await git(root, ['apply', '-R', '--whitespace=nowarn', '-'], buildFilePatch(file))
    if (r.code !== 0) await mustGit(root, ['restore', '--', p])
  }
}

export async function applyAll(cwd: string, action: HunkAction): Promise<void> {
  const root = (await toplevel(cwd)) ?? cwd
  if (action === 'stage') await mustGit(root, ['add', '-A'])
  else if (action === 'unstage') await mustGit(root, ['reset', '-q'])
  else {
    await mustGit(root, ['restore', '--', '.'])
    await mustGit(root, ['clean', '-fd'])
  }
}

async function mustGit(cwd: string, args: string[], input?: string): Promise<string> {
  const r = await git(cwd, args, input)
  if (r.code !== 0) throw new Error(r.stderr.trim() || `git ${args[0]} failed`)
  return r.stdout
}

export async function commit(cwd: string, message: string, opts: { all?: boolean; amend?: boolean } = {}): Promise<string> {
  const root = (await toplevel(cwd)) ?? cwd
  if (opts.all) await mustGit(root, ['add', '-A'])
  // Amending with no message folds the staged changes into the last commit and keeps its message.
  if (opts.amend && !message.trim()) return mustGit(root, ['commit', '--amend', '--no-edit'])
  const args = ['commit', '-F', '-']
  if (opts.amend) args.push('--amend')
  return mustGit(root, args, message)
}

export async function push(cwd: string): Promise<string> {
  const root = (await toplevel(cwd)) ?? cwd
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  const r = up.code === 0 ? await git(root, ['push'], undefined, 180_000) : await git(root, ['push', '-u', 'origin', 'HEAD'], undefined, 180_000)
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'push failed')
  return (r.stdout + r.stderr).trim()
}

export async function pull(cwd: string): Promise<string> {
  const root = (await toplevel(cwd)) ?? cwd
  const r = await git(root, ['pull', '--rebase', '--autostash'], undefined, 180_000)
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'pull failed')
  return (r.stdout + r.stderr).trim()
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await mustGit(cwd, ['switch', '-c', name])
}

export async function switchBranch(cwd: string, name: string): Promise<void> {
  await mustGit(cwd, ['switch', name])
}

export async function createPr(cwd: string, opts: { title?: string; body?: string; draft?: boolean; base?: string }): Promise<string> {
  const gh = ghPath()
  if (!gh) throw new Error('GitHub CLI (gh) is not installed')
  const root = (await toplevel(cwd)) ?? cwd
  const args = ['pr', 'create']
  if (opts.title) args.push('--title', opts.title, '--body', opts.body ?? '')
  else args.push('--fill')
  if (opts.draft) args.push('--draft')
  if (opts.base) args.push('--base', opts.base)
  const r = await run(gh, args, { cwd: root, timeout: 120_000 })
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'gh pr create failed')
  return r.stdout.trim().split('\n').pop() ?? ''
}

export async function rawDiffForMessage(cwd: string): Promise<string> {
  const root = (await toplevel(cwd)) ?? cwd
  const staged = await git(root, ['diff', '--cached', '--no-color', '--stat', '-p'])
  if (staged.stdout.trim()) return staged.stdout.slice(0, 60_000)
  const all = await git(root, ['diff', '--no-color', '--stat', '-p'])
  // `commit -a` doesn't add new files, but the user usually stages them anyway; describe them too.
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)
  let out = all.stdout
  for (const f of untracked) {
    if (out.length >= 60_000) break
    let body = ''
    try {
      const buf = await fs.promises.readFile(path.join(root, f))
      body = buf.includes(0) ? '(binary file)\n' : buf.toString('utf8').slice(0, 8_000)
    } catch {
      continue
    }
    out += `\nNew file: ${f}\n${body}`
  }
  return out.slice(0, 60_000)
}

export { git as rawGit, mustGit }
