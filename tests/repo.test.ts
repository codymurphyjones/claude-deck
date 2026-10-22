import { describe, expect, it } from 'vitest'
import { parseBranches, parseConflicts, parseLog, parseRemotes, parseStashes, parseTags, parseTrack, refNameError, remoteWebUrl, summarizeChecks } from '@shared/repo'

const S = '\x1f'
const row = (...cols: string[]): string => cols.join(S)

describe('repo manager parsers', () => {
  it('parses upstream tracking', () => {
    expect(parseTrack('[ahead 2, behind 1]')).toEqual({ ahead: 2, behind: 1, gone: false })
    expect(parseTrack('[behind 3]')).toEqual({ ahead: 0, behind: 3, gone: false })
    expect(parseTrack('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true })
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0, gone: false })
  })

  it('parses local and remote branches, skipping origin/HEAD', () => {
    const out = [
      row('*', 'refs/heads/main', 'main', 'origin/main', '[ahead 1]', 'abc1234', '2 hours ago', 'Fix things'),
      row(' ', 'refs/heads/feature/x', 'feature/x', '', '', 'def5678', '3 days ago', 'Start x'),
      row(' ', 'refs/remotes/origin/HEAD', 'origin', '', '', 'abc1234', '2 hours ago', 'Fix things'),
      row(' ', 'refs/remotes/origin/main', 'origin/main', '', '', 'abc1233', '1 day ago', 'Older')
    ].join('\n')
    const b = parseBranches(out)
    expect(b.map((x) => x.name)).toEqual(['main', 'feature/x', 'origin/main'])
    expect(b[0]).toMatchObject({ current: true, remote: false, upstream: 'origin/main', ahead: 1, behind: 0 })
    expect(b[1]).toMatchObject({ current: false, upstream: undefined })
    expect(b[2].remote).toBe(true)
  })

  it('parses stashes, tags and log decorations', () => {
    const st = parseStashes([row('stash@{0}', 'On main: wip settings', '5 minutes ago'), row('stash@{1}', 'WIP on main: abc123 Fix', '1 day ago')].join('\n'))
    expect(st).toEqual([
      { index: 0, ref: 'stash@{0}', message: 'wip settings', date: '5 minutes ago' },
      { index: 1, ref: 'stash@{1}', message: 'abc123 Fix', date: '1 day ago' }
    ])
    expect(parseTags(row('v1.0.0', 'abc1234', '2 weeks ago', 'Release 1.0'))).toEqual([{ name: 'v1.0.0', sha: 'abc1234', date: '2 weeks ago', subject: 'Release 1.0' }])
    const log = parseLog([row('a'.repeat(40), 'aaaaaaa', 'Subject', 'Ann', 'now', 'HEAD -> main, origin/main, origin/HEAD, tag: v1'), row('b'.repeat(40), 'bbbbbbb', 'Older', 'Bob', 'then', '')].join('\n'))
    expect(log[0].refs).toEqual(['main', 'origin/main', 'tag: v1'])
    expect(log[1].refs).toBeUndefined()
  })

  it('turns remote URLs into web URLs', () => {
    expect(remoteWebUrl('git@github.com:acme/app.git')).toBe('https://github.com/acme/app')
    expect(remoteWebUrl('https://github.com/acme/app.git')).toBe('https://github.com/acme/app')
    expect(remoteWebUrl('https://user:tok@gitlab.com/g/app')).toBe('https://gitlab.com/g/app')
    expect(remoteWebUrl('ssh://git@host.example:2222/team/app.git')).toBe('https://host.example/team/app')
    expect(remoteWebUrl('/local/path')).toBeUndefined()
    expect(parseRemotes('origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nup\thttps://x.org/c/d (fetch)')).toEqual([
      { name: 'origin', url: 'git@github.com:a/b.git', webUrl: 'https://github.com/a/b' },
      { name: 'up', url: 'https://x.org/c/d', webUrl: 'https://x.org/c/d' }
    ])
  })

  it('finds conflicted paths in porcelain v2 output', () => {
    const out = ['1 .M N... 100644 100644 100644 a a src/ok.ts', 'u UU N... 100644 100644 100644 100644 a b c src/both changed.ts', '? new.txt'].join('\n')
    expect(parseConflicts(out)).toEqual(['src/both changed.ts'])
  })

  it('summarizes PR checks', () => {
    expect(summarizeChecks(undefined)).toBe('none')
    expect(summarizeChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pass')
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pending')
    expect(summarizeChecks([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail')
    expect(summarizeChecks([{ state: 'PENDING' }])).toBe('pending')
  })

  it('validates ref names', () => {
    expect(refNameError('feature/login')).toBeUndefined()
    expect(refNameError('')).toBeTruthy()
    expect(refNameError('has space')).toBeTruthy()
    expect(refNameError('a..b')).toBeTruthy()
    expect(refNameError('-x')).toBeTruthy()
    expect(refNameError('x.lock')).toBeTruthy()
  })
})
