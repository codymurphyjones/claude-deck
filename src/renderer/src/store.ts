import { providerOf, type ProviderId } from '@shared/agent'
import { create } from 'zustand'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type {
  AuthStatus,
  Automation,
  AutomationRun,
  LaunchOptions,
  MeshGroupState,
  OpenTabState,
  SessionKind,
  Settings,
  TimelineEvent,
  ToastMessage,
  UpdateState
} from '@shared/types'
import type { JobDef, JobRun, JobSource } from '@shared/jobs'
import type { ProgressEvent } from '@shared/types'
import { etaKey, runningLabel } from '@shared/progress'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'
import type { ToolSet } from '@shared/actions'
import { api, errMsg, type Library, type LiveSession } from './api'

/**
 * A sub-tab inside a workspace (a project, or Quick chats): a chat (one or more split panes), the
 * project's Overview, or its editor. The title bar shows one tab per workspace; each workspace has
 * its own strip of these.
 */
export interface Tab {
  id: string
  /** The workspace it belongs to: a project id, or QUICK for chats outside any project. */
  group: string
  sessionIds: string[]
  activePane: string
  /** The project's Overview (sessionIds empty, activePane ''). Always first in its workspace. */
  projectId?: string
  /** A script run's terminal (Actions), by process id (sessionIds empty, activePane ''). */
  processId?: string
  /** The workspace's code editor (sessionIds empty, activePane ''); at most one per workspace. */
  editor?: boolean
  /** The editor's folder (explorer, search, quick open). */
  root?: string
}

/** The workspace for chats that aren't in any project. */
export const QUICK = 'quick'
/** `activeGroup` when the Home page (all projects) is showing. */
export const HOME = 'home'

export type SidebarView = 'projects' | 'activity' | 'repo' | 'actions' | 'jobs' | 'routines' | 'scheduled' | 'team' | 'reviews'
export type RightPanel = 'review' | 'files' | 'team' | 'browser' | 'timeline' | null

/** What the Repo manager's diff viewer shows. `path` focuses one file. */
export type RepoDiffSource = { cwd: string; title: string; path?: string } & (
  | { kind: 'working'; view: 'staged' | 'unstaged' }
  | { kind: 'commit'; ref: string }
  | { kind: 'stash'; index: number }
  | { kind: 'compare'; base: string }
)

export interface NewSessionPrefill {
  cwd?: string
  worktree?: boolean
  templateId?: string
  quick?: boolean
}

export interface UiState {
  ready: boolean
  windowId: number
  popoutSessionId?: string
  platform: string
  homedir: string
  version: string
  agentPaths: Record<ProviderId, string>
  settings: Settings
  systemDark: boolean
  auths: Record<ProviderId, AuthStatus>
  sessions: Record<string, LiveSession>
  /** Every workspace's sub-tabs, in display order within each workspace. */
  tabs: Tab[]
  /** The showing sub-tab of the active workspace (undefined on Home). */
  activeTabId?: string
  /** Open workspaces, in title-bar order: project ids and/or QUICK. */
  groups: string[]
  /** The workspace showing: one of `groups`, or HOME. */
  activeGroup: string
  /** Each workspace's last active sub-tab, restored when switching back to it. */
  groupActive: Record<string, string>
  library: Library
  automations: { automations: Automation[]; runs: AutomationRun[] }
  jobRuns: JobRun[]
  /** Job definitions per repo root (loaded on demand from <root>/repo_jobs). */
  jobDefs: Record<string, JobDef[]>
  jobsRoot?: string
  /** Repository shown in the Repo manager view. */
  repoRoot?: string
  /** The latest request to show a file in a workspace's editor (each editor takes its own workspace's). */
  editorRequest?: { group: string; path?: string; line?: number; diff?: boolean; at: number }
  /** Wide diff viewer opened from the Repo manager. */
  repoDiff: false | RepoDiffSource
  /** App-level routines (loaded on demand from ~/.claude-deck/routines). */
  routineDefs?: JobDef[]
  /** Background processes owned by projects. */
  processes: ProcessInfo[]
  /** package.json scripts per project id (scanned on demand). */
  scripts: Record<string, ScriptPackage[]>
  /** Per project: its .mono and package-manager command folders (shared/actions.ts). */
  tools: Record<string, ToolSet[]>
  /** The action whose run form is open. */
  actionRun?: { projectId: string; toolset: string; actionId: string }
  /** Project whose Actions section should open (from the command palette). */
  actionsFocus?: string
  mesh: Record<string, MeshGroupState>
  timeline: TimelineEvent[]
  toasts: ToastMessage[]
  /** Long operations in progress (worktrees being made…), shown as toasts with an ETA ring. */
  progress: ProgressEvent[]
  savedTabs: OpenTabState[]
  pinnedReviews: string[]
  closedStack: { cwd: string; provider?: ProviderId; agentSessionId?: string; name: string }[]
  // layout
  sidebarOpen: boolean
  sidebarView: SidebarView
  rightPanel: RightPanel
  rightWidth: number
  sidebarWidth: number
  shellOpen: Record<string, boolean>
  // modals
  palette: false | 'all' | 'chats' | 'files'
  settingsOpen: false | string
  /** A setting to focus and highlight when Settings opens (e.g. 'commitPrefix'). */
  settingsFocus?: string
  newSession: false | NewSessionPrefill
  composerFor?: string
  composerPrefill?: string
  goalFor?: string
  fleetOpen: false | { cwd?: string }
  broadcastOpen: boolean
  automationEdit: false | Partial<Automation>
  /** Job designer: `slug` edits an existing job, `draft` opens an unsaved one. */
  jobEdit: false | { root: string; slug?: string; draft?: JobDef }
  jobRunFor: false | { root: string; slug: string; step?: number }
  /** Routine designer: same as jobEdit, without a repo. */
  routineEdit: false | { slug?: string; draft?: JobDef }
  /** A routine or job list item to highlight briefly (e.g. after pasting a job card). */
  flash?: { kind: JobSource; slug: string }
  /**
   * Run dialog for a routine; `cwd` pre-selects the target repo, `context` pre-fills the run's
   * extra instructions (e.g. from an agent's run_routine).
   */
  routineRunFor: false | { slug?: string; cwd?: string; step?: number; context?: string }
  /** An agent asked the Review pane to show a view and/or file (show_diff, request_review). */
  reviewFocus?: { sessionId: string; view?: string; path?: string; at: number }
  /** Notes an agent pinned to lines of its diff (request_review), per session. */
  agentNotes: Record<string, AgentReview>
  /**
   * Chat merges waiting to update a folder that has uncommitted changes (the user chose "hold and
   * ask"): shown as a banner with Update now / Later.
   */
  /** `push`: the merge was asked to push the target too. */
  heldMerges: { worktreeId: string; target: string; checkout: string; files: string[]; chat: string }[]
  prompt?: { title: string; value: string; placeholder?: string; multiline?: boolean; secret?: boolean; resolve: (v: string | null) => void }
  fileToOpen?: { path: string; sessionId?: string }
  updateState?: UpdateState
  teamKey?: string
  browserUrl?: string
}

