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
import type { JobDef, JobRun } from '@shared/jobs'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'
import { api, errMsg, type Library, type LiveSession } from './api'

export interface Tab {
  id: string
  sessionIds: string[]
  activePane: string
}

export type SidebarView = 'projects' | 'activity' | 'jobs' | 'scheduled' | 'team' | 'reviews'
export type RightPanel = 'review' | 'files' | 'team' | 'browser' | 'timeline' | null

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
  claudePath: string
  settings: Settings
  systemDark: boolean
  auth: AuthStatus
  sessions: Record<string, LiveSession>
  tabs: Tab[]
  activeTabId?: string
  library: Library
  automations: { automations: Automation[]; runs: AutomationRun[] }
  jobRuns: JobRun[]
  /** Job definitions per repo root (loaded on demand from <root>/repo_jobs). */
  jobDefs: Record<string, JobDef[]>
  jobsRoot?: string
  /** Background processes owned by projects. */
  processes: ProcessInfo[]
  /** package.json scripts per project id (scanned on demand). */
  scripts: Record<string, ScriptPackage[]>
  /** Process whose log viewer is open. */
  processLog?: string
  /** Project whose Actions section should open (from the command palette). */
  actionsFocus?: string
  mesh: Record<string, MeshGroupState>
  timeline: TimelineEvent[]
  toasts: ToastMessage[]
  savedTabs: OpenTabState[]
  pinnedReviews: string[]
  closedStack: { cwd: string; claudeSessionId?: string; name: string }[]
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
  prompt?: { title: string; value: string; placeholder?: string; multiline?: boolean; resolve: (v: string | null) => void }
  fileToOpen?: { path: string; sessionId?: string }
  updateState?: UpdateState
  teamKey?: string
  browserUrl?: string
}

export const useStore = create<UiState>(() => ({
  ready: false,
  windowId: 0,
  platform: 'win32',
  homedir: '',
  version: '',
  claudePath: '',
  settings: DEFAULT_SETTINGS,
  systemDark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  auth: { checked: false, loggedIn: false },
  sessions: {},
  tabs: [],
  library: { projects: [], chats: [], worktrees: [], recentFolders: [] },
  automations: { automations: [], runs: [] },
  jobRuns: [],
  jobDefs: {},
  processes: [],
  scripts: {},
  mesh: {},
  timeline: [],
  toasts: [],
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
  jobRunFor: false
}))

export const get = useStore.getState
export const set = useStore.setState

const tabId = (): string => 't' + Math.random().toString(36).slice(2, 9)

// ------------------------------------------------------------------ toasts
export function toast(text: string, kind: ToastMessage['kind'] = 'info'): void {
  const t: ToastMessage = { id: Math.random().toString(36).slice(2), kind, text }
  set((s) => ({ toasts: [...s.toasts, t].slice(-5) }))
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === 'error' ? 7000 : 3800)
}

export async function attempt<T>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (okText) toast(okText, 'success')
    return r
  } catch (e) {
    toast(errMsg(e), 'error')
    return undefined
  }
}

// ------------------------------------------------------------------ prompts
export function askText(title: string, value = '', opts: { placeholder?: string; multiline?: boolean } = {}): Promise<string | null> {
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

function persistTabs(): void {
  const s = get()
  if (s.popoutSessionId) return
  void api.session.saveTabs(s.tabs.map((t) => ({ sessionIds: t.sessionIds })))
}

export function focusTab(id: string, pane?: string): void {
  set((s) => ({
    activeTabId: id,
    tabs: pane ? s.tabs.map((t) => (t.id === id ? { ...t, activePane: pane } : t)) : s.tabs
  }))
}

export function focusSessionTab(sessionId: string): void {
  const t = get().tabs.find((x) => x.sessionIds.includes(sessionId))
  if (t) focusTab(t.id, sessionId)
}

export function addSessionToTabs(sessionId: string, mode: 'tab' | 'split' = 'tab', splitOf?: string): void {
  set((s) => {
    if (s.tabs.some((t) => t.sessionIds.includes(sessionId))) return {}
    if (mode === 'split') {
      const target = s.tabs.find((t) => (splitOf ? t.sessionIds.includes(splitOf) : t.id === s.activeTabId))
      if (target && target.sessionIds.length < 4) {
        return {
          tabs: s.tabs.map((t) => (t.id === target.id ? { ...t, sessionIds: [...t.sessionIds, sessionId], activePane: sessionId } : t)),
          activeTabId: target.id
        }
      }
    }
    const t: Tab = { id: tabId(), sessionIds: [sessionId], activePane: sessionId }
    const idx = s.tabs.findIndex((x) => x.id === s.activeTabId)
    const tabs = [...s.tabs]
    tabs.splice(idx < 0 ? tabs.length : idx + 1, 0, t)
    return { tabs, activeTabId: t.id }
  })
  persistTabs()
}

export function removeSessionFromTabs(sessionId: string): void {
  set((s) => {
    const tabs = s.tabs
      .map((t) => {
        if (!t.sessionIds.includes(sessionId)) return t
        const ids = t.sessionIds.filter((x) => x !== sessionId)
        return { ...t, sessionIds: ids, activePane: t.activePane === sessionId ? ids[ids.length - 1] : t.activePane }
      })
      .filter((t) => t.sessionIds.length > 0)
    let activeTabId = s.activeTabId
    if (!tabs.some((t) => t.id === activeTabId)) {
      const oldIdx = s.tabs.findIndex((t) => t.id === s.activeTabId)
      activeTabId = tabs[Math.min(Math.max(0, oldIdx), tabs.length - 1)]?.id
    }
    return { tabs, activeTabId }
  })
  persistTabs()
}

export function moveTab(fromId: string, toIndex: number): void {
  set((s) => {
    const tabs = [...s.tabs]
    const i = tabs.findIndex((t) => t.id === fromId)
    if (i < 0) return {}
    const [t] = tabs.splice(i, 1)
    tabs.splice(Math.max(0, Math.min(toIndex, tabs.length)), 0, t)
    return { tabs }
  })
  persistTabs()
}

/** Merge a tab's panes into another tab (drag a tab onto a pane). */
export function mergeTabInto(fromId: string, intoId: string): void {
  set((s) => {
    const from = s.tabs.find((t) => t.id === fromId)
    const into = s.tabs.find((t) => t.id === intoId)
    if (!from || !into || from === into || into.sessionIds.length + from.sessionIds.length > 4) return {}
    return {
      tabs: s.tabs.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? { ...t, sessionIds: [...t.sessionIds, ...from.sessionIds] } : t)),
      activeTabId: intoId
    }
  })
  persistTabs()
}

