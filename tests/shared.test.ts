import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { buildHunkPatch, numberHunkLines, parseUnifiedDiff } from '@shared/diff'
import { baseName, claimKey, encodeProjectDir, globToRegExp, normalizeKey, uniqueFolders } from '@shared/paths'
import { nextRunAfter } from '@shared/schedule'
import type { Automation } from '@shared/types'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 one
+two
 three
 four
@@ -10,2 +11,2 @@ function x() {
-old
+new
 tail
diff --git a/new.txt b/new.txt
new file mode 100644
--- /dev/null
+++ b/new.txt
@@ -0,0 +1 @@
+hello
`

describe('diff parsing', () => {
  it('parses files, hunks and stats', () => {
    const files = parseUnifiedDiff(DIFF)
    expect(files).toHaveLength(2)
    expect(files[0].newPath).toBe('src/a.ts')
    expect(files[0].hunks).toHaveLength(2)
    expect(files[0].additions).toBe(2)
    expect(files[0].deletions).toBe(1)
    expect(files[1].status).toBe('added')
    expect(files[1].hunks[0].newLines).toBe(1)
  })

  it('numbers hunk lines', () => {
    const h = parseUnifiedDiff(DIFF)[0].hunks[1]
    expect(numberHunkLines(h)).toEqual([
      [10, null],
      [null, 11],
      [11, 12]
    ])
  })

  it('builds a single-hunk patch that git can apply to the index', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-diff-'))
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' })
    git('init', '-q')
    fs.writeFileSync(path.join(dir, 'f.txt'), Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n')
    git('add', '-A')
    git('commit', '-qm', 'init')
    const lines = fs.readFileSync(path.join(dir, 'f.txt'), 'utf8').split('\n')
    lines[1] = 'CHANGED TOP'
    lines[25] = 'CHANGED BOTTOM'
    fs.writeFileSync(path.join(dir, 'f.txt'), lines.join('\n'))
    const files = parseUnifiedDiff(git('diff'))
    expect(files[0].hunks).toHaveLength(2)
    execFileSync('git', ['apply', '--cached', '--recount', '-'], { cwd: dir, input: buildHunkPatch(files[0], 1) })
    const staged = git('diff', '--cached')
    expect(staged).toContain('CHANGED BOTTOM')
    expect(staged).not.toContain('CHANGED TOP')
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('paths', () => {
  it('normalizes keys case-insensitively on Windows', () => {
    expect(normalizeKey('C:\\Repo\\App\\', true)).toBe('c:/repo/app')
    expect(normalizeKey('/home/Repo/', false)).toBe('/home/Repo')
  })

  it('makes repo-relative claim keys stable across worktrees', () => {
    expect(claimKey('C:\\repo\\src\\a.ts', 'C:\\repo', true)).toBe('src/a.ts')
    expect(claimKey('D:\\wt\\repo-1\\src\\a.ts', 'D:\\wt\\repo-1', true)).toBe('src/a.ts')
    expect(claimKey('D:\\elsewhere\\x.ts', 'C:\\repo', true)).toBe('d:/elsewhere/x.ts')
  })

  it('encodes project dirs like Claude Code', () => {
    expect(encodeProjectDir('Z:\\Workspaces\\other\\claude_ui')).toBe('Z--Workspaces-other-claude-ui')
  })

  it('dedupes dropped folders', () => {
    expect(uniqueFolders(['C:\\a', 'c:\\A\\', 'C:\\b'], true)).toEqual(['C:\\a', 'C:\\b'])
    expect(baseName('C:\\x\\proj\\')).toBe('proj')
  })

  it('matches .worktreeinclude patterns', () => {
    expect(globToRegExp('.env').test('.env')).toBe(true)
    expect(globToRegExp('.env').test('packages/api/.env')).toBe(true)
    expect(globToRegExp('/.env').test('packages/api/.env')).toBe(false)
    expect(globToRegExp('config/*.local.json').test('config/db.local.json')).toBe(true)
    expect(globToRegExp('secrets/').test('secrets/key.pem')).toBe(true)
    expect(globToRegExp('**/*.pem').test('a/b/c.pem')).toBe(true)
  })
})

describe('schedules', () => {
  const base: Automation = {
    id: 'a',
    name: 't',
    prompt: 'p',
    kind: 'standalone',
    schedule: { type: 'interval', minutes: 30 },
    cwd: '.',
    useWorktree: false,
    status: 'active',
    createdAt: Date.parse('2026-01-01T00:00:00Z')
  }

  it('computes interval runs from the last run', () => {
    const last = Date.parse('2026-01-02T10:00:00Z')
    expect(nextRunAfter({ ...base, lastRun: last }, last)).toBe(last + 30 * 60_000)
  })

  it('computes RRULE runs', () => {
    const a = { ...base, schedule: { type: 'rrule' as const, rule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0' } }
    const next = nextRunAfter(a, Date.parse('2026-03-05T12:00:00Z'))!
    expect(new Date(next).toISOString()).toBe('2026-03-06T09:00:00.000Z')
  })

  it('does not schedule paused tasks', () => {
    expect(nextRunAfter({ ...base, status: 'paused' }, Date.now())).toBeUndefined()
  })
})

import { compareVersions } from '@shared/version'
describe('versions', () => {
  it('orders releases and master builds', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1-dev.5', '0.1.0')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1', '0.1.1-dev.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.1-dev.10', '0.1.1-dev.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
  })
})
