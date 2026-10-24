import * as fs from 'fs'
import * as path from 'path'
import { expect, logErrors, test } from './fixtures'

// The editor's TypeScript support: diagnostics + Problems list, hover info, Ctrl+click definition.

test.describe('editor TypeScript support', () => {
  test.use({ launchArgs: ['{repo}'] })

  test('shows errors, hover info and goes to a definition in another file', async ({ deck }) => {
    const { page, repo } = deck
    fs.mkdirSync(path.join(repo, 'src'))
    fs.writeFileSync(path.join(repo, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'Bundler', target: 'ES2022', noEmit: true }, include: ['src'] }))
    fs.writeFileSync(path.join(repo, 'src', 'b.ts'), '/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b\n}\n')
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), "import { add } from './b'\nconst n: number = 'x'\nexport const total = add(n, 2)\n")

    await page.getByText('Overview', { exact: true }).first().click()
    await page.getByRole('button', { name: 'Open in editor' }).click()
    const editor = page.locator('.file-editor')
    await editor.locator('.fe-node.dir', { hasText: 'src' }).click()
    await editor.locator('.fe-node', { hasText: 'a.ts' }).click()

    // Diagnostics: one error, in the status bar and the Problems list.
    const status = editor.locator('.fe-status-problems')
    await expect(status).toContainText('⊗ 1', { timeout: 30_000 })
    await status.click()
    await expect(editor.locator('.fe-problem')).toContainText("Type 'string' is not assignable to type 'number'")
    await expect(editor.locator('.fe-problem')).toContainText('[2:7]')
    await expect(editor.getByRole('button', { name: /Fix 1 error with Claude/ })).toBeVisible()

    // Hover: type and docs from the other file.
    const call = editor.locator('.cm-line').nth(2).getByText('add', { exact: true })
    // (Re-hover until it shows: the layout can still shift under the pointer as panels open.)
    await expect(async () => {
      await page.mouse.move(0, 0)
      await call.hover()
      await expect(page.locator('.cm-ts-info')).toContainText('add(a: number, b: number): number', { timeout: 3000 })
    }).toPass({ timeout: 20_000 })
    await expect(page.locator('.cm-ts-info')).toContainText('Adds two numbers.')

    // Ctrl+click: opens b.ts at the definition.
    await call.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] })
    await expect(editor.locator('.fe-tab.active')).toContainText('b.ts')
    await expect(editor.locator('.fe-status')).toContainText('Ln 2, Col 17')

    // Fixing the error in the unsaved buffer clears it.
    await editor.locator('.fe-tab', { hasText: 'a.ts' }).click()
    await editor.locator('.cm-line').nth(1).getByText("'x'").click()
    await page.keyboard.press('End')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace')
    await page.keyboard.type('1')
    await expect(status).toContainText('⊗ 0', { timeout: 15_000 })
    expect(logErrors(deck)).toEqual([])
  })
})
