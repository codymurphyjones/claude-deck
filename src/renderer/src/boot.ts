import type { AuthStatus, Automation, AutomationRun, MeshGroupState, SessionInfo, Settings, TimelineEvent, ToastMessage, UpdateState } from '@shared/types'
import type { JobRun } from '@shared/jobs'
import type { ProcessInfo } from '@shared/processes'
import { api, bridge, type Library, type LiveSession } from './api'
import { comboIndex, eventCombo } from './shortcuts'
import { addSessionToTabs, focusSessionTab, get, loadJobs, openFolders, openSession, removeSessionFromTabs, set, toast, type Tab } from './store'
import { applyTerminalOptions, disposeTerminal, hydrate, setKeyInterceptor } from './terminal/registry'
import { applyTheme, resolveTheme } from './theme'
import { runCommand } from './commands'

let combos = new Map<string, string>()

function applyLook(): void {
  const s = get()
  const theme = resolveTheme(s.settings, s.systemDark)
  applyTheme(theme, s.settings)
  applyTerminalOptions(s.settings, theme.terminal)
  void api.window.setTitleBarOverlay(s.settings.translucentSidebar ? '#00000000' : theme.ui.panel, theme.ui.muted)
  combos = comboIndex(s.settings)
}

/** App-level shortcuts. Runs in the capture phase so terminals never see them. */
function handleKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false
  const combo = eventCombo(e)
  const cmd = combos.get(combo)
  if (!cmd) return false
  // Let plain typing shortcuts work inside text fields.
  const t = e.target as HTMLElement | null
  const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !t.closest('.xterm')
  if (inField && !e.ctrlKey && !e.altKey) return false
  if (inField && ['zoomIn', 'zoomOut', 'zoomReset'].includes(cmd)) return false
  e.preventDefault()
  e.stopPropagation()
  runCommand(cmd)
  return true
}

export async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search)
  const popout = params.get('popout') ?? undefined
  const d = await api.init()
  const sessions: Record<string, LiveSession> = {}
  for (const s of d.sessions) sessions[s.id] = s
  const mesh: Record<string, MeshGroupState> = {}
  for (const g of d.mesh) mesh[g.key] = g

  let tabs: Tab[] = []
  if (popout) tabs = [{ id: 'popout', sessionIds: [popout], activePane: popout }]
  else
    tabs = d.sessions
      .filter((s) => s.kind !== 'shell' && (s.hostWindow === d.windowId || !d.sessions.length))
      .map((s) => ({ id: 't' + s.id.slice(0, 6), sessionIds: [s.id], activePane: s.id }))

  set({
    ready: true,
    windowId: d.windowId,
    popoutSessionId: popout,
    platform: d.platform,
    homedir: d.homedir,
    version: d.version,
    claudePath: d.claudePath,
    settings: d.settings,
    auth: d.auth,
    sessions,
    tabs,
    activeTabId: tabs[0]?.id,
    library: d.library,
    automations: d.automations,
    jobRuns: d.jobRuns,
    processes: d.processes,
    mesh,
    timeline: d.timeline,
    savedTabs: d.savedTabs,
    pinnedReviews: d.pinnedReviews,
    sidebarOpen: !popout,
    rightPanel: null
  })
  // Rebuild views for sessions that survived a window reload.
  for (const s of d.sessions) if (s.kind !== 'shell' || !popout) void hydrate(s.id)

  applyLook()
  useSubscriptions(d.windowId, !!popout)
  window.addEventListener('keydown', (e) => handleKey(e), true)
  setKeyInterceptor(() => false)

  if (!popout && !d.sessions.length && d.savedTabs.length) {
    if (d.settings.restoreSessions === 'always') void restoreSaved()
  }
}