export interface AgentNote {
  /** Repo-relative, forward slashes. */
  path: string
  line: number
  text: string
}

export interface AgentReview {
  notes: AgentNote[]
  summary?: string
  at: number
}

export const useStore = create<UiState>(() => ({
  ready: false,
  windowId: 0,
  platform: 'win32',
  homedir: '',
  version: '',
  agentPaths: { claude: '', codex: '' },
  settings: DEFAULT_SETTINGS,
  systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  auths: { claude: { provider: 'claude', checked: false, loggedIn: false }, codex: { provider: 'codex', checked: false, loggedIn: false } },
  sessions: {},
  tabs: [],
  groups: [],
  activeGroup: HOME,
  groupActive: {},
  library: { projects: [], chats: [], worktrees: [], recentFolders: [] },
  automations: { automations: [], runs: [] },
  jobRuns: [],
  jobDefs: {},
  processes: [],
  scripts: {},
  tools: {},
  mesh: {},
  timeline: [],
  toasts: [],
  progress: [],
  savedTabs: [],
  pinnedReviews: [],
  closedStack: [],
  sidebarOpen: true,
  sidebarView: 'projects',
  rightPanel: null,
  rightWidth: 460,
  sidebarWidth: 268,
  shellOpen: {},
  palette: false,
  settingsOpen: false,
  newSession: false,
  fleetOpen: false,
  broadcastOpen: false,
  automationEdit: false,
  jobEdit: false,
  jobRunFor: false,
  routineEdit: false,
  routineRunFor: false,
  repoDiff: false,
  agentNotes: {},
  heldMerges: []
}))

export const get = useStore.getState
export const set = useStore.setState

const tabId = (): string => 't' + Math.random().toString(36).slice(2, 9)

