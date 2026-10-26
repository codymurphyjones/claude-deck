import * as fs from 'fs'
import * as path from 'path'
import { expect, logErrors, test } from './fixtures'

// A pick list in a reply: items are selectable, and Answer sends the picked ones to be completed.

test.describe('pick lists in replies', () => {
  test.use({ launchArgs: ['{repo}'], signedIn: true })

  test('selects items from a reply’s list and answers with them', async ({ deck }) => {
    const { page, repo } = deck
    // A resumed chat whose last reply has a pick list (as Claude writes it, in its transcript).
    const id = '11111111-2222-4333-8444-555555555555'
    const dir = path.join(path.dirname(deck.profile), 'home', '.claude', 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
    fs.mkdirSync(dir, { recursive: true })
    const text = [
      'Here is what I found:',
      '',
      '__________list: What should I fix?__________',
      '----------',
      '**Fix the login bug**',
      'It fails when the token expires.',
      '----------',
      'Add tests for `parseDate`',
      '----------',
      'Remove the unused `legacy/` folder',
      '----------',
      '__________',
      '',
      'Pick the ones you want.'
    ].join('\n')
    const ts = new Date().toISOString()
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: id, timestamp: ts, cwd: repo, message: { role: 'user', content: 'review the code' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: id, timestamp: ts, cwd: repo, message: { id: 'm1', role: 'assistant', model: 'x', content: [{ type: 'text', text }] } }
    ]
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    await expect(page.getByText(path.basename(repo)).first()).toBeVisible()
    await page.evaluate(
      async ({ cwd, id }) => {
        const b = (window as unknown as { deckBridge: { call: (m: string, ...a: unknown[]) => Promise<unknown> } }).deckBridge
        await b.call('session.create', 'agent', { cwd, resumeId: id, provider: 'claude', inPlace: true })
      },
      { cwd: repo, id }
    )
    // Its tab (the chat opened with the folder has its own, with a worktree suffix).
    await page.locator('.subtabs .title', { hasText: /^fixture-repo$/ }).click()
    const card = page.getByTestId('pick-list').filter({ visible: true })
    await expect(card).toContainText('What should I fix?')
    await expect(card.locator('.pick-item')).toHaveCount(3)
    // The text around the list still renders as usual.
    await expect(page.getByText('Pick the ones you want.')).toBeVisible()

    const answer = card.getByRole('button', { name: 'Answer' })
    await expect(answer).toBeDisabled()
    await card.locator('.pick-item', { hasText: 'Fix the login bug' }).click()
    await card.locator('.pick-item', { hasText: 'legacy/' }).click()
    await card.getByPlaceholder(/Add a note/).fill('Start with the login bug.')
    await expect(card).toContainText('2 of 3 selected')
    await answer.click()
    // Sent as a message asking to complete the picked items; the card shows what it was answered with.
    await expect(page.locator('.msg-user').last()).toContainText('Please complete these 2 items from "What should I fix?"')
    await expect(page.locator('.msg-user').last()).toContainText('Start with the login bug.')
    await expect(card).toContainText('Answered: asked to complete 2 of 3')
    await expect(card.getByRole('button', { name: 'Answer' })).toHaveCount(0)
    expect(logErrors(deck)).toEqual([])
  })
})