export function detachPane(sessionId: string): void {
  set((s) => {
    const owner = s.tabs.find((t) => t.sessionIds.includes(sessionId))
    if (!owner || owner.sessionIds.length < 2) return {}
    const ids = owner.sessionIds.filter((x) => x !== sessionId)
    const t: Tab = { id: tabId(), sessionIds: [sessionId], activePane: sessionId }
    const tabs = s.tabs.flatMap((x) => (x.id === owner.id ? [{ ...x, sessionIds: ids, activePane: ids[0] }, t] : [x]))
    return { tabs, activeTabId: t.id }
  })
  persistTabs()
}

export function cycleTab(dir: 1 | -1): void {
  const s = get()
  if (!s.tabs.length) return
  const i = s.tabs.findIndex((t) => t.id === s.activeTabId)
  const next = s.tabs[(i + dir + s.tabs.length) % s.tabs.length]
  focusTab(next.id)
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
  for (const cwd of folders) await openSession('claude', { cwd, worktree: opts.worktree ? {} : undefined, templateId: opts.templateId })
}

export async function closeSession(id: string, confirm = true): Promise<void> {
  const s = get().sessions[id]
  if (!s) return
  if (confirm && s.kind === 'claude' && (s.status === 'working' || s.status === 'needs-input')) {
    const r = await api.dialog.confirm(`Close "${s.name}"?`, 'Claude is still working in this session. Closing stops it (the conversation is saved and can be resumed).', ['Close', 'Cancel'])
    if (r !== 0) return
  }
  if (s.kind === 'claude')
    set((st) => ({ closedStack: [{ cwd: s.cwd, claudeSessionId: s.claudeSessionId, name: s.name }, ...st.closedStack].slice(0, 20) }))
  removeSessionFromTabs(id)
  await api.session.close(id)
}

export async function reopenClosed(): Promise<void> {
  const [last, ...rest] = get().closedStack
  if (!last) return
  set({ closedStack: rest })
  await openSession('claude', { cwd: last.cwd, resumeId: last.claudeSessionId, name: last.name })
}

export async function resumeChat(claudeSessionId: string, mode: 'tab' | 'split' = 'tab'): Promise<void> {
  const open = Object.values(get().sessions).find((s) => s.claudeSessionId === claudeSessionId && s.status !== 'exited')
  if (open) return focusSessionTab(open.id)
  const chat = get().library.chats.find((c) => c.claudeSessionId === claudeSessionId)
  if (!chat) return toast('Chat not found', 'error')
  await openSession('claude', { cwd: chat.cwd, resumeId: claudeSessionId, name: chat.name }, { mode })
}

export async function signIn(opts: { console?: boolean; sso?: boolean; email?: string } = {}): Promise<void> {
  const existing = Object.values(get().sessions).find((s) => s.kind === 'login' && s.status !== 'exited')
  if (existing) return focusSessionTab(existing.id)
  await openSession('login', { cwd: get().homedir, login: opts, name: 'Sign in' })
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

// ------------------------------------------------------------------ project actions
export async function loadScripts(projectId: string, refresh = false): Promise<ScriptPackage[]> {
  const pkgs = (await attempt(() => api.processes.scan(projectId, refresh))) ?? []
  set((s) => ({ scripts: { ...s.scripts, [projectId]: pkgs } }))
  return pkgs
}