export async function restoreSaved(): Promise<void> {
  const saved = get().savedTabs
  set({ savedTabs: [] })
  for (const t of saved) {
    let first: string | undefined
    for (const s of t.sessions) {
      const live = await openSession(
        'claude',
        { cwd: s.cwd, resumeId: s.claudeSessionId, name: s.name, role: s.role },
        first ? { mode: 'split', splitOf: first } : {}
      )
      first ??= live?.id
    }
  }
}

function useSubscriptions(windowId: number, isPopout: boolean): void {
  bridge.on('session:update', (s: LiveSession) => {
    const known = !!get().sessions[s.id]
    set((st) => ({ sessions: { ...st.sessions, [s.id]: { ...st.sessions[s.id], ...s } } }))
    if (!known) {
      void hydrate(s.id)
      // Sessions started elsewhere (scheduled tasks, mesh tooling) get their own tab.
      if (!isPopout && s.kind !== 'shell' && s.hostWindow === windowId)
        setTimeout(() => {
          if (!get().tabs.some((t) => t.sessionIds.includes(s.id)) && get().sessions[s.id]) addSessionToTabs(s.id, 'tab')
        }, 400)
    }
  })
  bridge.on('session:removed', (id: string) => {
    removeSessionFromTabs(id)
    set((st) => {
      const { [id]: _gone, ...rest } = st.sessions
      return { sessions: rest }
    })
    disposeTerminal(id)
    if (isPopout && id === get().popoutSessionId) window.close()
  })
  bridge.on('auth:changed', (auth: AuthStatus) => set({ auth }))
  bridge.on('update:state', (updateState: UpdateState) => set({ updateState }))
  void api.update.state().then((updateState) => set({ updateState }))
  bridge.on('library:changed', (library: Library) => set({ library }))
  bridge.on('automations:changed', (automations: { automations: Automation[]; runs: AutomationRun[] }) => set({ automations }))
  bridge.on('jobs:runs', (jobRuns: JobRun[]) => set({ jobRuns }))
  bridge.on('processes:changed', (processes: ProcessInfo[]) => {
    // Finished processes are forgotten by main; drop their terminal views too.
    for (const p of get().processes) if (!processes.some((x) => x.id === p.id)) disposeTerminal(p.id)
    set({ processes })
  })
  bridge.on('jobs:changed', (root: string) => {
    if (get().jobDefs[root]) void loadJobs(root)
  })
  bridge.on('mesh:changed', (g: MeshGroupState) => set((st) => ({ mesh: { ...st.mesh, [g.key]: g } })))
  bridge.on('timeline:event', (ev: TimelineEvent) => set((st) => ({ timeline: [...st.timeline.slice(-999), ev] })))
  bridge.on('toast', (t: ToastMessage) => toast(t.text, t.kind))
  bridge.on('settings:changed', (settings: Settings) => {
    set({ settings })
    applyLook()
  })
  bridge.on('theme:system', (dark: boolean) => {
    set({ systemDark: dark })
    applyLook()
  })
  bridge.on('ui:focusSession', (id: string) => focusSessionTab(id))
  bridge.on('app:openPaths', async (paths: string[]) => {
    const folders = await api.fs.resolveDrop(paths)
    await openFolders(folders)
  })
  bridge.on('session:fileTouched', (ev: { id: string; path: string }) => {
    if (get().settings.autoOpenFiles && !isPopout) set({ fileToOpen: { path: ev.path, sessionId: ev.id }, rightPanel: 'files' })
  })
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    set({ systemDark: e.matches })
    applyLook()
  })
  // Keep main informed which session the user is looking at (for unread state).
  let last = ''
  const report = (): void => {
    const st = get()
    const tab = st.tabs.find((t) => t.id === st.activeTabId)
    const key = `${tab?.activePane}|${document.hasFocus()}`
    if (key === last) return
    last = key
    void api.session.setActive(tab?.activePane, document.hasFocus())
  }
  window.addEventListener('focus', report)
  window.addEventListener('blur', report)
  import('./store').then(({ useStore }) => useStore.subscribe(report))
}

export type { SessionInfo }