// ------------------------------------------------------------------ toasts
export function toast(text: string, kind: ToastMessage['kind'] = 'info'): void {
  // A success is a finished action: shown like one (full ring, then a check) for a consistent look.
  if (kind === 'success') {
    const id = 's' + Math.random().toString(36).slice(2, 9)
    set((s) => ({ progress: [...s.progress, { id, label: text, startedAt: Date.now(), expectedMs: 1, state: 'running' as const }] }))
    return finishProgress(id, { label: text })
  }
  const t: ToastMessage = { id: Math.random().toString(36).slice(2), kind, text }
  set((s) => ({ toasts: [...s.toasts, t].slice(-5) }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === 'error' ? 7000 : 3800)
}

/** How long a finished action's toast stays (full ring, then a check) before it goes. */
const LINGER_MS = 2600
const ETA_KEY = 'deck.actionEta'

/** Expected duration of an action, learned from its recent runs (in this browser profile). */
function actionEta(key: string): number {
  try {
    const runs: number[] = JSON.parse(localStorage.getItem(ETA_KEY) ?? '{}')[key] ?? []
    const sorted = [...runs].sort((a, b) => a - b)
    return sorted.length ? Math.max(200, sorted[Math.floor(sorted.length / 2)]) : 1500
  } catch {
    return 1500
  }
}
function recordEta(key: string, ms: number): void {
  try {
    const all: Record<string, number[]> = JSON.parse(localStorage.getItem(ETA_KEY) ?? '{}')
    all[key] = [...(all[key] ?? []), ms].slice(-5)
    // Bounded: only the most recently used kinds of action are kept.
    const keys = Object.keys(all)
    if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete all[k]
    localStorage.setItem(ETA_KEY, JSON.stringify(all))
  } catch {
    /* storage full or unavailable: ETAs just aren't learned */
  }
}

/** Show a progress toast's end: the full ring, then a check, lingering a moment before it goes. */
export function finishProgress(id: string, patch: Partial<ProgressEvent> = {}): void {
  set((s) => ({ progress: s.progress.map((p) => (p.id === id ? { ...p, ...patch, state: patch.state ?? 'done', doneAt: Date.now() } : p)) }))
  setTimeout(() => set((s) => ({ progress: s.progress.filter((p) => p.id !== id) })), patch.state === 'error' ? 4000 : LINGER_MS)
}

/**
 * Run a user action. With `okText` (what it says when done) it's shown as it runs: a toast with a
 * ring filling toward its ETA (learned per kind of action), which completes and lingers with
 * `okText` on success. Failures are toasted as errors either way.
 */
export interface ActionToast {
  /** Finished: the ring completes, then `text` lingers with a check. */
  done(text: string): void
  /** Ended without a success to show (failed, cancelled, nothing to do): the toast just goes. */
  drop(): void
}

/**
 * Show an action as it runs: a toast with `label` and a ring filling toward its ETA, learned from
 * earlier runs of the same `key` (kind of action).
 */
export function startAction(label: string, key = etaKey(label)): ActionToast {
  const id = 'a' + Math.random().toString(36).slice(2, 9)
  const startedAt = Date.now()
  set((s) => ({ progress: [...s.progress, { id, label, startedAt, expectedMs: actionEta(key), state: 'running' as const }] }))
  let ended = false
  return {
    done: (text) => {
      if (ended) return
      ended = true
      recordEta(key, Date.now() - startedAt)
      finishProgress(id, { label: text })
    },
    drop: () => {
      if (ended) return
      ended = true
      set((s) => ({ progress: s.progress.filter((p) => p.id !== id) }))
    }
  }
}

/**
 * Run a user action. With `okText` (what it says when done) it's shown as it runs (startAction):
 * "Pushed main" reads "Pushing main…" with its ring, then completes and lingers as "Pushed main".
 * Failures are toasted as errors either way.
 */
export async function attempt<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  const a = okText ? startAction(runningLabel(okText), etaKey(okText)) : undefined
  try {
    const r = await fn()
    if (okText) a?.done(okText)
    return r
  } catch (e) {
    a?.drop()
    toast(errMsg(e), 'error')
    return undefined
  }
}

// ------------------------------------------------------------------ prompts
/** Ask for a line of text. `secret`: a password field (keys, tokens), never shown or autocompleted. */
export function askText(title: string, value = '', opts: { placeholder?: string; multiline?: boolean; secret?: boolean } = {}): Promise<string | null> {
  return new Promise((resolve) => set({ prompt: { title, value, ...opts, resolve } }))
}

// ------------------------------------------------------------------ tabs
export function activeTab(): Tab | undefined {
  const s = get()
  return s.tabs.find((t) => t.id === s.activeTabId)
}

export function activeSessionId(): string | undefined {
  return activeTab()?.activePane
}

export function activeSession(): LiveSession | undefined {
  const id = activeSessionId()
  return id ? get().sessions[id] : undefined
}

/**
 * The project folder the user is working in: the focused chat's repo (a terminal pane counts as
 * its chat's), else the repo open in the Repository / Jobs sidebar view.
 */
export function currentProjectRoot(): string | undefined {
  const s = get()
  const fromTab = tabProjectRoot(s)
  if (fromTab) return fromTab
  if (s.sidebarOpen && s.sidebarView === 'repo' && s.repoRoot) return s.repoRoot
  if (s.sidebarOpen && s.sidebarView === 'jobs' && s.jobsRoot) return s.jobsRoot
  return activeSession()?.root
}

