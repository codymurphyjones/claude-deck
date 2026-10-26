import type { PullRequestDetail, PullRequestSummary } from '@shared/types'
import { ghPath } from '../git/gitService'
import { run } from '../util'

async function gh(cwd: string, args: string[], timeout = 60_000): Promise<string> {
  const bin = ghPath()
  if (!bin) throw new Error('GitHub CLI (gh) is not installed. Install it from https://cli.github.com and run `gh auth login`.')
  const r = await run(bin, args, { cwd, timeout })
  if (r.code !== 0) throw new Error(r.stderr.trim() || `gh ${args.join(' ')} failed`)
  return r.stdout
}

const FIELDS = 'number,title,author,url,updatedAt,reviewDecision,isDraft,headRefName'

type RawPr = {
  number: number
  title: string
  author?: { login: string }
  url: string
  updatedAt: string
  reviewDecision?: string
  isDraft: boolean
  headRefName: string
}

const toSummary = (p: RawPr, repo: string): PullRequestSummary => ({
  number: p.number,
  title: p.title,
  author: p.author?.login ?? '',
  url: p.url,
  updatedAt: p.updatedAt,
  reviewDecision: p.reviewDecision,
  isDraft: p.isDraft,
  headRefName: p.headRefName,
  repo
})

export async function repoName(cwd: string): Promise<string> {
  return (await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'])).trim()
}

let viewer: string | undefined
/** The signed-in GitHub user (gh's), asked once. */
async function viewerLogin(cwd: string): Promise<string> {
  viewer ??= (await gh(cwd, ['api', 'user', '--jq', '.login'])).trim()
  return viewer
}

type ApprovalRawPr = RawPr & {
  commits?: { authors?: { login?: string }[] }[]
  latestReviews?: { author?: { login: string }; state: string }[]
}

/**
 * Open PRs `me` can approve: someone else opened them, and the newest commit isn't `me`'s (GitHub
 * doesn't let you approve your own PR, and repos can require the last push to be approved by
 * someone else). Each carries `me`'s latest review, if any; ones still needing it come first.
 */
export function pickApprovable(list: ApprovalRawPr[], me: string, repo: string): PullRequestSummary[] {
  const mine = (login?: string): boolean => !!login && login.toLowerCase() === me.toLowerCase()
  return list
    .filter((p) => !mine(p.author?.login))
    .filter((p) => {
      const last = p.commits?.[p.commits.length - 1]
      return !last?.authors?.some((a) => mine(a.login))
    })
    .map((p) => ({ ...toSummary(p, repo), myReview: p.latestReviews?.find((r) => mine(r.author?.login))?.state }))
    .sort((a, b) => Number(a.myReview === 'APPROVED') - Number(b.myReview === 'APPROVED') || b.updatedAt.localeCompare(a.updatedAt))
}

// Only each PR's newest commit (`gh pr list --json commits` asks for all of them, which exceeds
// GitHub's query size for a busy repo).
const APPROVABLE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url updatedAt isDraft headRefName reviewDecision
        author { login }
        commits(last: 1) { nodes { commit { authors(first: 10) { nodes { user { login } } } } } }
        latestReviews(first: 20) { nodes { author { login } state } }
      }
    }
  }
}`

type GqlPr = Omit<RawPr, 'reviewDecision'> & {
  reviewDecision?: string | null
  commits: { nodes: { commit: { authors: { nodes: { user?: { login: string } | null }[] } } }[] }
  latestReviews: { nodes: { author?: { login: string } | null; state: string }[] }
}

export async function approvablePrs(cwd: string): Promise<PullRequestSummary[]> {
  const [repo, me] = await Promise.all([repoName(cwd), viewerLogin(cwd)])
  const [owner, name] = repo.split('/')
  const out = JSON.parse(await gh(cwd, ['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${APPROVABLE_QUERY}`])) as { data: { repository: { pullRequests: { nodes: GqlPr[] } } } }
  const list: ApprovalRawPr[] = out.data.repository.pullRequests.nodes.map((p) => ({
    ...p,
    reviewDecision: p.reviewDecision ?? undefined,
    author: p.author ?? undefined,
    commits: p.commits.nodes.map((c) => ({ authors: c.commit.authors.nodes.map((a) => ({ login: a.user?.login })) })),
    latestReviews: p.latestReviews.nodes.map((r) => ({ author: r.author ?? undefined, state: r.state }))
  }))
  return pickApprovable(list, me, repo)
}

export async function listPrs(cwd: string, filter: 'review' | 'assigned' | 'authored' | 'all'): Promise<PullRequestSummary[]> {
  const repo = await repoName(cwd)
  const args = ['pr', 'list', '--json', FIELDS, '--limit', '50']
  if (filter === 'review') args.push('--search', 'review-requested:@me')
  if (filter === 'assigned') args.push('--assignee', '@me')
  if (filter === 'authored') args.push('--author', '@me')
  const list = JSON.parse(await gh(cwd, args)) as RawPr[]
  return list.map((p) => toSummary(p, repo))
}

export async function prDetail(cwd: string, num: number): Promise<PullRequestDetail> {
  const repo = await repoName(cwd)
  const j = JSON.parse(
    await gh(cwd, ['pr', 'view', String(num), '--json', `${FIELDS},body,baseRefName,comments,reviews,statusCheckRollup,files`])
  ) as RawPr & {
    body: string
    baseRefName: string
    comments: { author?: { login: string }; body: string; createdAt: string }[]
    reviews: { author?: { login: string }; state: string; body: string }[]
    statusCheckRollup: { name?: string; context?: string; status?: string; state?: string; conclusion?: string; detailsUrl?: string; targetUrl?: string }[]
    files: { path: string; additions: number; deletions: number }[]
  }
  const diff = await gh(cwd, ['pr', 'diff', String(num), '--color=never'], 120_000)
  return {
    ...toSummary(j, repo),
    body: j.body,
    baseRefName: j.baseRefName,
    comments: (j.comments ?? []).map((c) => ({ author: c.author?.login ?? '', body: c.body, createdAt: c.createdAt })),
    reviews: (j.reviews ?? []).map((r) => ({ author: r.author?.login ?? '', state: r.state, body: r.body })),
    checks: (j.statusCheckRollup ?? []).map((c) => ({
      name: c.name ?? c.context ?? 'check',
      status: c.status ?? c.state ?? '',
      conclusion: c.conclusion ?? c.state ?? '',
      url: c.detailsUrl ?? c.targetUrl
    })),
    files: j.files ?? [],
    diff
  }
}

export async function submitReview(cwd: string, num: number, kind: 'approve' | 'request-changes' | 'comment', body: string): Promise<void> {
  await gh(cwd, ['pr', 'review', String(num), `--${kind}`, '--body', body || (kind === 'approve' ? 'LGTM' : '')])
}

export async function comment(cwd: string, num: number, body: string): Promise<void> {
  await gh(cwd, ['pr', 'comment', String(num), '--body', body])
}
