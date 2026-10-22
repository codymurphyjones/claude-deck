// Types shared between the main process, preload and renderer.

import type { ProviderId, ProviderSettings } from './agent'
import type { JobRunOptions } from './jobs'

export type SessionKind = 'agent' | 'shell' | 'login' | 'command'
export type SessionStatus =
  | 'starting'
  | 'waiting-auth'
  | 'working'
  | 'needs-input'
  | 'idle'
  | 'blocked'
  | 'exited'

export type MeshRole = 'free' | 'lead' | 'worker' | 'driver' | 'reviewer'

export interface LaunchOptions {
  cwd: string
  /** Agent backing the session ('agent' kind); defaults to settings.defaultProvider. */
  provider?: ProviderId
  name?: string
  model?: string
  effort?: string
  permissionMode?: string
  /** Agent session id to resume. */
  resumeId?: string
  continueLast?: boolean
  /** With resumeId: fork into a new session id. */
  fork?: boolean
  /** Create a fresh managed worktree for this session. */
  worktree?: { baseRef?: string; permanent?: boolean; carryChanges?: boolean }
  addDirs?: string[]
  appendSystemPrompt?: string
  initialPrompt?: string
  remoteControl?: boolean
  role?: MeshRole
  templateId?: string
  /** Quick chat: scratch folder, not shown under projects. */
  quick?: boolean
  /** Side chat: temporary fork shown next to its parent, discarded on close. */
  sideOf?: string
  /** Shell / command sessions */
  command?: string
  args?: string[]
  /** Parent session id for a shell drawer. */
  parentId?: string
  /** Login flow options */
  login?: { console?: boolean; sso?: boolean; email?: string }
  extraArgs?: string[]
}

export interface GoalState {
  text: string
  status: 'active' | 'paused' | 'done' | 'blocked'
  iterations: number
  maxIterations: number
  startedAt: number
  updatedAt: number
}

export interface SessionInfo {
  id: string
  kind: SessionKind
  name: string
  cwd: string
  /** Root used for git + mesh grouping (git toplevel, else cwd). */
  root: string
  provider?: ProviderId
  agentSessionId?: string
  projectId?: string
  worktreeId?: string
  status: SessionStatus
  permissionMode?: string
  model?: string
  createdAt: number
  lastActivity: number
  lastUserInput: number
  unread: boolean
  exitCode?: number
  transcriptPath?: string
  lastPrompt?: string
  lastAssistant?: string
  attention?: string
  meshGroup?: string
  meshColor?: string
  role: MeshRole
  pendingMessages: number
  goal?: GoalState
  files: string[]
  branch?: string
  hostWindow: number
  launch: LaunchOptions
  turnSnapshot?: string
  temporary?: boolean
}

export interface Project {
  id: string
  name: string
  folders: string[]
  pinned: boolean
  instructions?: string
  createdAt: number
  lastOpened: number
}

export interface ChatRecord {
  agentSessionId: string
  provider?: ProviderId
  name: string
  cwd: string
  projectId?: string
  worktreeId?: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  archived: boolean
  branch?: string
  model?: string
  lastPrompt?: string
  quick?: boolean
  hidden?: boolean
}

export interface WorktreeRecord {
  id: string
  path: string
  repoRoot: string
  projectId?: string
  baseRef: string
  branch?: string
  permanent: boolean
  createdAt: number
  lastUsed: number
  chatId?: string
  snapshot?: string
  snapshotHead?: string
  deleted?: boolean
}

export interface ThemeColors {
  bg: string
  panel: string
  panel2: string
  border: string
  text: string
  muted: string
  accent: string
  danger: string
  success: string
  warning: string
}

