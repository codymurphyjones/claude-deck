import type { AuthStatus, Automation, AutomationRun, MeshGroupState, ProgressEvent, SessionInfo, Settings, TimelineEvent, ToastMessage, UpdateState } from '@shared/types'
import type { JobRun } from '@shared/jobs'
import type { ProcessInfo } from '@shared/processes'
import { api, bridge, type Library, type LiveSession } from './api'
import { comboIndex, eventCombo } from './shortcuts'
import { addSessionToTabs, finishProgress, focusSessionTab, get, groupOf, HOME, loadJobs, loadRoutines, openFolders, openInEditor, openSession, pruneProcessTabs, QUICK, removeSessionFromTabs, set, toast, type Tab } from './store'
import { applyTerminalOptions, disposeTerminal, hydrate, setKeyInterceptor } from './terminal/registry'
import { applyTheme, resolveTheme } from './theme'
import { runCommand } from './commands'
import { initAgentRequests } from './agentRequests'
import { copyPointedJobCard, isTypingTarget, pasteJobCard } from './jobClipboard'

let combos = new Map<string, string>()

function applyLook(): void {
  const s = get()
  const theme = resolveTheme(s.settings, s.systemDark)
  applyTheme(theme, s.settings)
  applyTerminalOptions(s.settings, theme.terminal)
  void api.window.setTitleBarOverlay(s.settings.translucentSidebar ? '#00000000' : theme.ui.panel, theme.ui.muted)
  combos = comboIndex(s.settings)
}

/** Combos the editor tab (FileEditor.tsx) handles itself; app shortcuts on these yield to it there. */
const EDITOR_KEYS = new Set(['Ctrl+S', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+N', 'Ctrl+W', 'Ctrl+P', 'Ctrl+Shift+F', 'Ctrl+B', 'Ctrl+G', 'Ctrl+H', 'Ctrl+F', 'Ctrl+/', 'Ctrl+Shift+O', 'Ctrl+Shift+D', 'Ctrl+=', 'Ctrl++', 'Ctrl+-', 'Ctrl+0', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Alt+Z', 'F7', 'Shift+F7'])