/** The project being worked in: the focused project home tab, else the focused chat's project. */
export function currentProjectId(): string | undefined {
  const s = get()
  // The active workspace is the project (Quick chats and Home aren't one).
  if (s.activeGroup !== HOME && s.activeGroup !== QUICK && s.library.projects.some((p) => p.id === s.activeGroup)) return s.activeGroup
  const a = activeSession()
  if (a?.projectId) return a.projectId
  const root = currentProjectRoot()?.toLowerCase()
  return root ? s.library.projects.find((p) => p.folders.some((f) => f.toLowerCase() === root))?.id : undefined
}

/**
 * The repo the focused sub-tab is about: its chat's (a terminal pane counts as its chat's), the
 * Overview's project, or the editor's folder; on a workspace with nothing focused, the project's.
 * A pure selector, so views can follow tab switches with `useStore(tabProjectRoot)`.
 */
export function tabProjectRoot(s: UiState): string | undefined {
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  const projectFolder = (id?: string): string | undefined => s.library.projects.find((p) => p.id === id)?.folders[0]
  if (!tab) return s.activeGroup !== HOME && s.activeGroup !== QUICK ? projectFolder(s.activeGroup) : undefined
  // The Overview stands for its project, so Repository, Pull requests, Routines… work without a chat.
  if (tab.projectId) return projectFolder(tab.projectId)
  if (tab.editor) return tab.root
  const a = s.sessions[tab.activePane]
  const owner = a?.kind === 'shell' && a.launch.parentId ? s.sessions[a.launch.parentId] : a
  return owner?.kind === 'agent' ? owner.root || owner.cwd || undefined : undefined
}

function persistTabs(): void {
  const s = get()
  if (s.popoutSessionId) return
  // Overviews and editors hold no sessions; they're reopened on demand, not restored.
  void api.session.saveTabs(s.tabs.filter((t) => t.sessionIds.length).map((t) => ({ sessionIds: t.sessionIds })))
}

const sameFolder = (a: string, b: string): boolean => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** The workspace a session belongs to: its project, else the project holding its folder, else Quick chats. */
export function groupOf(s: Pick<UiState, 'library'>, session: Pick<LiveSession, 'projectId' | 'root' | 'cwd'> | undefined): string {
  if (!session) return QUICK
  const projects = s.library.projects
  if (session.projectId && projects.some((p) => p.id === session.projectId)) return session.projectId
  const dir = session.root || session.cwd
  return (dir && projects.find((p) => p.folders.some((f) => sameFolder(f, dir)))?.id) || QUICK
}

/**
 * State with workspace `g` open (a new one goes last, so project tabs keep a stable order) and, for
 * a project, its Overview sub-tab present (first in the workspace).
 */
function withGroup(s: UiState, g: string): Pick<UiState, 'groups' | 'tabs'> {
  const groups = s.groups.includes(g) ? s.groups : [...s.groups, g]
  let tabs = s.tabs
  if (g !== QUICK && !tabs.some((t) => t.group === g && t.projectId)) {
    const first = tabs.findIndex((t) => t.group === g)
    tabs = [...tabs]
    tabs.splice(first < 0 ? tabs.length : first, 0, { id: tabId(), group: g, sessionIds: [], activePane: '', projectId: g })
  }
  return { groups, tabs }
}

/** Insert `t` into its workspace after `after` (a tab id in that workspace), else at the workspace's end. */
function insertTab(tabs: Tab[], t: Tab, after?: string): Tab[] {
  const out = [...tabs]
  const a = after ? out.findIndex((x) => x.id === after && x.group === t.group) : -1
  if (a >= 0) {
    out.splice(a + 1, 0, t)
    return out
  }
  let last = -1
  out.forEach((x, i) => x.group === t.group && (last = i))
  out.splice(last < 0 ? out.length : last + 1, 0, t)
  return out
}

/** Focus a sub-tab (and its workspace), optionally a pane within it. */
export function focusTab(id: string, pane?: string): void {
  set((s) => {
    const t = s.tabs.find((x) => x.id === id)
    if (!t) return {}
    return {
      activeTabId: id,
      activeGroup: t.group,
      groupActive: { ...s.groupActive, [t.group]: id },
      tabs: pane ? s.tabs.map((x) => (x.id === id ? { ...x, activePane: pane } : x)) : s.tabs
    }
  })
}

export function focusSessionTab(sessionId: string): void {
  const t = get().tabs.find((x) => x.sessionIds.includes(sessionId))
  if (t) focusTab(t.id, sessionId)
}

/** Show a workspace (opening it if needed), at the sub-tab it was last on. */
export function openGroup(g: string): void {
  if (g === HOME) return goHome()
  set((s) => {
    const next = withGroup(s, g)
    const mine = next.tabs.filter((t) => t.group === g)
    const id = mine.find((t) => t.id === s.groupActive[g])?.id ?? mine[0]?.id
    return { ...next, activeGroup: g, activeTabId: id, groupActive: id ? { ...s.groupActive, [g]: id } : s.groupActive }
  })
}

