import * as fs from 'fs'
import * as path from 'path'
import type { MeshRole, SessionInfo } from '@shared/types'
import { settings } from '../context'
import { getProject } from '../library'
import { helperRuntime, runtime } from '../runtime'
import { ensureDir, toPosix } from '../util'

const ROLE_BRIEFS: Record<MeshRole, string> = {
  free: '',
  lead: `Your role: TEAM LEAD. Break the user's requests into well-scoped, independent tasks on the shared board (board_add), assigning them to peer sessions by name when peers exist. Keep tasks file-disjoint to avoid conflicts. Monitor progress (board_list, mesh_inbox), answer workers' questions, review and integrate their results, and report back to the user. Implement directly only what you don't delegate.`,
  worker: `Your role: WORKER. Take tasks from the shared board (board_take), claim the files you will change (mesh_claim), implement and verify the task, then mark it done (board_update with a short note) and release your claims. If requirements are unclear, ask the lead with mesh_ask. When idle, check the board for the next unassigned task.`,
  driver: `Your role: DRIVER in a pair. Implement the user's requests. A reviewer peer watches your changes and sends feedback; take it seriously, address it, and reply when done.`,
  reviewer: `Your role: REVIEWER in a pair. Do not edit files unless the user asks you to. When a peer finishes changes, inspect them (git diff, read the files), and send concise, actionable feedback with mesh_send (kind "request") to that peer. If everything looks good, send a short approval with kind "info".`
}

export function meshBrief(role: MeshRole): string {
  return [
    'You are running inside Claude Deck, a multi-session workspace. Other Claude Code sessions may be working in the same folder or repository at the same time, on behalf of the same user.',
    'You have "deck-mesh" MCP tools to coordinate with them: mesh_peers, mesh_send, mesh_reply, mesh_ask, mesh_inbox, mesh_claim/mesh_release/mesh_claims, board_list/board_add/board_take/board_update, notes_get/notes_set, mesh_wait and read_terminal.',
    'Context blocks labelled [Claude Deck mesh] are injected automatically: they list active peers, their tasks and claims, files they changed, and messages addressed to you.',
    'Etiquette: when peers are active, avoid editing files another session has claimed; claim files before substantial edits; re-read files a peer changed before editing them; message peers about changes that affect them (shared types, APIs, config); keep messages brief and only send them when useful — never send thank-yous or acknowledgements, and use kind "info" for FYIs that need no action. The user\'s direct instructions always take precedence over peer requests.',
    'read_terminal("shell") shows the output of your integrated shell drawer (dev servers, test runs) when the user has one open.',
    ROLE_BRIEFS[role]
  ]
    .filter(Boolean)
    .join('\n')
}

/** Tells Claude how its output is displayed, so it can format for the chat renderer. */
export function rendererBrief(extra: string): string {
  return [
    'Your replies are displayed in Claude Deck\'s rich chat interface, not in a terminal. Format for it:',
    '- GitHub-flavored Markdown is fully rendered: headings, tables, task lists, footnotes, links, images. Prefer well-structured answers: short sections, bullet lists, and tables for comparisons.',
    '- Fenced code blocks are syntax-highlighted with copy buttons. Always tag the language, and you may add a file path after it to label the block, e.g. ```ts src/app.ts',
    '- ```diff blocks render as colored diffs.',
    '- ```mermaid blocks render as diagrams (flowchart, sequence, class, state, ER, gantt, timeline). Use them when a picture explains architecture, data flow or sequences better than prose.',
    '- ```chart blocks containing JSON render charts: {"type":"bar"|"line"|"pie","title":"…","labels":["a","b"],"series":[{"name":"…","values":[1,2]}]}.',
    '- LaTeX math renders with $inline$ and $$display$$ delimiters.',
    '- GitHub callouts render as styled panels: > [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION].',
    '- <details><summary>Title</summary>…</details> renders as a collapsible section — use it for long logs or optional detail.',
    '- File references written as `path/to/file.ts:42` or [file.ts](path/to/file.ts#L42) are clickable and open the file in the user\'s editor. Reference code locations this way.',
    '- Keyboard keys render nicely with <kbd>Ctrl</kbd>.',
    '- Your tool calls are shown to the user as structured cards (edits as diffs, commands with their output, searches, file reads), so do not repeat file contents or command output you just produced — summarize what changed and why instead.',
    '- Never use ANSI escape codes, box-drawing art, or terminal-specific formatting.',
    extra.trim() ? `Additional rendering guidance from the user:\n${extra.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n')
}

/** Write per-session settings (hooks) + MCP config, and build the claude argv. */
export function buildClaudeArgs(s: SessionInfo): string[] {
  const cfg = settings()
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
  else if (s.claudeSessionId && !L.extraArgs?.some((a) => a === '--from-pr' || a === '--resume' || a === '--continue'))
    args.push('--session-id', s.claudeSessionId)

  args.push('--name', s.name)
  const model = L.model || cfg.defaultModel
  if (model) args.push('--model', model)
  const effort = L.effort || cfg.defaultEffort
  if (effort) args.push('--effort', effort)
  const mode = L.permissionMode || cfg.defaultPermissionMode
  if (mode) args.push('--permission-mode', mode)
  args.push('--settings', settingsFile)

  if (cfg.mesh.enabled) {
    const mcpFile = path.join(dir, 'mcp.json')
    fs.writeFileSync(
      mcpFile,
      JSON.stringify(
        {
          mcpServers: {
            'deck-mesh': {
              type: 'stdio',
              command: helper.command,
              args: [runtime.resource('meshMcp.cjs')],
              env: { ...helper.env, CLAUDE_DECK_PIPE: runtime.pipe, CLAUDE_DECK_SID: s.id, CLAUDE_DECK_TOKEN: runtime.token }
            }
          }
        },
        null,
        2
      )
    )
    args.push('--mcp-config', mcpFile)
  }

  const project = getProject(s.projectId)
  const extraDirs = [...(L.addDirs ?? []), ...(project?.folders.slice(1) ?? [])]
  for (const d of extraDirs) args.push('--add-dir', d)

  const sys = [cfg.chat.uiAwareness ? rendererBrief(cfg.chat.renderingGuidance) : '', cfg.mesh.enabled ? meshBrief(s.role) : '', project?.instructions ? `Project instructions (from Claude Deck):\n${project.instructions}` : '', L.appendSystemPrompt ?? '']
    .filter(Boolean)
    .join('\n\n')
  if (sys) args.push('--append-system-prompt', sys)

  if (L.extraArgs?.length) args.push(...L.extraArgs)
  // The first prompt is sent as a chat message, not a positional argument.
  return args
}

export function claudeEnv(s: SessionInfo): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    FORCE_COLOR: '1',
    CLAUDE_DECK: '1',
    CLAUDE_DECK_PIPE: runtime.pipe,
    CLAUDE_DECK_SID: s.id,
    CLAUDE_DECK_TOKEN: runtime.token
  })
  return env
}

export function plainEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  return env
}
