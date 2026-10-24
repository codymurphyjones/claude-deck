// The deck-mesh MCP tools, in one place: which exist, which act on the Claude Deck app, and which
// may run without asking. Schemas live in resources/meshMcp.cjs (a standalone script); a test keeps
// its tool names in step with these lists.

/** Peer coordination: they only read or write mesh state, so they run without asking. */
export const MESH_TOOLS = [
  'mesh_peers',
  'mesh_send',
  'mesh_reply',
  'mesh_ask',
  'mesh_inbox',
  'mesh_claim',
  'mesh_release',
  'mesh_claims',
  'board_list',
  'board_add',
  'board_take',
  'board_update',
  'notes_set',
  'notes_get',
  'mesh_wait',
  'read_terminal'
] as const

/**
 * Tools that act on the app itself, by tier. `auto`: shows or fills in UI, nothing runs. `confirm`:
 * starts processes or loads pages the agent then reads, so the user approves each use (Claude's own
 * permission prompt; an in-app dialog for providers without one).
 */
export const APP_TOOL_TIERS = {
  open_file: 'auto',
  show_diff: 'auto',
  request_review: 'auto',
  read_process: 'auto',
  notify: 'auto',
  run_routine: 'auto', // only opens the run dialog; the user starts it
  run_process: 'confirm',
  open_browser: 'confirm'
} as const satisfies Record<string, 'auto' | 'confirm'>

export type AppToolName = keyof typeof APP_TOOL_TIERS
export const APP_TOOLS: ReadonlySet<string> = new Set(Object.keys(APP_TOOL_TIERS))
export const isAppTool = (t: string): t is AppToolName => APP_TOOLS.has(t)

export type ToolTier = 'auto' | 'confirm'
type TierOverrides = Partial<Record<string, ToolTier>> | undefined

/** A tool's tier after the user's overrides (Settings → AI permissions). */
export const appToolTier = (tool: AppToolName, overrides?: TierOverrides): ToolTier => overrides?.[tool] ?? APP_TOOL_TIERS[tool]

/** Tool names (unprefixed) that a provider may run without a prompt. */
export const autoAllowedTools = (overrides?: TierOverrides): string[] => [...MESH_TOOLS, ...(Object.keys(APP_TOOL_TIERS) as AppToolName[]).filter((n) => appToolTier(n, overrides) === 'auto')]

/** App tools that must ask each time. */
export const confirmTools = (overrides?: TierOverrides): AppToolName[] => (Object.keys(APP_TOOL_TIERS) as AppToolName[]).filter((n) => appToolTier(n, overrides) === 'confirm')

/** With the default tiers. */
export const AUTO_ALLOWED_TOOLS: readonly string[] = autoAllowedTools()

/** What each app tool does, for the settings page. */
export const APP_TOOL_INFO: Record<AppToolName, string> = {
  open_file: 'Open a file in the editor tab',
  show_diff: 'Show changes in the Review pane',
  request_review: 'Pin notes to lines in the Review pane',
  read_process: "Read a script run's output",
  notify: 'Send you a desktop notification',
  run_routine: 'Open a routine’s run dialog (you start it)',
  run_process: 'Start or restart a package.json script',
  open_browser: 'Load a page in the browser pane and read it'
}

/**
 * Claude permission rules that always prompt, even in auto mode (where the classifier otherwise
 * approves silently): actions that publish, rewrite history or delete a lot. Users can edit the list.
 */
export const RECOMMENDED_ALWAYS_ASK: readonly string[] = [
  'Bash(git push *)',
  'Bash(git push)',
  'Bash(git reset --hard *)',
  'Bash(git clean *)',
  'Bash(git branch -D *)',
  'Bash(git rebase *)',
  'Bash(rm -rf *)',
  'Bash(npm publish *)',
  'PowerShell(Remove-Item *)'
]

/**
 * Rules as Claude gets them: a shell rule covers both shells. On Windows Claude runs commands with
 * either its Bash or its PowerShell tool, and a Bash(...) rule doesn't match a PowerShell call.
 */
export function expandShellRules(rules: readonly string[]): string[] {
  const out: string[] = []
  for (const r of rules.map((x) => x.trim()).filter(Boolean)) {
    out.push(r)
    const m = /^(Bash|PowerShell)\((.*)\)$/.exec(r)
    if (m) out.push(`${m[1] === 'Bash' ? 'PowerShell' : 'Bash'}(${m[2]})`)
  }
  return [...new Set(out)]
}

/** Diff views an agent can point the Review pane at. */
export const AGENT_DIFF_VIEWS = ['unstaged', 'staged', 'lastTurn', 'branch'] as const
export type AgentDiffView = (typeof AGENT_DIFF_VIEWS)[number]
export const isAgentDiffView = (v: string): v is AgentDiffView => (AGENT_DIFF_VIEWS as readonly string[]).includes(v)

/**
 * What the browser pane loads for typed input: a scheme-less host becomes http (local) or https.
 * The pane's own address bar uses the same rule.
 */
export function browserUrl(input: string): string {
  const u = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u
  return /^(localhost|\d+\.\d+|\[)/i.test(u) ? `http://${u}` : `https://${u}`
}

/** An agent may only open web pages: no file:, javascript:, data: or app-internal schemes. */
export function agentBrowserUrl(input: string): { url: string } | { error: string } {
  const full = browserUrl(input)
  let parsed: URL
  try {
    parsed = new URL(full)
  } catch {
    return { error: `"${input}" isn't a valid URL.` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { error: `Only http(s) pages can be opened, not ${parsed.protocol} URLs.` }
  return { url: parsed.href }
}