export function goHome(): void {
  set({ activeGroup: HOME, activeTabId: undefined })
}

/** After `gone` closes, the workspace to show: the next one in the title bar, else Home. */
function neighborGroup(groups: string[], gone: string): string {
  const i = groups.indexOf(gone)
  const rest = groups.filter((g) => g !== gone)
  return rest[Math.min(Math.max(0, i), rest.length - 1)] ?? HOME
}

/** Within a workspace, which sub-tab to show after the active one (`gone`) closes. */
function neighborTab(tabs: Tab[], before: Tab[], gone: string | undefined, g: string): string | undefined {
  const old = before.filter((t) => t.group === g)
  const mine = tabs.filter((t) => t.group === g)
  const i = old.findIndex((t) => t.id === gone)
  return mine[Math.min(Math.max(0, i - 1), mine.length - 1)]?.id
}

export function addSessionToTabs(sessionId: string, mode: 'tab' | 'split' = 'tab', splitOf?: string): void {
  set((s) => {
    if (s.tabs.some((t) => t.sessionIds.includes(sessionId))) return {}
    const g = groupOf(s, s.sessions[sessionId])
    const base = withGroup(s, g)
    if (mode === 'split') {
      const target = base.tabs.find((t) => (splitOf ? t.sessionIds.includes(splitOf) : t.id === s.activeTabId))
      if (target && target.group === g && target.sessionIds.length && target.sessionIds.length < 4) {
        return {
          ...base,
          tabs: base.tabs.map((t) => (t.id === target.id ? { ...t, sessionIds: [...t.sessionIds, sessionId], activePane: sessionId } : t)),
          activeTabId: target.id,
          activeGroup: g,
          groupActive: { ...s.groupActive, [g]: target.id }
        }
      }
    }
    const t: Tab = { id: tabId(), group: g, sessionIds: [sessionId], activePane: sessionId }
    return { ...base, tabs: insertTab(base.tabs, t, s.activeGroup === g ? s.activeTabId : undefined), activeTabId: t.id, activeGroup: g, groupActive: { ...s.groupActive, [g]: t.id } }
  })
  persistTabs()
}

export function removeSessionFromTabs(sessionId: string): void {
  set((s) => {
    const owner = s.tabs.find((t) => t.sessionIds.includes(sessionId))
    if (!owner) return {}
    const tabs = s.tabs
      .map((t) => {
        if (t.id !== owner.id) return t
        const ids = t.sessionIds.filter((x) => x !== sessionId)
        return { ...t, sessionIds: ids, activePane: t.activePane === sessionId ? ids[ids.length - 1] : t.activePane }
      })
      .filter((t) => t.sessionIds.length > 0 || t.projectId || t.editor || t.processId)
    const g = owner.group
    let { groups, activeGroup, activeTabId } = s
    // Quick chats closes with its last chat.
    if (g === QUICK && !tabs.some((t) => t.group === QUICK)) {
      groups = groups.filter((x) => x !== QUICK)
      if (activeGroup === QUICK) {
        activeGroup = neighborGroup(s.groups, QUICK)
        activeTabId = activeGroup === HOME ? undefined : (tabs.find((t) => t.id === s.groupActive[activeGroup]) ?? tabs.find((t) => t.group === activeGroup))?.id
      }
    } else if (!tabs.some((t) => t.id === activeTabId) && activeGroup === g) activeTabId = neighborTab(tabs, s.tabs, s.activeTabId, g)
    return { tabs, groups, activeGroup, activeTabId, groupActive: activeTabId && activeGroup !== HOME ? { ...s.groupActive, [activeGroup]: activeTabId } : s.groupActive }
  })
  persistTabs()
}

/** Move a sub-tab to position `toIndex` among its workspace's sub-tabs (the Overview stays first). */
export function moveTab(fromId: string, toIndex: number): void {
  set((s) => {
    const t = s.tabs.find((x) => x.id === fromId)
    if (!t || t.projectId) return {}
    const mine = s.tabs.filter((x) => x.group === t.group && x.id !== fromId)
    const floor = mine[0]?.projectId ? 1 : 0
    mine.splice(Math.max(floor, Math.min(toIndex, mine.length)), 0, t)
    let k = 0
    return { tabs: s.tabs.map((x) => (x.group === t.group ? mine[k++] : x)) }
  })
  persistTabs()
}

/** Move a workspace's title-bar tab to position `toIndex`. */
export function moveGroup(g: string, toIndex: number): void {
  set((s) => {
    if (!s.groups.includes(g)) return {}
    const groups = s.groups.filter((x) => x !== g)
    groups.splice(Math.max(0, Math.min(toIndex, groups.length)), 0, g)
    return { groups }
  })
}

