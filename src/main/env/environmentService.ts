import * as fs from 'fs'
import * as path from 'path'
import type { EnvAction, EnvironmentConfig } from '@shared/types'

const FILE = path.join('.claude-deck', 'environment.json')

/** Per-project local environment: worktree setup scripts and top-bar actions (committable). */
export function loadEnvironment(root: string): EnvironmentConfig {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, FILE), 'utf8'))
    return { setup: j.setup ?? {}, actions: Array.isArray(j.actions) ? j.actions : [] }
  } catch {
    return { setup: {}, actions: [] }
  }
}

export function saveEnvironment(root: string, cfg: EnvironmentConfig): void {
  const file = path.join(root, FILE)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n')
}

const osKey = (): 'windows' | 'macos' | 'linux' =>
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

export function setupCommand(cfg: EnvironmentConfig): string | undefined {
  const s = cfg.setup ?? {}
  return (s[osKey()] || s.default || '').trim() || undefined
}

export function actionCommand(a: EnvAction): string {
  return (a[osKey()] || a.command || '').trim()
}
