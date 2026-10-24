import type { MeshRole, SessionInfo } from '@shared/types'
import { settings } from '../context'
import { getProject } from '../library'
import { getWorktree } from '../worktrees/worktreeService'
import { pushBlockEnv } from '../git/pushGuard'
import { helperRuntime, runtime } from '../runtime'

const ROLE_BRIEFS: Record<MeshRole, string> = {
  free: '',
  lead: `Your role: TEAM LEAD. Break the user's requests into well-scoped, independent tasks on the shared board (board_add), assigning them to peer sessions by name when peers exist. Keep tasks file-disjoint to avoid conflicts. Monitor progress (board_list, mesh_inbox), answer workers' questions, review and integrate their results, and report back to the user. Implement directly only what you don't delegate.`,
  worker: `Your role: WORKER. Take tasks from the shared board (board_take), claim the files you will change (mesh_claim), implement and verify the task, then mark it done (board_update with a short note) and release your claims. If requirements are unclear, ask the lead with mesh_ask. When idle, check the board for the next unassigned task.`,
  driver: `Your role: DRIVER in a pair. Implement the user's requests. A reviewer peer watches your changes and sends feedback; take it seriously, address it, and reply when done.`,
  reviewer: `Your role: REVIEWER in a pair. Do not edit files unless the user asks you to. When a peer finishes changes, inspect them (git diff, read the files), and send concise, actionable feedback with mesh_send (kind "request") to that peer. If everything looks good, send a short approval with kind "info".`
}

export function meshBrief(role: MeshRole): string {
  return [
    'You are running inside Claude Deck, a multi-session workspace. Other coding-agent sessions (Claude Code or Codex) may be working in the same folder or repository at the same time, on behalf of the same user.',
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

/** The deck-mesh MCP server for a session (stdio). */
export function meshServer(s: SessionInfo): { command: string; args: string[]; env: Record<string, string> } {
  const helper = helperRuntime()
  return {
    command: helper.command,
    args: [runtime.resource('meshMcp.cjs')],
    env: { ...helper.env, CLAUDE_DECK_PIPE: runtime.pipe, CLAUDE_DECK_SID: s.id, CLAUDE_DECK_TOKEN: runtime.token }
  }
}

/** Instructions appended to the agent's system prompt: renderer brief, mesh, project, template. */
export function sessionBrief(s: SessionInfo): string {
  const cfg = settings()
  const project = getProject(s.projectId)
  return [
    cfg.chat.uiAwareness ? rendererBrief(cfg.chat.renderingGuidance) : '',
    cfg.mesh.enabled ? meshBrief(s.role) : '',
    project?.instructions ? `Project instructions (from Claude Deck):\n${project.instructions}` : '',
    worktreeBrief(s),
    s.launch.appendSystemPrompt ?? ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * A chat in its own worktree, working toward a branch: where it is, and that committing and bringing
 * the work into the target are the user's steps (Review pane, "Merge into"): the agent leaves its
 * changes uncommitted, and doesn't merge, switch branches or push.
 */
function worktreeBrief(s: SessionInfo): string {
  const w = s.worktreeId ? getWorktree(s.worktreeId) : undefined
  if (!w?.branch || !w.target) return ''
  return [
    `You are working in your own git worktree (${w.path}) on branch ${w.branch}, made from ${w.target}. The user's own folder and other chats are separate, so your edits don't disturb them.`,
    `Leave your changes uncommitted in the working tree and tell the user when they're ready: the user reviews, commits and merges them into ${w.target} with Claude Deck (Review pane, "Merge into ${w.target}"). Don't commit unless the user asks you to, don't switch branches, and don't merge into ${w.target} yourself.`,
    `Never push and never open a pull request: not ${w.branch} (it stays on this machine) and not ${w.target} (it's pushed from its own folder). \`git push\` and \`gh pr create\` are blocked here.`,
    'If asked to resolve conflicts from merging the target into your branch, resolve them here and `git add` the files, then tell the user: they finish the merge commit themselves.'
  ].join(' ')
}

/** Extra folders the agent may access (launch dirs + the project's other folders). */
export function sessionDirs(s: SessionInfo): string[] {
  const project = getProject(s.projectId)
  return [...(s.launch.addDirs ?? []), ...(project?.folders.slice(1) ?? [])]
}

/** Environment for an agent process: inherited, minus Electron flags, plus the deck pipe. */
export function agentEnv(s: SessionInfo): Record<string, string> {
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
  // In a chat's worktree, git can't push (any agent, any shell it opens): git/pushGuard.ts.
  Object.assign(env, pushBlockEnv(s.cwd, env))
  return env
}

/** Environment for other processes (terminals, scripts, headless runs); `cwd` where they start. */
export function plainEnv(cwd?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  Object.assign(env, pushBlockEnv(cwd, env))
  return env
}
