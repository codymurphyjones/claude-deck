import { api } from './api'
import {
  addSessionToTabs,
  activeSession,
  activeSessionId,
  activeTab,
  askText,
  attempt,
  closeSession,
  cyclePane,
  cycleTab,
  detachPane,
  focusTab,
  get,
  openSession,
  reopenClosed,
  set,
  setRight,
  showSidebar,
  signIn,
  toast,
  toggleShell
} from './store'
import { clearTerminal } from './terminal/registry'
import { newJob } from '@shared/jobs'
import { designInChat, designRoutineInChat, openJobsFor } from './components/Jobs'
import { openRoutines, runRoutine } from './components/Routines'

export interface Command {
  id: string
  title: string
  group: string
  icon?: string
  /** Only offered when this returns true. */
  when?: () => boolean
  run: () => unknown
}

const hasClaude = (): boolean => activeSession()?.kind === 'claude'
const withActive = (fn: (id: string) => unknown) => () => {
  const id = activeSessionId()
  if (id) return fn(id)
  toast('Open a session first')
}

export const SLASH_COMMANDS: [string, string][] = [
  ['/compact', 'Compact the conversation context'],
  ['/clear', 'Clear conversation history'],
  ['/model', 'Choose the model'],
  ['/effort', 'Set reasoning effort'],
  ['/status', 'Show session status, context and limits'],
  ['/usage', 'Show plan usage'],
  ['/cost', 'Show token usage'],
  ['/context', 'Visualize context usage'],
  ['/mcp', 'Manage MCP servers'],
  ['/memory', 'Edit memory files'],
  ['/init', 'Create a CLAUDE.md for this project'],
  ['/review', 'Review the current changes'],
  ['/security-review', 'Security review of pending changes'],
  ['/agents', 'Manage subagents'],
  ['/hooks', 'Manage hooks'],
  ['/permissions', 'View or update permissions'],
  ['/plugin', 'Manage plugins'],
  ['/resume', 'Resume another conversation'],
  ['/rewind', 'Rewind code and conversation'],
  ['/export', 'Export the conversation'],
  ['/doctor', 'Check installation health'],
  ['/feedback', 'Send feedback to Anthropic'],
  ['/help', 'Show help']
]

