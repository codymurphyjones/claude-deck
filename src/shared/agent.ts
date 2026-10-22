// Provider-agnostic agent model: every coding agent (Claude Code, Codex) is described and
// normalized into these shapes so the rest of the app never depends on one CLI's formats.

export type ProviderId = 'claude' | 'codex'

export const PROVIDER_IDS: ProviderId[] = ['claude', 'codex']

export interface ProviderCaps {
  /** Tool approvals can be answered live from the chat. */
  liveApprovals: boolean
  /** Model can be switched mid-session. */
  setModelLive: boolean
  /** A session can be forked into a new id. */
  fork: boolean
  images: boolean
  /** Turn results report a dollar cost. */
  costUsd: boolean
  /** `--cloud` style remote tasks. */
  cloud: boolean
  /** The CLI exposes slash commands. */
  slashCommands: boolean
  /** Start a session from a GitHub PR (`--from-pr`). */
  fromPr: boolean
}

export interface ProviderDescriptor {
  id: ProviderId
  label: string
  /** [value, label]; '' = the CLI's default. */
  models: [string, string][]
  efforts: string[]
  permissionModes: [string, string][]
  /** Permission modes cycled by the "cycle mode" command. */
  modeCycle: string[]
  /** Cheap model for commit messages and drafting. */
  fastModel: string
  /** Project/global instructions file name. */
  instructionsFile: string
  caps: ProviderCaps
}

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    models: [
      ['', 'Default'],
      ['fable', 'Fable (most capable)'],
      ['opus', 'Opus'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku (fastest)']
    ],
    efforts: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
    permissionModes: [
      ['', 'Default'],
      ['plan', 'Plan (read-only until approved)'],
      ['acceptEdits', 'Accept edits'],
      ['auto', 'Auto'],
      ['manual', 'Ask for everything'],
      ['bypassPermissions', 'Bypass permissions (full access)']
    ],
    modeCycle: ['default', 'acceptEdits', 'plan'],
    fastModel: 'haiku',
    instructionsFile: 'CLAUDE.md',
    caps: { liveApprovals: true, setModelLive: true, fork: true, images: true, costUsd: true, cloud: true, slashCommands: true, fromPr: true }
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    models: [
      ['', 'Default'],
      ['gpt-5-codex', 'GPT-5 Codex'],
      ['gpt-5', 'GPT-5'],
      ['gpt-5-codex-mini', 'GPT-5 Codex mini (fastest)']
    ],
    efforts: ['', 'minimal', 'low', 'medium', 'high'],
    permissionModes: [
      ['', 'Default'],
      ['plan', 'Read-only'],
      ['acceptEdits', 'Auto (edit workspace, ask outside it)'],
      ['manual', 'Ask for everything'],
      ['bypassPermissions', 'Full access (no sandbox)']
    ],
    modeCycle: ['default', 'acceptEdits', 'plan'],
    fastModel: 'gpt-5-codex-mini',
    instructionsFile: 'AGENTS.md',
    caps: { liveApprovals: true, setModelLive: true, fork: false, images: true, costUsd: false, cloud: false, slashCommands: false, fromPr: false }
  }
}

export const providerOf = (p: ProviderId | undefined): ProviderDescriptor => PROVIDERS[p ?? 'claude'] ?? PROVIDERS.claude

/** Per-provider user settings. */
export interface ProviderSettings {
  /** Executable override ('' = auto-detect). */
  path: string
  defaultModel: string
  defaultEffort: string
  defaultPermissionMode: string
}

/** Normalized tool category, so cards render the same whatever the agent called the tool. */
export type ToolKind = 'read' | 'write' | 'edit' | 'shell' | 'search' | 'web' | 'task' | 'question' | 'plan' | 'todo' | 'mcp' | 'other'

export interface TokenUsage {
  /** Tokens in the latest request's context window. */
  context: number
  output: number
}

/**
 * Normalized session lifecycle. Claude emits these from its hooks; Codex from its app-server
 * event stream. Status, goals, timeline, review snapshots and mesh all run off these.
 */
export type AgentEvent =
  | { type: 'session-start'; sessionId?: string; transcriptPath?: string }
  | { type: 'turn-start'; prompt: string; sessionId?: string; transcriptPath?: string; permissionMode?: string }
  | { type: 'tool-start'; toolKind: ToolKind; name: string; input: Record<string, unknown>; sessionId?: string; transcriptPath?: string }
  | { type: 'tool-end'; toolKind: ToolKind; name: string; input: Record<string, unknown>; sessionId?: string; transcriptPath?: string }
  | { type: 'needs-input'; reason: 'permission' | 'idle' | 'other'; message?: string; sessionId?: string; transcriptPath?: string }
  | {
      type: 'turn-end'
      lastAssistantMessage?: string
      /** This stop already follows a forced continuation (don't force another for the same reason). */
      continued?: boolean
      sessionId?: string
      transcriptPath?: string
      permissionMode?: string
    }
  | { type: 'session-end' }

const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  PowerShell: 'shell',
  BashOutput: 'shell',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  WebFetch: 'web',
  WebSearch: 'web',
  Task: 'task',
  Agent: 'task',
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
  TodoWrite: 'todo'
}

/** Map a tool name (either provider's vocabulary) to its normalized kind. */
export function toolKindOf(name: string): ToolKind {
  if (CLAUDE_TOOL_KINDS[name]) return CLAUDE_TOOL_KINDS[name]
  if (name.startsWith('mcp__')) return 'mcp'
  return 'other'
}
