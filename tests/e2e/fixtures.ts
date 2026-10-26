import { _electron as electron, test as base, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const ROOT = path.resolve(__dirname, '../..')

export interface Deck {
  app: ElectronApplication
  page: Page
  /** Throwaway userData folder (CLAUDE_DECK_PROFILE). */
  profile: string
  /** A git repo with one commit and one modified file. */
  repo: string
  /** Lines of the diagnostics log written so far. */
  logLines: () => string[]
}

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/**
 * A stand-in `claude` that never talks to the real CLI: it stays alive (the app keeps a chat process
 * per session) and answers nothing. `signedIn`: `claude auth status` says so, so chats start (and a
 * resumed chat shows its transcript).
 */
function writeFakeClaude(dir: string, signedIn = false): string {
  const js = path.join(dir, 'fake-claude.cjs')
  fs.writeFileSync(
    js,
    "if (process.argv.includes('--version')) { console.log('0.0.0 (fake)'); process.exit(0) }\n" +
      `if (process.argv.includes('auth') && process.argv.includes('status')) { console.log(JSON.stringify({ loggedIn: ${signedIn} })); process.exit(0) }\n` +
      "process.stdin.resume()\nprocess.stdin.on('end', () => process.exit(0))\n"
  )
  if (process.platform === 'win32') {
    const cmd = path.join(dir, 'claude.cmd')
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`)
    return cmd
  }
  const sh = path.join(dir, 'claude')
  fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 })
  return sh
}

function makeRepo(dir: string): string {
  const repo = path.join(dir, 'fixture-repo')
  fs.mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Deck E2E')
  git(repo, 'config', 'user.email', 'e2e@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n')
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first line\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'Initial commit')
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'first line\nsecond line\n')
  return repo
}

export const test = base.extend<{ deck: Deck; launchArgs: string[]; settings: Record<string, unknown>; signedIn: boolean }>({
  launchArgs: [[], { option: true }],
  // Extra settings for the profile, merged over the defaults (e.g. { worktrees: { perChat: false } }).
  settings: [{}, { option: true }],
  // The fake claude reports being signed in, so chats start.
  signedIn: [false, { option: true }],
  deck: async ({ launchArgs, settings, signedIn }, use, testInfo) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-'))
    const profile = path.join(tmp, 'profile')
    const home = path.join(tmp, 'home')
    fs.mkdirSync(profile)
    fs.mkdirSync(home)
    const repo = makeRepo(tmp)
    const claude = writeFakeClaude(tmp, signedIn)
    // Seeded settings: merged over the defaults on load.
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ providers: { claude: { path: claude }, codex: { path: claude } }, mesh: { enabled: false }, ...settings }))
    // The project folder (not out/main/index.js) so package.json's name/version apply.
    const args = [ROOT, ...launchArgs.map((a) => a.replace('{repo}', repo))]
    const app = await electron.launch({
      args,
      cwd: ROOT,
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_DECK_PROFILE: profile,
        // Keep ~/.claude, ~/.claude-deck (routines) etc. out of the user's real home.
        USERPROFILE: home,
        HOME: home,
        ELECTRON_ENABLE_LOGGING: '1'
      }
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const logFile = path.join(profile, 'logs', 'claude-deck.log')
    const logLines = (): string[] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [])
    await use({ app, page, profile, repo, logLines })
    if (testInfo.status !== testInfo.expectedStatus) {
      await page.screenshot({ path: testInfo.outputPath('failure.png') }).catch(() => undefined)
      await testInfo.attach('claude-deck.log', { body: logLines().join('\n'), contentType: 'text/plain' })
    }
    await app.close().catch(() => undefined)
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
})

/** Error lines from the diagnostics log (each entry's header line). */
export const logErrors = (deck: Deck): string[] => deck.logLines().filter((l) => / ERROR /.test(l))

export { expect }