/** Merge a tab's panes into another tab of the same workspace (drag a tab onto a pane). */
export function mergeTabInto(fromId: string, intoId: string): void {
  set((s) => {
    const from = s.tabs.find((t) => t.id === fromId)
    const into = s.tabs.find((t) => t.id === intoId)
    if (!from || !into || from === into || from.group !== into.group || !from.sessionIds.length || !into.sessionIds.length || into.sessionIds.length + from.sessionIds.length > 4) return {}
    return {
      tabs: s.tabs.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? { ...t, sessionIds: [...t.sessionIds, ...from.sessionIds] } : t)),
      activeTabId: intoId,
      groupActive: { ...s.groupActive, [into.group]: intoId }
    }
  })
  persistTabs()
}

export function detachPane(sessionId: string): void {
  set((s) => {
    const owner = s.tabs.find((t) => t.sessionIds.includes(sessionId))
    if (!owner || owner.sessionIds.length < 2) return {}
    const ids = owner.sessionIds.filter((x) => x !== sessionId)
    const t: Tab = { id: tabId(), group: owner.group, sessionIds: [sessionId], activePane: sessionId }
    const tabs = s.tabs.flatMap((x) => (x.id === owner.id ? [{ ...x, sessionIds: ids, activePane: ids[0] }, t] : [x]))
    return { tabs, activeTabId: t.id, groupActive: { ...s.groupActive, [owner.group]: t.id } }
  })
  persistTabs()
}

/** Open (or switch to) a project's workspace on its Overview. */
export function openProjectHome(projectId: string): void {
  set((s) => {
    const next = withGroup(s, projectId)
    const id = next.tabs.find((t) => t.group === projectId && t.projectId)?.id
    return { ...next, activeGroup: projectId, activeTabId: id, groupActive: id ? { ...s.groupActive, [projectId]: id } : s.groupActive }
  })
}

/**
 * Show a workspace's code editor (created after its Overview if needed), optionally opening a file
 * there at a line or in Edit Diff mode. The workspace is the project containing `path` (or the
 * current one). `path` may also be the project folder: the editor opens without a file.
 */
export function openInEditor(path?: string, opts: { line?: number; diff?: boolean; root?: string } = {}): void {
  const s = get()
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = path ? norm(path) : undefined
  const hit = target ? s.library.projects.flatMap((p) => p.folders.map((f) => ({ p, f }))).find(({ f }) => target === norm(f) || target.startsWith(norm(f) + '/')) : undefined
  const g = hit?.p.id ?? (s.activeGroup !== HOME ? s.activeGroup : QUICK)
  const isDirOnly = !!target && !!hit && target === norm(hit.f)
  const root = opts.root ?? hit?.f ?? s.library.projects.find((p) => p.id === g)?.folders[0] ?? (path ? path.replace(/[\\/][^\\/]*$/, '') : undefined)
  set((st) => {
    const base = withGroup(st, g)
    let tabs = base.tabs
    let ed = tabs.find((t) => t.group === g && t.editor)
    if (!ed) {
      ed = { id: tabId(), group: g, sessionIds: [], activePane: '', editor: true, root }
      tabs = insertTab(tabs, ed, tabs.find((t) => t.group === g && t.projectId)?.id)
    }
    const id = ed.id
    return {
      ...base,
      tabs,
      activeGroup: g,
      activeTabId: id,
      groupActive: { ...st.groupActive, [g]: id },
      // The diff viewer dialog would sit over the editor.
      repoDiff: false,
      editorRequest: path && !isDirOnly ? { group: g, path, line: opts.line, diff: opts.diff, at: Date.now() } : st.editorRequest
    }
  })
}

/** Close a sub-tab that holds no sessions (an editor). Chat tabs close by closing their sessions. */
export function closeProjectTab(id: string): void {
  set((s) => {
    const t = s.tabs.find((x) => x.id === id)
    if (!t) return {}
    const tabs = s.tabs.filter((x) => x.id !== id)
    const activeTabId = s.activeTabId === id ? neighborTab(tabs, s.tabs, id, t.group) : s.activeTabId
    return { tabs, activeTabId, groupActive: activeTabId && s.activeGroup === t.group ? { ...s.groupActive, [t.group]: activeTabId } : s.groupActive }
  })
}

/**
 * Show a script run's terminal as a sub-tab in its project's workspace (opening it if needed),
 * next to the project's chats.
 */