/** App-level shortcuts. Runs in the capture phase so terminals never see them. */
function handleKey(e: KeyboardEvent): boolean {
  if (e.type !== 'keydown') return false
  const combo = eventCombo(e)
  // Ctrl+V outside text fields pastes a copied routine / repo job card.
  if (combo === 'Ctrl+V' && !combos.has(combo) && !get().popoutSessionId && !isTypingTarget(e.target)) {
    e.preventDefault()
    void pasteJobCard()
    return true
  }
  // Ctrl+C on a routine / repo job (hovered, or open in the designer) copies it as an image card.
  if (combo === 'Ctrl+C' && !combos.has(combo) && !isTypingTarget(e.target) && copyPointedJobCard()) {
    e.preventDefault()
    return true
  }
  const cmd = combos.get(combo)
  if (!cmd) return false
  // Let plain typing shortcuts work inside text fields.
  const t = e.target as HTMLElement | null
  // The editor tab owns the shortcuts it uses (save, close file, find, quick open, zoom…); app-wide
  // navigation (switching tabs, new chat, palette…) still works from it.
  if (t?.closest?.('.file-editor') && EDITOR_KEYS.has(combo)) return false
  // A focused CodeMirror view keeps its own find (Ctrl+F).
  if (cmd === 'find' && t?.closest?.('.cm-editor')) return false
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

  // Sessions that survived a window reload, each in its workspace (a project, with its Overview
  // first, or Quick chats).
  let tabs: Tab[] = []
  const groups: string[] = []
  if (popout) {
    const g = groupOf({ library: d.library }, sessions[popout])
    tabs = [{ id: 'popout', group: g, sessionIds: [popout], activePane: popout }]
    groups.push(g)
  } else
    for (const s of d.sessions.filter((x) => x.kind !== 'shell' && x.hostWindow === d.windowId)) {
      const g = groupOf({ library: d.library }, s)
      if (!groups.includes(g)) {
        groups.push(g)
        if (g !== QUICK) tabs.push({ id: 'o' + g.slice(0, 8), group: g, sessionIds: [], activePane: '', projectId: g })
      }
      tabs.push({ id: 't' + s.id.slice(0, 6), group: g, sessionIds: [s.id], activePane: s.id })
    }
  const first = tabs.find((t) => t.sessionIds.length)

  set({
    ready: true,
    windowId: d.windowId,
    popoutSessionId: popout,
    platform: d.platform,
    homedir: d.homedir,
    version: d.version,
    agentPaths: d.agentPaths,
    settings: d.settings,
    auths: d.auth,
    sessions,
    tabs,
    groups,
    activeTabId: first?.id,
    activeGroup: first?.group ?? HOME,
    groupActive: first ? { [first.group]: first.id } : {},
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
        'agent',
        { cwd: s.cwd, provider: s.provider, resumeId: s.agentSessionId, name: s.name, role: s.role },
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
  bridge.on('auth:changed', (auth: AuthStatus) => set((st) => ({ auths: { ...st.auths, [auth.provider ?? 'claude']: auth } })))
  bridge.on('update:state', (updateState: UpdateState) => set({ updateState }))
  void api.update.state().then((updateState) => set({ updateState }))
  bridge.on('library:changed', (library: Library) => set({ library }))
  bridge.on('automations:changed', (automations: { automations: Automation[]; runs: AutomationRun[] }) => set({ automations }))
  bridge.on('jobs:runs', (jobRuns: JobRun[]) => set({ jobRuns }))
  bridge.on('processes:changed', (processes: ProcessInfo[]) => {
    // Finished processes are forgotten by main; drop their terminal views too.
    for (const p of get().processes) if (!processes.some((x) => x.id === p.id)) disposeTerminal(p.id)
    set({ processes })
    // A closed or forgotten run's terminal tab closes with it.
    pruneProcessTabs()
  })
  bridge.on('jobs:changed', (root: string) => {
    if (get().jobDefs[root]) void loadJobs(root)
  })
  bridge.on('routines:changed', () => {
    if (get().routineDefs) void loadRoutines()
  })
  bridge.on('mesh:changed', (g: MeshGroupState) => set((st) => ({ mesh: { ...st.mesh, [g.key]: g } })))
  bridge.on('timeline:event', (ev: TimelineEvent) => set((st) => ({ timeline: [...st.timeline.slice(-999), ev] })))
  bridge.on('toast', (t: ToastMessage) => toast(t.text, t.kind))
  // Long operations: shown while running; a finished one lingers a moment so the full ring is seen.
  bridge.on('progress', (p: ProgressEvent) => {
    if (p.state === 'running') return set((s) => ({ progress: [...s.progress.filter((x) => x.id !== p.id), p] }))
    // Finished: the ring completes, then a check while it lingers (store.finishProgress).
    if (!get().progress.some((x) => x.id === p.id)) set((s) => ({ progress: [...s.progress, p] }))
    finishProgress(p.id, { state: p.state, detail: p.state === 'done' ? 'Ready' : 'Failed' })
  })
  bridge.on('settings:changed', (settings: Settings) => {
    set({ settings })
    applyLook()
  })
  bridge.on('theme:system', (dark: boolean) => {
    set({ systemDark: dark })
    applyLook()
  })
  // From a notification click: show the session even if its tab was closed or a modal is open.
  bridge.on('ui:focusSession', (id: string) => {
    const s = get().sessions[id]
    if (isPopout || !s) return
    set({ settingsOpen: false, palette: false })
    if (s.hostWindow === windowId && s.kind !== 'shell' && !get().tabs.some((t) => t.sessionIds.includes(id))) addSessionToTabs(id, 'tab')
    focusSessionTab(id)
  })
  bridge.on('app:openPaths', async (paths: string[]) => {
    const folders = await api.fs.resolveDrop(paths)
    await openFolders(folders)
  })
  // Agents' other app tools (show_diff, request_review, open_browser, run_routine).
  if (!isPopout) initAgentRequests()
  // An agent's open_file tool: show the file in the editor tab.
  bridge.on('app:openFile', (ev: { path: string; line?: number }) => {
    if (!isPopout) openInEditor(ev.path, { line: ev.line })
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