export interface TerminalTheme {
  background: string
  foreground: string
  cursor: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeDef {
  id: string
  name: string
  dark: boolean
  ui: ThemeColors
  terminal: TerminalTheme
  custom?: boolean
}

export interface SessionTemplate {
  id: string
  name: string
  provider?: ProviderId
  model?: string
  effort?: string
  permissionMode?: string
  appendSystemPrompt?: string
  addDirs?: string[]
  role?: MeshRole
  remoteControl?: boolean
  initialPrompt?: string
  useWorktree?: boolean
}

export interface PromptTemplate {
  id: string
  name: string
  text: string
}

export interface Settings {
  themeMode: 'dark' | 'light' | 'system'
  darkTheme: string
  lightTheme: string
  accentOverride?: string
  bgOverride?: string
  fgOverride?: string
  contrast: number
  uiFont: string
  codeFont: string
  uiFontSize: number
  codeFontSize: number
  translucentSidebar: boolean
  pointerCursors: boolean
  copyOnSelect: boolean
  scrollback: number
  notifications: {
    turnComplete: 'never' | 'background' | 'always'
    permission: boolean
    question: boolean
    sound: boolean
  }
  preventSleep: boolean
  followUp: 'steer' | 'queue'
  composerEnter: 'enter' | 'ctrlEnter'
  defaultProvider: ProviderId
  providers: Record<ProviderId, ProviderSettings>
  shell: string
  worktrees: { root: string; keep: number; autoDelete: boolean; branchPrefix: string; cleanupMerged: boolean; deleteRemoteMerged: boolean }
  mesh: {
    enabled: boolean
    claimMode: 'ask' | 'deny' | 'off'
    autoWake: boolean
    autoWakeIdleMs: number
    repoPeers: boolean
    staleReadGuard: boolean
  }
  shortcuts: Record<string, string>
  restoreSessions: 'ask' | 'always' | 'never'
  autoOpenFiles: boolean
  alwaysOnTop: boolean
  buddy: boolean
  sessionTemplates: SessionTemplate[]
  promptTemplates: PromptTemplate[]
  customThemes: ThemeDef[]
  reviewInstructions: string
  goalMaxIterations: number
  showTimeline: boolean
  chat: ChatSettings
  updates: UpdateSettings
}

export interface UpdateSettings {
  /** stable = tagged releases; latest = every master build (GitHub pre-releases). */
  channel: 'stable' | 'latest'
  auto: boolean
  /** Set after a manual downgrade: auto-update stays paused until released. */
  heldVersion?: string
  lastVersion?: string
  previousVersion?: string
}

export interface UpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'held' | 'error'
  current: string
  available?: string
  progress?: number
  error?: string
  checkedAt?: number
}

export interface ReleaseInfo {
  tag: string
  version: string
  name: string
  prerelease: boolean
  publishedAt: string
  notes: string
  url: string
  installerUrl?: string
  size?: number
}

export interface ChatSettings {
  /** Tell Claude what the chat renderer supports (markdown, diagrams, callouts…). */
  uiAwareness: boolean
  /** Extra guidance appended to the rendering brief. */
  renderingGuidance: string
  density: 'comfortable' | 'compact'
  width: 'narrow' | 'wide' | 'full'
  thinking: 'collapsed' | 'expanded' | 'hidden'
  tools: 'grouped' | 'expanded'
  fontSize: number
  sendKey: 'enter' | 'ctrlEnter'
}

export interface AuthStatus {
  provider?: ProviderId
  checked: boolean
  loggedIn: boolean
  email?: string
  authMethod?: string
  subscriptionType?: string
  orgName?: string
  error?: string
}

// ---------- Mesh ----------
export type MeshMessageKind = 'info' | 'question' | 'request' | 'handoff' | 'reply'

export interface MeshMessage {
  id: string
  from: string
  fromName: string
  to: string
  toName?: string
  kind: MeshMessageKind
  text: string
  ts: number
  readBy: string[]
  replyTo?: string
}

export interface MeshClaim {
  key: string
  path: string
  sessionId: string
  sessionName: string
  intent: string
  expires: number
  soft: boolean
}

export interface BoardItem {
  id: string
  title: string
  detail?: string
  status: 'todo' | 'doing' | 'done' | 'blocked'
  owner?: string
  ownerName?: string
  createdBy: string
  createdByName: string
  notes: { by: string; text: string; ts: number }[]
  ts: number
  updated: number
}

export interface EditRecord {
  key: string
  path: string
  sessionId: string
  sessionName: string
  tool: string
  ts: number
}

export interface MeshPeer {
  sessionId: string
  name: string
  status: SessionStatus
  role: MeshRole
  lastPrompt?: string
  branch?: string
  cwd: string
}