export function openProcessTab(processId: string): void {
  set((s) => {
    const p = s.processes.find((x) => x.id === processId)
    if (!p) return {}
    const g = s.library.projects.some((x) => x.id === p.projectId) ? p.projectId : QUICK
    const base = withGroup(s, g)
    let tabs = base.tabs
    let t = tabs.find((x) => x.processId === processId)
    if (!t) {
      t = { id: tabId(), group: g, sessionIds: [], activePane: '', processId }
      tabs = insertTab(tabs, t, s.activeGroup === g ? s.activeTabId : undefined)
    }
    return { ...base, tabs, activeGroup: g, activeTabId: t.id, groupActive: { ...s.groupActive, [g]: t.id } }
  })
}

/** A restarted script gets a new process id: its open tab follows the new run. */
export function retargetProcessTab(oldId: string, newId: string): void {
  set((s) => (s.tabs.some((t) => t.processId === oldId) ? { tabs: s.tabs.map((t) => (t.processId === oldId ? { ...t, processId: newId } : t)) } : {}))
}

/** Close the tabs of runs that no longer exist (their terminal was closed or the run forgotten). */
export function pruneProcessTabs(): void {
  const s = get()
  const live = new Set(s.processes.map((p) => p.id))
  for (const t of s.tabs) if (t.processId && !live.has(t.processId)) closeProjectTab(t.id)
}

/** Each open editor's unsaved file names, by editor tab id (registered by the editor). */
export const editorUnsaved = new Map<string, () => string[]>()

/**
 * Close a workspace's title-bar tab: its chats (each asks first if Claude is still working; a chat
 * that stays open keeps the workspace open) and its Overview and editor (asking about unsaved files).
 */
export async function closeGroup(g: string): Promise<void> {
  const unsaved = get()
    .tabs.filter((t) => t.group === g && t.editor)
    .flatMap((t) => editorUnsaved.get(t.id)?.() ?? [])
  if (unsaved.length && (await api.dialog.confirm(`Close with ${unsaved.length} unsaved file${unsaved.length === 1 ? '' : 's'}?`, unsaved.join(', '), ['Discard changes', 'Cancel'])) !== 0) return
  for (const t of get().tabs.filter((x) => x.group === g)) for (const id of t.sessionIds) await closeSession(id)
  if (get().tabs.some((t) => t.group === g && t.sessionIds.length)) return
  set((s) => {
    const groups = s.groups.filter((x) => x !== g)
    const tabs = s.tabs.filter((t) => t.group !== g)
    if (s.activeGroup !== g) return { groups, tabs }
    const next = neighborGroup(s.groups, g)
    const id = next === HOME ? undefined : (tabs.find((t) => t.id === s.groupActive[next]) ?? tabs.find((t) => t.group === next))?.id
    return { groups, tabs, activeGroup: next, activeTabId: id }
  })
}

/** Next/previous sub-tab within the active workspace. */
export function cycleTab(dir: 1 | -1): void {
  const s = get()
  const mine = s.tabs.filter((t) => t.group === s.activeGroup)
  if (!mine.length) return
  const i = mine.findIndex((t) => t.id === s.activeTabId)
  focusTab(mine[(i + dir + mine.length) % mine.length].id)
}

/** Next/previous workspace in the title bar (Home first). */
export function cycleGroup(dir: 1 | -1): void {
  const s = get()
  const all = [HOME, ...s.groups]
  const i = all.indexOf(s.activeGroup)
  openGroup(all[(i + dir + all.length) % all.length])
}

export function cyclePane(dir: 1 | -1): void {
  const t = activeTab()
  if (!t || t.sessionIds.length < 2) return
  const i = t.sessionIds.indexOf(t.activePane)
  focusTab(t.id, t.sessionIds[(i + dir + t.sessionIds.length) % t.sessionIds.length])
}

// ------------------------------------------------------------------ session actions
export async function openSession(
  kind: SessionKind,
  launch: LaunchOptions,
  opts: { mode?: 'tab' | 'split'; splitOf?: string; background?: boolean } = {}
): Promise<LiveSession | undefined> {
  const s = await attempt(() => api.session.create(kind, launch))
  if (!s) return undefined
  set((st) => ({ sessions: { ...st.sessions, [s.id]: s } }))
  if (kind !== 'shell') {
    const prevTab = get().activeTabId
    addSessionToTabs(s.id, opts.mode ?? (launch.sideOf ? 'split' : 'tab'), opts.splitOf ?? launch.sideOf)
    if (opts.background && prevTab) focusTab(prevTab)
  }
  return s
}

export async function openFolders(folders: string[], opts: { worktree?: boolean; templateId?: string } = {}): Promise<void> {
  for (const cwd of folders) await openSession('agent', { cwd, worktree: opts.worktree ? {} : undefined, templateId: opts.templateId })
}

