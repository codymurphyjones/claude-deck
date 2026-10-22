import * as fs from 'fs'
import * as path from 'path'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { helperRuntime, runtime } from '../../runtime'
import { agentEnv, meshServer, sessionBrief, sessionDirs } from '../../sessions/launch'
import { ensureDir, toPosix } from '../../util'

/** Write per-session settings (hooks) + MCP config, and build the claude argv. */
export function buildClaudeArgs(s: SessionInfo): string[] {
  const cfg = settings()
  const prov = cfg.providers.claude
  const dir = ensureDir(path.join(runtime.sessionsDir, s.id))
  const helper = helperRuntime()
  const relay = toPosix(runtime.resource('hookRelay.cjs'))
  const cmd = `${helper.viaElectron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}"${toPosix(helper.command)}" "${relay}"`
  const hook = (timeout: number, matcher?: string) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout }] }]

  const sessionSettings: Record<string, unknown> = {
    hooks: {
      SessionStart: hook(15),
      UserPromptSubmit: hook(15),
      PreToolUse: hook(20, 'Edit|Write|MultiEdit|NotebookEdit'),
      PostToolUse: hook(15, '*'),
      Notification: hook(10),
      Stop: hook(30),
      SessionEnd: hook(5)
    }
  }
  if (cfg.mesh.enabled) sessionSettings.permissions = { allow: ['mcp__deck-mesh'] }
  const settingsFile = path.join(dir, 'settings.json')
  fs.writeFileSync(settingsFile, JSON.stringify(sessionSettings, null, 2))

  const L = s.launch
  const args: string[] = []
  if (L.resumeId) {
    args.push('--resume', L.resumeId)
    if (L.fork) args.push('--fork-session')
  } else if (L.continueLast) args.push('--continue')
  else if (s.agentSessionId && !L.extraArgs?.some((a) => a === '--from-pr' || a === '--resume' || a === '--continue'))
    args.push('--session-id', s.agentSessionId)

  args.push('--name', s.name)
  const model = L.model || prov.defaultModel
  if (model) args.push('--model', model)
  const effort = L.effort || prov.defaultEffort
  if (effort) args.push('--effort', effort)
  const mode = L.permissionMode || prov.defaultPermissionMode
  if (mode) args.push('--permission-mode', mode)
  args.push('--settings', settingsFile)

  if (cfg.mesh.enabled) {
    const mcpFile = path.join(dir, 'mcp.json')
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { 'deck-mesh': { type: 'stdio', ...meshServer(s) } } }, null, 2))
    args.push('--mcp-config', mcpFile)
  }

  for (const d of sessionDirs(s)) args.push('--add-dir', d)

  const sys = sessionBrief(s)
  if (sys) args.push('--append-system-prompt', sys)

  if (L.extraArgs?.length) args.push(...L.extraArgs)
  // The first prompt is sent as a chat message, not a positional argument.
  return args
}

export const claudeEnv = agentEnv