export interface MeshGroupState {
  key: string
  label: string
  messages: MeshMessage[]
  claims: MeshClaim[]
  board: BoardItem[]
  notes: Record<string, { value: string; by: string; ts: number }>
  edits: EditRecord[]
  peers: MeshPeer[]
}

// ---------- Timeline ----------
export interface TimelineEvent {
  id: string
  ts: number
  sessionId: string
  sessionName: string
  type: 'prompt' | 'tool' | 'edit' | 'permission' | 'stop' | 'mesh' | 'start' | 'exit'
  text: string
  group?: string
}

// ---------- Git ----------
export type DiffView = 'unstaged' | 'staged' | 'commit' | 'branch' | 'lastTurn'

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export interface DiffFile {
  oldPath: string
  newPath: string
  headerLines: string[]
  hunks: DiffHunk[]
  binary: boolean
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

export interface GitInfo {
  isRepo: boolean
  root?: string
  branch?: string
  upstream?: string
  ahead?: number
  behind?: number
  dirty?: number
  defaultBranch?: string
  hasRemote?: boolean
  ghAvailable?: boolean
}

export interface CommitInfo {
  sha: string
  short: string
  subject: string
  author: string
  date: string
  /** Branches/tags pointing at this commit. */
  refs?: string[]
}

// ---------- Environments ----------
export interface EnvAction {
  id: string
  name: string
  icon: string
  command: string
  windows?: string
  macos?: string
  linux?: string
}

export interface EnvironmentConfig {
  setup?: { default?: string; windows?: string; macos?: string; linux?: string }
  actions: EnvAction[]
}

// ---------- Automations ----------
export type AutomationSchedule =
  | { type: 'interval'; minutes: number }
  | { type: 'rrule'; rule: string }
  | { type: 'github'; repo: string; filter?: string; events: string[] }

export interface Automation {
  id: string
  name: string
  prompt: string
  kind: 'standalone' | 'inchat' | 'job'
  schedule: AutomationSchedule
  cwd: string
  /** kind 'job': which repo job (under cwd/repo_jobs) or, with `routine`, which app-level routine to run on cwd, and how. */
  job?: { slug: string; options?: Partial<JobRunOptions>; routine?: boolean }
  projectId?: string
  useWorktree: boolean
  provider?: ProviderId
  model?: string
  effort?: string
  permissionMode?: string
  targetChatId?: string
  status: 'active' | 'paused' | 'completed'
  lastRun?: number
  nextRun?: number
  pending?: boolean
  githubSeen?: string
  createdAt: number
}

export interface AutomationRun {
  id: string
  automationId: string
  automationName: string
  startedAt: number
  finishedAt?: number
  status: 'running' | 'success' | 'error'
  output: string
  unread: boolean
  archived: boolean
  pinned: boolean
  worktreePath?: string
  costUsd?: number
  provider?: ProviderId
  agentSessionId?: string
  cwd: string
}

// ---------- Transcripts / history ----------
export interface TranscriptSummary {
  agentSessionId: string
  provider: ProviderId
  cwd: string
  title: string
  firstTs: number
  lastTs: number
  branch?: string
  messages: number
  inputTokens: number
  outputTokens: number
  path: string
}

export interface Insights {
  lifetimeTokens: number
  peakDayTokens: number
  peakDay?: string
  currentStreak: number
  longestStreak: number
  longestSessionMs: number
  sessions: number
  byDay: { day: string; tokens: number }[]
}

// ---------- GitHub ----------
export interface PullRequestSummary {
  number: number
  title: string
  author: string
  url: string
  updatedAt: string
  reviewDecision?: string
  isDraft: boolean
  headRefName: string
  repo: string
}

export interface PullRequestDetail extends PullRequestSummary {
  body: string
  baseRefName: string
  comments: { author: string; body: string; createdAt: string }[]
  reviews: { author: string; state: string; body: string }[]
  checks: { name: string; status: string; conclusion: string; url?: string }[]
  files: { path: string; additions: number; deletions: number }[]
  diff: string
}

// ---------- App state snapshot ----------
export interface OpenTabState {
  sessions: { agentSessionId?: string; provider?: ProviderId; cwd: string; name: string; role?: MeshRole }[]
}

export interface ToastMessage {
  id: string
  kind: 'info' | 'error' | 'success'
  text: string
}
