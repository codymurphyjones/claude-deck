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

  test('makes a branch active from the Chats view, checked out in the data folder, and lists it with the folder’s branch', async ({ deck }) => {
    const { page, repo } = deck
    await expect(page.getByText(path.basename(repo)).first()).toBeVisible()
    const sidebar = page.locator('.sidebar:not(.collapsed)')
    await expect(sidebar.locator('.branch-label', { hasText: 'main' }).first()).toContainText('checked out')
    // A branch that only exists on origin: found by searching, pulled down when picked.
    const origin = path.join(path.dirname(repo), 'origin.git')
    git(path.dirname(repo), 'init', '-q', '--bare', '-b', 'main', origin)
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', 'origin', 'main:main', 'main:refs/heads/from-origin')
    await sidebar.getByTitle(/^Make a branch active/).click()
    const picker = page.locator('.modal .branch-picker')
    await picker.locator('input').fill('from-origin')
    await picker.getByRole('button', { name: 'origin/from-origin' }).click()
    await expect(sidebar.locator('.branch-label', { hasText: 'from-origin' })).toContainText('in Claude Deck')
    // The action's toast ran with a ring and finished: full, then a check, with its success message.
    const actionToast = page.getByTestId('progress-toast').filter({ hasText: 'from-origin is now active' })
    await expect(actionToast).toHaveAttribute('data-state', 'done')
    await expect(actionToast.locator('.progress-check')).toBeVisible()
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'from-origin@{upstream}')).toBe('origin/from-origin')

    // A new branch, typed into the same search.
    await sidebar.getByTitle(/^Make a branch active/).click()
    await picker.locator('input').fill('feature-x')
    await picker.getByRole('button', { name: /New branch feature-x off main/ }).click()
    const group = sidebar.locator('.branch-label', { hasText: 'feature-x' })
    await expect(group).toContainText('in Claude Deck')
    // Checked out in the data folder, not in the user's folder (still on main).
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/feature-x')
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(logErrors(deck)).toEqual([])
  })

  test('deletes a branch from Claude Deck: its chats’ worktrees go and its chats are archived; the folder stays', async ({ deck }) => {
    const { app, page, repo } = deck
    const sidebar = page.locator('.sidebar:not(.collapsed)')
    // The chat opened with the folder works in its own worktree toward main.
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/claude/main-')
    const main = sidebar.locator('.branch-label', { hasText: 'main' }).first()
    await expect(main.locator('.sub')).toHaveText('1')
    // Answer the confirmation with its first button ("Delete from Claude Deck").
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    })
    await main.click({ button: 'right' })
    await page.locator('.menu').getByText('Delete branch from Claude Deck…').click()
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).not.toContain('claude/main-')
    // (The chat's own branch goes right after its worktree.)
    await expect.poll(() => git(repo, 'branch', '--list', 'claude/*')).toBe('')
    await expect(main.locator('.sub')).toHaveText('0')
    // The user's folder and branch are untouched.
    expect(git(repo, 'branch', '--show-current')).toBe('main')
    expect(logErrors(deck)).toEqual([])
  })

  test('deleting a chat removes the worktree made for it and archives it', async ({ deck }) => {
    const { app, page, repo } = deck
    const sidebar = page.locator('.sidebar:not(.collapsed)')
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/claude/main-')
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox
    })
    // The first chat in the main branch's group.
    await sidebar.locator('.branch-label', { hasText: 'main' }).first().locator('xpath=..').locator('.list-item').first().click({ button: 'right' })
    await page.locator('.menu').getByText('Delete…').click()
    await expect.poll(() => git(repo, 'worktree', 'list', '--porcelain')).not.toContain('claude/main-')
    const main = sidebar.locator('.branch-label', { hasText: 'main' }).first()
    await expect(main.locator('.sub')).toHaveText('0')
    // Clicking the branch's name opens a chat right in the project folder: no worktree this time.
    await main.locator('.branch-name').click()
    await expect(main.locator('.sub')).toHaveText('1')
    await expect(page.locator('.session-tab, [data-testid="chat-view"], .tab').filter({ hasText: path.basename(repo) }).first()).toBeVisible()
    expect(git(repo, 'worktree', 'list', '--porcelain')).not.toContain('claude/main-')
    // A second click goes back to that same chat rather than starting another.
    await main.locator('.branch-name').click()
    await expect(main.locator('.sub')).toHaveText('1')
    // It's archived, not erased.
    await page.keyboard.press('Control+,')
    await page.locator('.settings-nav').getByText('Archived chats', { exact: true }).click()
    await expect(page.getByRole('button', { name: 'Unarchive' })).toHaveCount(1)
    expect(logErrors(deck)).toEqual([])
  })

  test('lists .mono commands in Actions and runs one from its form with every option', async ({ deck }) => {
    const { page, repo } = deck
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fixture', packageManager: 'yarn@4.5.0', scripts: { hello: 'node -e "1"' } }))
    fs.mkdirSync(path.join(repo, '.mono'))
    fs.writeFileSync(path.join(repo, '.mono', 'config.json'), JSON.stringify({ prodFlag: 'live', workspace: { packageMaps: { db: '@my/types' } } }))
    fs.mkdirSync(path.join(repo, 'packages', 'types'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'packages', 'types', 'package.json'), JSON.stringify({ name: '@my/types', scripts: { migrate: 'node -e "1"' } }))
    fs.writeFileSync(
      path.join(repo, '.mono', 'deploy.json'),
      JSON.stringify({
        name: 'Deploy Stacks',
        description: 'Deploys the stacks',
        preactions: ['cp .env out/.env'],
        actions: ['cdk deploy -c owner=${arg}'],
        argument: { type: 'string', default: 'dev', options: ['dev', 'stage'] },
        options: { region: { type: 'string', shortcut: 'r', default: 'us-east-2' }, fresh: { description: 'Drop the database first' } },
        environments: { dev: { API_URL: 'http://localhost' }, prod: { API_URL: 'https://api.example.com' } }
      })
    )
    await expect(page.getByText(path.basename(repo)).first()).toBeVisible()
    await page.getByTitle(/^Actions — /).click()
    // The .mono folder starts open, with its command.
    const action = page.getByTestId('action-mono:deploy')
    await expect(action).toBeVisible()
    await action.click()
    const form = page.locator('.modal .action-form')
    const command = page.getByTestId('action-command')
    await expect(command).toContainText('yarn mono deploy dev')
    // Every option of the file is a control: the argument's choices, the text option, the flag, the environment.
    await form.locator('.seg button', { hasText: 'stage' }).click()
    await form.locator('.action-row', { hasText: 'region' }).locator('input').fill('eu-west-1')
    await form.locator('.action-flag', { hasText: 'fresh' }).locator('input').check()
    await form.locator('.seg button', { hasText: /^Production/ }).click()
    await expect(form.locator('.action-env')).toContainText('API_URL=https://api.example.com')
    await expect(command).toContainText('yarn mono deploy stage --region eu-west-1 --fresh --live')
    await page.locator('.modal').getByRole('button', { name: /Run/ }).click()
    // It runs as a project process with exactly that command (mono itself isn't installed here).
    const ran = await page.evaluate(async () => {
      const bridge = (window as unknown as { deckBridge: { call: (m: string) => Promise<{ command: string; action?: unknown }[]> } }).deckBridge
      return (await bridge.call('processes.list')).map((p) => p.command)
    })
    expect(ran).toContain('yarn mono deploy stage --region eu-west-1 --fresh --live')

    // A workspace with a mono alias is listed in .mono by its alias (not again as a plain folder),
    // .mono comes before the script folders, and the alias's scripts run through mono.
    const sidebar = page.locator('.sidebar:not(.collapsed)')
    const folders = await sidebar.locator('.proj-folder').allInnerTexts()
    expect(folders.filter((t) => t.includes('packages/types') && !t.includes('db'))).toEqual([])
    expect(folders.findIndex((t) => t.includes('.mono'))).toBeLessThan(folders.findIndex((t) => t.includes('root')))
    await sidebar.locator('.proj-folder.nested', { hasText: 'db' }).click()
    await sidebar.locator('.proj-script.nested', { hasText: 'migrate' }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const bridge = (window as unknown as { deckBridge: { call: (m: string) => Promise<{ command: string }[]> } }).deckBridge
          return (await bridge.call('processes.list')).map((p) => p.command)
        })
      )
      .toContain('yarn mono db migrate')
  })

  test('follows a branch switch made outside the app in the Chats view', async ({ deck }) => {
    const { page, repo } = deck
    const sidebar = page.locator('.sidebar:not(.collapsed)')
    await expect(sidebar.locator('.branch-label', { hasText: 'main' }).first()).toContainText('checked out')
    // As in a terminal or another editor, with the app's window not even refocused.
    git(repo, 'switch', '-q', '-c', 'from-terminal')
    await expect(sidebar.locator('.branch-label', { hasText: 'from-terminal' })).toContainText('checked out')
    await expect(sidebar.locator('.branch-label', { hasText: /^main/ }).first()).not.toContainText('checked out')
    await expect(sidebar.getByText('fixture-repo · on from-terminal')).toBeVisible()
    expect(logErrors(deck)).toEqual([])
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
    // The app refuses to push a chat's worktree branch, whatever asks (a view, an agent tool…).
    const pushError = await page.evaluate(async (dir) => {
      const bridge = (window as unknown as { deckBridge: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).deckBridge
      return bridge.call('git.push', dir).then(
        () => 'pushed',
        (e: Error) => e.message
      )
    }, wt)
    expect(pushError).toContain('Chat branches are never pushed')
    // The chat's work, committed on its branch.
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'from the chat\n')
    git(wt, 'add', 'feature.txt')
    git(wt, 'commit', '-q', '-m', 'Add feature from chat')

    await page.keyboard.press('Control+Shift+G')
    const bar = page.getByTestId('review-pane').locator('.chat-branch-bar')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(bar).toContainText('1 to merge')
    // A worktree's work only leaves by merging: no push or pull request of its own.
    const review = page.getByTestId('review-pane')
    await expect(review.getByRole('button', { name: /Merge into main/ }).last()).toBeVisible()
    await expect(review.getByRole('button', { name: /Commit & push|Create PR|^Push/ })).toHaveCount(0)
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
    // (It's re-applied just after the fast-forward that brought feature.txt, so wait for it.)
    await expect.poll(() => fs.readFileSync(path.join(repo, 'notes.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('first line\nsecond line\n')
    // Nothing else went wrong (the refused push above is logged, as it should be).
    expect(logErrors(deck).filter((l) => !l.includes('Chat branches are never pushed'))).toEqual([])
  })
})
