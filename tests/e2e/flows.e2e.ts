import * as fs from 'fs'
import * as path from 'path'
import { expect, git, logErrors, test } from './fixtures'

test.describe('fresh profile', () => {
  test('launches with the main window and no logged errors', async ({ deck }) => {
    const { page } = deck
    await expect(page.locator('#root')).not.toBeEmpty()
    await expect(page.getByText('Projects', { exact: true }).first()).toBeVisible()
    // Settings → Diagnostics lists the startup entry from the main-process log.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').getByText('Diagnostics', { exact: true }).click()
    await expect(page.getByTestId('diag-entries')).toContainText('Started v')
    expect(logErrors(deck)).toEqual([])
  })

  test('an unhandled failing call is toasted and logged', async ({ deck }) => {
    const { page } = deck
    await expect(page.locator('#root')).not.toBeEmpty()
    // Fire-and-forget like `void api.x()` call sites do.
    await page.evaluate(() => {
      void (window as unknown as { deckBridge: { call: (m: string) => Promise<unknown> } }).deckBridge.call('e2e.noSuchMethod')
    })
    await expect(page.locator('.toast.error')).toContainText('Unknown method e2e.noSuchMethod')
    await expect.poll(() => logErrors(deck).join('\n')).toContain('[ipc:e2e.noSuchMethod] Unknown method e2e.noSuchMethod')
  })
})

test.describe('with a project folder', () => {
  // Opening a folder from the command line is the same path as Explorer's "Open with Claude Deck".
  test.use({ launchArgs: ['{repo}'] })

  test('adds the folder as a project and shows its overview', async ({ deck }) => {
    const { page, repo } = deck
    const name = path.basename(repo)
    await expect(page.getByText(name).first()).toBeVisible()
    // Persisted to the profile's state.json (written on a short debounce).
    const savedFolders = (): string[][] => {
      try {
        const st = JSON.parse(fs.readFileSync(path.join(deck.profile, 'state.json'), 'utf8'))
        return st.projects.map((p: { folders: string[] }) => p.folders.map((f) => path.resolve(f)))
      } catch {
        return []
      }
    }
    await expect.poll(savedFolders).toContainEqual([path.resolve(repo)])
    // The project overview names the folder's full path and branch.
    await page.getByText('Overview', { exact: true }).first().click()
    await expect(page.getByText(repo, { exact: true }).first()).toBeVisible()
  })

  test.describe('chats editing the folder directly', () => {
    test.use({ settings: { worktrees: { perChat: false } } })

    test('stages and commits a change from the Review pane', async ({ deck }) => {
      const { page, repo } = deck
      await expect(page.getByText(path.basename(repo)).first()).toBeVisible()
      await page.keyboard.press('Control+Shift+G')
      const review = page.getByTestId('review-pane')
      await expect(review.getByText('notes.txt')).toBeVisible()
      await review.getByRole('button', { name: 'Stage all' }).click()
      await expect.poll(() => git(repo, 'diff', '--cached', '--name-only')).toBe('notes.txt')
      await review.getByPlaceholder('Commit message').fill('Add a second line')
      // `.btn`: the commit button, not the "Commit" view tab.
      const commit = review.locator('button.btn', { hasText: /^Commit$/ })
      await expect(commit).toBeEnabled()
      await commit.click()
      await expect.poll(() => git(repo, 'log', '-1', '--format=%s')).toBe('Add a second line')
      expect(git(repo, 'status', '--porcelain')).toBe('')
      expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('notes.txt')
      expect(logErrors(deck)).toEqual([])
    })
  })

  test('a chat in its own worktree merges into the checked-out branch, waiting while the folder has local changes', async ({ deck }) => {
    const { page, repo } = deck
    await expect(page.getByText(path.basename(repo)).first()).toBeVisible()
    // The chat got its own worktree, on a sub-branch off the folder's branch (main).
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/claude/main-')
    const entry = git(repo, 'worktree', 'list', '--porcelain')
      .split(/\n\s*\n/)
      .map((b) => b.split('\n'))
      .find((l) => l.some((x) => x.startsWith('branch refs/heads/claude/main-')))!
    const wt = entry.find((x) => x.startsWith('worktree '))!.slice(9)
    // The chat's work, committed on its branch.
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'from the chat\n')
    git(wt, 'add', 'feature.txt')
    git(wt, 'commit', '-q', '-m', 'Add feature from chat')

    await page.keyboard.press('Control+Shift+G')
    const bar = page.getByTestId('review-pane').locator('.chat-branch-bar')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(bar).toContainText('1 to merge')
    await bar.getByRole('button', { name: /Merge into main/ }).click()

    // The folder has an uncommitted edit (notes.txt), so the update waits to be confirmed.
    const banner = page.locator('.banner', { hasText: 'has new commits from' })
    await expect(banner).toBeVisible()
    expect(fs.existsSync(path.join(repo, 'feature.txt'))).toBe(false)
    await banner.getByRole('button', { name: 'Update now' }).click()
    await expect.poll(() => fs.existsSync(path.join(repo, 'feature.txt'))).toBe(true)
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('Add feature from chat')
    // The user's own edit survived.
    // (git may rewrite its line endings per core.autocrlf when re-applying it.)
    expect(fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('first line\nsecond line\n')
    expect(logErrors(deck)).toEqual([])
  })
})
