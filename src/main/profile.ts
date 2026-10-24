import { app } from 'electron'
import * as path from 'path'

/**
 * Profiles keep a dev build (or a test run) from sharing data with the installed app.
 *
 * Electron keys userData *and* the single-instance lock on the userData folder, so both
 * must be redirected before anything reads app paths or requests the lock — this module
 * is imported first by the main entry for that reason.
 *
 * - Packaged, no env:                 default profile, `%APPDATA%/Claude Deck`.
 * - `npm run dev` (not packaged):     `Claude Deck Dev`.
 * - `CLAUDE_DECK_PROFILE=<name>`:     `Claude Deck <name>` (`default` opts out).
 * - `CLAUDE_DECK_PROFILE=<abs path>`: that folder as-is (e2e tests use a temp dir).
 */
function resolveProfile(): { name: string; dir: string } | undefined {
  const env = process.env.CLAUDE_DECK_PROFILE?.trim()
  if (env === 'default') return undefined
  if (env && path.isAbsolute(env)) return { name: path.basename(env) || 'custom', dir: env }
  const name = env || (app.isPackaged ? '' : 'Dev')
  if (!name) return undefined
  return { name, dir: path.join(app.getPath('appData'), `Claude Deck ${name}`) }
}

const resolved = resolveProfile()
if (resolved) app.setPath('userData', resolved.dir)

/** The active non-default profile's name (e.g. "Dev"), or undefined for the installed app's own data. */
export const profileName: string | undefined = resolved?.name

/** Short filesystem-safe tag for per-profile names outside userData (temp dirs, pipes). */
export const profileTag: string = profileName
  ? '-' +
    profileName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  : ''
