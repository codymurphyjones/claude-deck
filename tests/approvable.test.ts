import { describe, expect, it, vi } from 'vitest'

// Pull requests you can approve: opened by someone else, newest commit not yours.

vi.mock('electron', () => ({}))

const pr = (number: number, author: string, lastCommitBy: string[], reviews: [string, string][] = [], updatedAt = '2026-10-0' + number) => ({
  number,
  title: `PR ${number}`,
  author: { login: author },
  url: `https://x/${number}`,
  updatedAt,
  isDraft: false,
  headRefName: `b${number}`,
  commits: [{ authors: [{ login: 'someone' }] }, { authors: lastCommitBy.map((login) => ({ login })) }],
  latestReviews: reviews.map(([login, state]) => ({ author: { login }, state }))
})

describe('approvable pull requests', () => {
  it('keeps PRs opened by others whose newest commit is not yours, needing your review first', async () => {
    const { pickApprovable } = await import('../src/main/github/ghService')
    const list = [
      pr(1, 'me', ['alice']), // mine: can't approve
      pr(2, 'alice', ['Me']), // I pushed the newest commit (case-insensitive)
      pr(3, 'alice', ['alice', 'me']), // co-authored newest commit
      pr(4, 'alice', ['alice'], [['me', 'APPROVED']]),
      pr(5, 'bob', ['bob'], [['me', 'CHANGES_REQUESTED']]),
      pr(6, 'carol', []) // newest commit by an unlinked email
    ]
    const got = (await pickApprovable(list, 'me', 'acme/app')).map((p) => [p.number, p.myReview])
    expect(got).toEqual([
      [6, undefined],
      [5, 'CHANGES_REQUESTED'],
      [4, 'APPROVED']
    ])
  })
})
