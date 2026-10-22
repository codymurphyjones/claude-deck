import { app } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { ensureDir, which } from './util'

/** Process-wide runtime facts: where things live and how to launch helpers. */
export const runtime = {
  token: randomBytes(16).toString('hex'),
  pipe:
    process.platform === 'win32'
      ? `\\\\.\\pipe\\claude-deck-${process.pid}`
      : path.join(os.tmpdir(), `claude-deck-${process.pid}.sock`),
  get userData(): string {
    return app.getPath('userData')
  },
  get sessionsDir(): string {
    return ensureDir(path.join(app.getPath('userData'), 'sessions'))
  },
  get tempDir(): string {
    return ensureDir(path.join(os.tmpdir(), 'claude-deck'))
  },
  get scratchDir(): string {
    return ensureDir(path.join(app.getPath('userData'), 'quick-chats'))
  },
  resource(name: string): string {
    const candidates = [
      path.join(process.resourcesPath || '', 'resources', name),
      path.join(app.getAppPath(), 'resources', name),
      path.join(__dirname, '../../resources', name)
    ]
    return candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1]
  }
}

let cachedNode: string | null | undefined

/** A Node binary for hook/MCP helpers: system node if present, else Electron-as-node. */
export function helperRuntime(): { command: string; env: Record<string, string>; viaElectron: boolean } {
  if (cachedNode === undefined) cachedNode = which('node') ?? null
  if (cachedNode) return { command: cachedNode, env: {}, viaElectron: false }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, viaElectron: true }
}

let cachedClaude: string | undefined

export function locateClaude(override?: string): string {
  if (override && fs.existsSync(override)) return override
  if (cachedClaude && fs.existsSync(cachedClaude)) return cachedClaude
  const home = os.homedir()
  const candidates = [
    which('claude'),
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : undefined,
    path.join(home, '.claude', 'local', process.platform === 'win32' ? 'claude.exe' : 'claude')
  ].filter(Boolean) as string[]
  cachedClaude = candidates.find((c) => fs.existsSync(c)) ?? 'claude'
  return cachedClaude
}

export function defaultShell(override?: string): string {
  if (override) return override
  if (process.platform === 'win32') return which('pwsh') ?? 'powershell.exe'
  return process.env.SHELL || '/bin/bash'
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}
