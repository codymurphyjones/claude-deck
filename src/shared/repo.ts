// Repo manager: types and parsers for the git/GitHub state shown in the Repository view.
// The git commands themselves live in src/main/git/repoService.ts.

import type { CommitInfo, DiffFile, GitInfo } from './types'

export interface BranchInfo {
  name: string
  remote: boolean
  current: boolean
  upstream?: string
  ahead: number
  behind: number
  /** The upstream branch was deleted on the remote. */
  gone: boolean
  sha: string
  date: string
  subject: string
}

export interface StashInfo {
  index: number
  ref: string
  message: string
  date: string
}

export interface TagInfo {
  name: string
  sha: string
  date: string
  subject: string
}

export interface RemoteInfo {
  name: string
  url: string
  /** Browser URL for GitHub/GitLab/Bitbucket-style remotes. */
  webUrl?: string
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

export interface RepoStatus {
  info: GitInfo
  /** A merge/rebase/cherry-pick/revert stopped part-way (usually on conflicts). */
  operation?: RepoOperation
  conflicted: string[]
  staged: DiffFile[]
  unstaged: DiffFile[]
}

export type ChecksState = 'pass' | 'fail' | 'pending' | 'none'

export interface CurrentPr {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision?: string
  checks: ChecksState
}

export type CommitAction = 'checkout' | 'cherry-pick' | 'revert' | 'reset-soft' | 'reset-mixed' | 'reset-hard'
export type StashAction = 'apply' | 'pop' | 'drop'

/** Separator used in all --format strings below. */
export const SEP = '\x1f'

export const BRANCH_FORMAT = ['%(HEAD)', '%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)', '%(objectname:short)', '%(committerdate:relative)', '%(contents:subject)'].join('%1f')
export const STASH_FORMAT = ['%gd', '%gs', '%cr'].join('%x1f')
export const TAG_FORMAT = ['%(refname:short)', '%(objectname:short)', '%(creatordate:relative)', '%(contents:subject)'].join('%1f')
export const LOG_FORMAT = ['%H', '%h', '%s', '%an', '%cr', '%D'].join('%x1f')

const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.trim())

/** "[ahead 2, behind 1]" / "[gone]" from %(upstream:track). */
export function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  return {
    ahead: +(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: +(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: /\bgone\b/.test(track)
  }
}

export function parseBranches(out: string): BranchInfo[] {
  const res: BranchInfo[] = []
  for (const l of lines(out)) {
    const [head, full, name, upstream, track, sha, date, subject] = l.split(SEP)
    if (!full || full.endsWith('/HEAD')) continue
    res.push({
      name,
      remote: full.startsWith('refs/remotes/'),
      current: head === '*',
      upstream: upstream || undefined,
      ...parseTrack(track ?? ''),
      sha: sha ?? '',
      date: date ?? '',
      subject: subject ?? ''
    })
  }
  return res
}

export function parseStashes(out: string): StashInfo[] {
  return lines(out).map((l, i) => {
    const [ref, message, date] = l.split(SEP)
    const index = +(/\{(\d+)\}/.exec(ref)?.[1] ?? i)
    return { index, ref, message: (message ?? '').replace(/^(WIP on|On) [^:]+:\s*/, ''), date: date ?? '' }
  })
}

export function parseTags(out: string): TagInfo[] {
  return lines(out).map((l) => {
    const [name, sha, date, subject] = l.split(SEP)
    return { name, sha: sha ?? '', date: date ?? '', subject: subject ?? '' }
  })
}

export function parseLog(out: string): CommitInfo[] {
  return lines(out).map((l) => {
    const [sha, short, subject, author, date, decor] = l.split(SEP)
    const refs = (decor ?? '')
      .split(',')
      .map((r) => r.trim().replace(/^HEAD -> /, ''))
      .filter((r) => r && r !== 'HEAD' && !r.endsWith('/HEAD'))
    return { sha, short, subject, author, date, ...(refs.length ? { refs } : {}) }
  })
}

/** Browser URL for a remote, e.g. git@github.com:o/r.git → https://github.com/o/r. */
export function remoteWebUrl(url: string): string | undefined {
  const u = url.trim()
  let m = /^git@([^:]+):(.+?)(?:\.git)?\/?$/.exec(u)
  if (m) return `https://${m[1]}/${m[2]}`
  m = /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u)
  if (m) return `https://${m[1]}/${m[2]}`
  m = /^https?:\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/.exec(u)
  if (m) return `https://${m[1]}`
  return undefined
}

/** `git remote -v` output → one entry per remote (fetch URL). */
export function parseRemotes(out: string): RemoteInfo[] {
  const seen = new Map<string, RemoteInfo>()
  for (const l of lines(out)) {
    const [name, rest] = l.split('\t')
    if (!name || !rest || seen.has(name)) continue
    const url = rest.replace(/\s+\((fetch|push)\)$/, '')
    seen.set(name, { name, url, webUrl: remoteWebUrl(url) })
  }
  return [...seen.values()]
}

/** Paths with unresolved conflicts, from `git status --porcelain=v2` ("u" records). */
export function parseConflicts(porcelainV2: string): string[] {
  return lines(porcelainV2)
    .filter((l) => l.startsWith('u '))
    .map((l) => l.split(' ').slice(10).join(' '))
}

type CheckRun = { status?: string; conclusion?: string; state?: string }

/** Collapse a PR's statusCheckRollup into one state. */
export function summarizeChecks(rollup: CheckRun[] | undefined): ChecksState {
  if (!rollup?.length) return 'none'
  const bad = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
  if (rollup.some((c) => bad.has(c.conclusion ?? '') || bad.has(c.state ?? ''))) return 'fail'
  if (rollup.some((c) => (c.status && c.status !== 'COMPLETED') || c.state === 'PENDING' || c.state === 'EXPECTED')) return 'pending'
  return 'pass'
}

/** Light check of a branch/tag name (git has the final word). */
export function refNameError(name: string): string | undefined {
  const n = name.trim()
  if (!n) return 'Enter a name'
  if (/[\s~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|[/.]$|\.lock$/.test(n)) return `"${n}" is not a valid name`
  return undefined
}

/**
 * A drafted commit message as plain text. Models sometimes wrap the message in a ``` fence,
 * lead with "Here's a commit message:", or quote it; keep only the message itself.
 */
export function cleanCommitMessage(raw: string): string {
  let t = raw.replace(/\r\n?/g, '\n').trim()
  // The content of the first fenced block, if there is one.
  const fence = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/m.exec(t)
  if (fence) t = fence[2]
  else t = t.replace(/^(`{3,}|~{3,})[^\n]*\n?/, '').replace(/\n?(`{3,}|~{3,})\s*$/, '')
  t = t.trim()
  // A lead-in line such as "Here's a concise commit message:" when more lines follow.
  const lines = t.split('\n')
  if (lines.length > 1 && /^(here('|’)?s|here is|sure|suggested|proposed|commit message)\b.*:\s*$/i.test(lines[0])) t = lines.slice(1).join('\n').trim()
  // Whole message in quotes or backticks.
  const q = /^(["'`])([\s\S]+)\1$/.exec(t)
  if (q && !q[2].includes(q[1])) t = q[2].trim()
  return t.replace(/^(subject|title):\s*/i, '').replace(/\n{3,}/g, '\n\n')
}