export async function closeSession(id: string, confirm = true): Promise<void> {
  const s = get().sessions[id]
  if (!s) return
  if (confirm && s.kind === 'agent' && (s.status === 'working' || s.status === 'needs-input')) {
    const r = await api.dialog.confirm(`Close "${s.name}"?`, `${providerOf(s.provider).label} is still working in this session. Closing stops it (the conversation is saved and can be resumed).`, ['Close', 'Cancel'])
    if (r !== 0) return
  }
  if (s.kind === 'agent')
    set((st) => ({ closedStack: [{ cwd: s.cwd, provider: s.provider, agentSessionId: s.agentSessionId, name: s.name }, ...st.closedStack].slice(0, 20) }))
  removeSessionFromTabs(id)
  await api.session.close(id)
}

export async function reopenClosed(): Promise<void> {
  const [last, ...rest] = get().closedStack
  if (!last) return
  set({ closedStack: rest })
  await openSession('agent', { cwd: last.cwd, provider: last.provider, resumeId: last.agentSessionId, name: last.name })
}

export async function resumeChat(agentSessionId: string, mode: 'tab' | 'split' = 'tab'): Promise<void> {
  const open = Object.values(get().sessions).find((s) => s.agentSessionId === agentSessionId && s.status !== 'exited')
  if (open) return focusSessionTab(open.id)
  const chat = get().library.chats.find((c) => c.agentSessionId === agentSessionId)
  if (!chat) return toast('Chat not found', 'error')
  await openSession('agent', { cwd: chat.cwd, provider: chat.provider, resumeId: agentSessionId, name: chat.name }, { mode })
}

export async function signIn(opts: { console?: boolean; sso?: boolean; email?: string; device?: boolean } = {}, provider: ProviderId = get().settings.defaultProvider): Promise<void> {
  const existing = Object.values(get().sessions).find((s) => s.kind === 'login' && s.provider === provider && s.status !== 'exited')
  if (existing) return focusSessionTab(existing.id)
  await openSession('login', { cwd: get().homedir, provider, login: opts, name: `Sign in to ${providerOf(provider).label}` })
}

/** Sign in with an API key (Codex: `codex login --with-api-key`). */
export async function signInWithApiKey(provider: ProviderId): Promise<void> {
  const key = (await askText(`${providerOf(provider).label} API key`, '', { placeholder: 'sk-…', secret: true }))?.trim()
  if (!key) return
  const action = startAction(`Signing in to ${providerOf(provider).label}…`, `login key ${provider}`)
  try {
    await api.auth.loginWithApiKey(provider, key)
    action.done(`Signed in to ${providerOf(provider).label} with an API key`)
  } catch (e) {
    action.drop()
    toast(`Sign-in failed: ${(e as Error).message}`, 'error')
  }
}

/** Sign-in state for a provider (the default provider when omitted). */
export function useAuth(provider?: ProviderId): AuthStatus {
  return useStore((s) => s.auths[provider ?? s.settings.defaultProvider])
}

export async function toggleShell(sessionId?: string): Promise<void> {
  const id = sessionId ?? activeSessionId()
  const s = id ? get().sessions[id] : undefined
  if (!id || !s) return toast('Open a chat to use its terminal')
  if (s.kind === 'shell') return
  const open = !get().shellOpen[id]
  set((st) => ({ shellOpen: { ...st.shellOpen, [id]: open } }))
  if (open) {
    const sh = await attempt(() => api.session.openShell(id))
    if (sh) set((st) => ({ sessions: { ...st.sessions, [sh.id]: sh } }))
  }
}

export function shellFor(parentId: string): LiveSession | undefined {
  return Object.values(get().sessions).find((s) => s.kind === 'shell' && s.launch.parentId === parentId)
}

export function setRight(panel: RightPanel): void {
  set((s) => ({ rightPanel: s.rightPanel === panel ? null : panel }))
}

export function showSidebar(view: SidebarView): void {
  set((s) => ({ sidebarOpen: !(s.sidebarOpen && s.sidebarView === view), sidebarView: view }))
}

// ------------------------------------------------------------------ repo jobs
export async function loadJobs(root: string): Promise<JobDef[]> {
  const defs = (await attempt(() => api.jobs.list(root))) ?? []
  set((s) => ({ jobDefs: { ...s.jobDefs, [root]: defs } }))
  return defs
}

export async function loadRoutines(): Promise<JobDef[]> {
  const routineDefs = (await attempt(() => api.routines.list())) ?? []
  set({ routineDefs })
  return routineDefs
}

// ------------------------------------------------------------------ project actions
export async function loadScripts(projectId: string, refresh = false): Promise<ScriptPackage[]> {
  const pkgs = (await attempt(() => api.processes.scan(projectId, refresh))) ?? []
  set((s) => ({ scripts: { ...s.scripts, [projectId]: pkgs } }))
  // Its command folders (.mono, the package manager's) come from the same scan.
  const tools = (await attempt(() => api.processes.tools(projectId, refresh))) ?? []
  set((s) => ({ tools: { ...s.tools, [projectId]: tools } }))
  return pkgs
}