export function buildCommands(): Command[] {
  const cmds: Command[] = [
    { id: 'newSession', title: 'New session…', group: 'Sessions', icon: 'plus', run: () => set({ newSession: {} }) },
    { id: 'newWorktreeSession', title: 'New session in a worktree…', group: 'Sessions', icon: 'branch', run: () => set({ newSession: { worktree: true } }) },
    { id: 'quickChat', title: 'Quick chat', group: 'Sessions', icon: 'zap', run: () => openSession('claude', { cwd: get().homedir, quick: true }) },
    {
      id: 'openFolder',
      title: 'Open folder…',
      group: 'Sessions',
      icon: 'folder-open',
      run: async () => {
        const dirs = await api.dialog.openFolder()
        for (const d of dirs) await openSession('claude', { cwd: d })
      }
    },
    { id: 'fleet', title: 'Launch a team (lead + workers)…', group: 'Collaboration', icon: 'users', run: () => set({ fleetOpen: { cwd: activeSession()?.cwd } }) },
    { id: 'broadcast', title: 'Broadcast a prompt to sessions…', group: 'Collaboration', icon: 'radio', run: () => set({ broadcastOpen: true }) },
    { id: 'toggleTeam', title: 'Team panel', group: 'Collaboration', icon: 'users', run: () => setRight('team') },
    { id: 'deliverMessages', title: 'Deliver pending peer messages', group: 'Collaboration', icon: 'message', when: hasClaude, run: withActive((id) => api.session.deliverMessages(id).then((ok) => !ok && toast('No pending messages (or session is busy)'))) },
    {
      id: 'setRoleLead',
      title: 'Set role: lead',
      group: 'Collaboration',
      icon: 'flag',
      when: hasClaude,
      run: withActive((id) => api.session.setRole(id, 'lead'))
    },
    { id: 'setRoleWorker', title: 'Set role: worker', group: 'Collaboration', icon: 'hand', when: hasClaude, run: withActive((id) => api.session.setRole(id, 'worker')) },
    { id: 'setRoleReviewer', title: 'Set role: reviewer', group: 'Collaboration', icon: 'eye', when: hasClaude, run: withActive((id) => api.session.setRole(id, 'reviewer')) },
    { id: 'setRoleDriver', title: 'Set role: driver', group: 'Collaboration', icon: 'code', when: hasClaude, run: withActive((id) => api.session.setRole(id, 'driver')) },
    { id: 'setRoleFree', title: 'Clear role', group: 'Collaboration', icon: 'x', when: hasClaude, run: withActive((id) => api.session.setRole(id, 'free')) },
    { id: 'closeTab', title: 'Close session', group: 'Sessions', icon: 'x', run: withActive((id) => closeSession(id)) },
    { id: 'reopenClosed', title: 'Reopen closed session', group: 'Sessions', icon: 'undo', run: reopenClosed },
    { id: 'nextTab', title: 'Next tab', group: 'Navigation', run: () => cycleTab(1) },
    { id: 'prevTab', title: 'Previous tab', group: 'Navigation', run: () => cycleTab(-1) },
    { id: 'focusNextPane', title: 'Focus next pane', group: 'Navigation', run: () => cyclePane(1) },
    { id: 'focusPrevPane', title: 'Focus previous pane', group: 'Navigation', run: () => cyclePane(-1) },
    {
      id: 'splitRight',
      title: 'Split: new session beside this one',
      group: 'Layout',
      icon: 'split',
      run: () => {
        const s = activeSession()
        if (s) return openSession('claude', { cwd: s.cwd }, { mode: 'split', splitOf: s.id })
        set({ newSession: {} })
      }
    },
    { id: 'detachPane', title: 'Move pane to its own tab', group: 'Layout', icon: 'external', when: () => (activeTab()?.sessionIds.length ?? 0) > 1, run: withActive(detachPane) },
    { id: 'popOut', title: 'Pop out into a window', group: 'Layout', icon: 'popout', run: withActive((id) => api.window.popOut(id)) },
    { id: 'toggleSidebar', title: 'Toggle sidebar', group: 'Layout', icon: 'sidebar', run: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })) },
    { id: 'toggleActivity', title: 'Activity', group: 'Layout', icon: 'bell', run: () => showSidebar('activity') },
    { id: 'scheduled', title: 'Scheduled tasks', group: 'Automation', icon: 'clock', run: () => showSidebar('scheduled') },
    { id: 'jobs', title: 'Repo jobs', group: 'Automation', icon: 'layers', run: () => openJobsFor(activeSession()?.root) },
    {
      id: 'newJob',
      title: 'New repo job…',
      group: 'Automation',
      icon: 'layers',
      when: hasClaude,
      run: () => {
        const s = activeSession()
        if (s) set({ jobEdit: { root: s.root, draft: newJob() } })
      }
    },
    { id: 'designJob', title: 'Design a repo job with Claude…', group: 'Automation', icon: 'sparkles', when: hasClaude, run: () => void designInChat(activeSession()!.root) },
    { id: 'routines', title: 'Routines', group: 'Automation', icon: 'wand', run: openRoutines },
    { id: 'runRoutine', title: 'Run a routine…', group: 'Automation', icon: 'wand', run: () => runRoutine() },
    { id: 'newRoutine', title: 'New routine…', group: 'Automation', icon: 'wand', run: () => set({ routineEdit: { draft: newJob('New routine') } }) },
    { id: 'designRoutine', title: 'Design a routine with Claude…', group: 'Automation', icon: 'sparkles', run: () => void designRoutineInChat() },
    {
      id: 'projectActions',
      title: 'Project actions (package.json scripts)',
      group: 'Automation',
      icon: 'play',
      run: () => {
        const pid = activeSession()?.projectId ?? get().library.projects[0]?.id
        set({ sidebarOpen: true, sidebarView: 'projects', actionsFocus: pid })
      }
    },
    { id: 'newAutomation', title: 'New scheduled task…', group: 'Automation', icon: 'clock', run: () => set({ automationEdit: { cwd: activeSession()?.cwd } }) },
    {
      id: 'scheduleInChat',
      title: 'Schedule a follow-up in this chat…',
      group: 'Automation',
      icon: 'clock',
      when: hasClaude,
      run: () => {
        const s = activeSession()
        if (s) set({ automationEdit: { kind: 'inchat', cwd: s.cwd, targetChatId: s.claudeSessionId, name: `${s.name} follow-up`, schedule: { type: 'interval', minutes: 30 } } })
      }
    },
    {
      id: 'repo',
      title: 'Repository manager',
      group: 'Git',
      icon: 'branch',
      run: () => {
        const root = activeSession()?.root
        set({ sidebarOpen: true, sidebarView: 'repo', ...(root ? { repoRoot: root } : {}) })
      }
    },
    { id: 'reviews', title: 'Pull request reviews', group: 'Git', icon: 'pr', run: () => showSidebar('reviews') },
    { id: 'toggleReview', title: 'Review changes (diff)', group: 'Git', icon: 'branch', run: () => setRight('review') },
    { id: 'toggleFiles', title: 'Files touched by Claude', group: 'Layout', icon: 'file', run: () => setRight('files') },
    { id: 'toggleBrowser', title: 'Browser preview', group: 'Layout', icon: 'globe', run: () => setRight('browser') },
    { id: 'toggleTimeline', title: 'Cross-session timeline', group: 'Layout', icon: 'activity', run: () => setRight('timeline') },
    { id: 'toggleShell', title: 'Toggle integrated terminal', group: 'Session', icon: 'terminal', run: () => toggleShell() },
    { id: 'composer', title: 'Open composer', group: 'Session', icon: 'edit', when: hasClaude, run: withActive((id) => set({ composerFor: id })) },
    { id: 'setGoal', title: 'Set a goal…', group: 'Session', icon: 'target', when: hasClaude, run: withActive((id) => set({ goalFor: id })) },
    { id: 'cycleMode', title: 'Cycle permission mode (plan / accept edits / …)', group: 'Session', icon: 'shield', when: hasClaude, run: withActive((id) => api.session.cycleMode(id)) },
    { id: 'forkChat', title: 'Fork this chat', group: 'Session', icon: 'fork', when: hasClaude, run: withActive((id) => attempt(() => api.session.fork(id, {})).then((s) => s && reload(s.id))) },
    { id: 'forkWorktree', title: 'Fork this chat into a worktree', group: 'Session', icon: 'branch', when: hasClaude, run: withActive((id) => attempt(() => api.session.fork(id, { worktree: true })).then((s) => s && reload(s.id))) },
    { id: 'sideChat', title: 'Side chat (temporary fork)', group: 'Session', icon: 'message', when: hasClaude, run: withActive((id) => attempt(() => api.session.fork(id, { side: true })).then((s) => s && reload(s.id, 'split', id))) },
    {
      id: 'handoff',
      title: 'Hand off (local ⇄ worktree)',
      group: 'Session',
      icon: 'arrow',
      when: hasClaude,
      run: withActive((id) => attempt(() => api.session.handoff(id)))
    },
    {
      id: 'renameSession',
      title: 'Rename session…',
      group: 'Session',
      icon: 'edit',
      run: withActive(async (id) => {
        const s = get().sessions[id]
        const name = await askText('Rename session', s?.name)
        if (name) await api.session.rename(id, name)
      })
    },
    { id: 'restartSession', title: 'Restart session', group: 'Session', icon: 'refresh', run: withActive((id) => { clearTerminal(id); return api.session.restart(id) }) },
    { id: 'clearTerminal', title: 'Clear terminal view', group: 'Session', icon: 'trash', run: withActive((id) => clearTerminal(id)) },
    { id: 'findInTerminal', title: 'Find in terminal', group: 'Session', icon: 'search', run: () => window.dispatchEvent(new CustomEvent('deck:find')) },
    {
      id: 'remoteControl',
      title: 'Continue on phone / web (Remote Control)',
      group: 'Session',
      icon: 'phone',
      when: hasClaude,
      run: withActive(async (id) => {
        const s = get().sessions[id]
        if (!s?.claudeSessionId) return
        await closeSession(id, false)
        await openSession('claude', { cwd: s.cwd, resumeId: s.claudeSessionId, name: s.name, remoteControl: true })
        toast('Remote Control is on. Open this session from the Claude app or claude.ai/code.', 'success')
      })
    },
    {
      id: 'cloud',
      title: 'Run a task in the cloud…',
      group: 'Session',
      icon: 'cloud',
      run: async () => {
        const desc = await askText('Cloud task description', '', { placeholder: 'What should Claude do in the cloud?' })
        if (!desc) return
        await openSession('command', { cwd: activeSession()?.cwd ?? get().homedir, command: get().claudePath, args: ['--cloud', desc], name: 'Cloud task' })
      }
    },
    // Shortcut target only; listing the palette inside itself would be noise.
    { id: 'palette', title: 'Command palette', group: 'App', when: () => false, run: () => set((s) => ({ palette: s.palette ? false : 'all' })) },
    { id: 'settings', title: 'Settings', group: 'App', icon: 'settings', run: () => set({ settingsOpen: 'general' }) },
    { id: 'shortcuts', title: 'Keyboard shortcuts', group: 'App', icon: 'keyboard', run: () => set({ settingsOpen: 'shortcuts' }) },
    { id: 'appearance', title: 'Appearance & themes', group: 'App', icon: 'palette', run: () => set({ settingsOpen: 'appearance' }) },
    { id: 'updates', title: 'Updates & version manager (roll back)', group: 'App', icon: 'download', run: () => set({ settingsOpen: 'updates' }) },
    { id: 'checkUpdates', title: 'Check for updates', group: 'App', icon: 'refresh', run: () => api.update.check() },
    { id: 'insights', title: 'Profile & usage insights', group: 'App', icon: 'activity', run: () => set({ settingsOpen: 'profile' }) },
    { id: 'archived', title: 'Archived chats', group: 'App', icon: 'archive', run: () => set({ settingsOpen: 'archived' }) },
    { id: 'signIn', title: 'Sign in to Claude', group: 'Account', icon: 'login', run: () => signIn() },
    { id: 'signInConsole', title: 'Sign in with Anthropic Console (API billing)', group: 'Account', icon: 'login', run: () => signIn({ console: true }) },
    {
      id: 'signOut',
      title: 'Sign out',
      group: 'Account',
      icon: 'logout',
      run: async () => {
        if ((await api.dialog.confirm('Sign out of Claude?', 'Running sessions keep running; new sessions will ask you to sign in.', ['Sign out', 'Cancel'])) === 0) await api.auth.logout()
      }
    },
    {
      id: 'buddy',
      title: 'Toggle status buddy (floating window)',
      group: 'App',
      icon: 'sparkles',
      run: () => api.updateSettings({ buddy: !get().settings.buddy }).then((settings) => set({ settings }))
    },
    {
      id: 'alwaysOnTop',
      title: 'Toggle always on top',
      group: 'App',
      icon: 'pin',
      run: () => api.updateSettings({ alwaysOnTop: !get().settings.alwaysOnTop }).then((settings) => set({ settings }))
    },
    { id: 'zoomIn', title: 'Increase terminal font size', group: 'App', run: () => zoom(1) },
    { id: 'zoomOut', title: 'Decrease terminal font size', group: 'App', run: () => zoom(-1) },
    { id: 'zoomReset', title: 'Reset terminal font size', group: 'App', run: () => zoom(0) },
    { id: 'reload', title: 'Reload window (sessions keep running)', group: 'App', icon: 'refresh', run: () => location.reload() },
    { id: 'devtools', title: 'Toggle developer tools', group: 'App', icon: 'code', run: () => api.window.devtools() }
  ]
  for (let i = 1; i <= 9; i++)
    cmds.push({
      id: `tab${i}`,
      title: `Go to tab ${i}`,
      group: 'Navigation',
      when: () => false,
      run: () => {
        const t = i === 9 ? get().tabs[get().tabs.length - 1] : get().tabs[i - 1]
        if (t) focusTab(t.id)
      }
    })
  return cmds
}

function zoom(d: number): void {
  const cur = get().settings.codeFontSize
  const next = d === 0 ? 14 : Math.max(8, Math.min(32, cur + d))
  void api.updateSettings({ codeFontSize: next }).then((settings) => set({ settings }))
}

function reload(id: string, mode: 'tab' | 'split' = 'tab', splitOf?: string): void {
  addSessionToTabs(id, mode, splitOf)
}

let cache: Command[] | undefined
export function commands(): Command[] {
  return (cache ??= buildCommands())
}

export function runCommand(id: string): boolean {
  const c = commands().find((x) => x.id === id)
  if (!c) return false
  void c.run()
  return true
}
