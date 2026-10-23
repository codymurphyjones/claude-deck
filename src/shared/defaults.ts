import type { Settings } from './types'

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  palette: 'Ctrl+K',
  newSession: 'Ctrl+T',
  newWorktreeSession: 'Ctrl+Shift+N',
  quickChat: 'Ctrl+Alt+N',
  closeTab: 'Ctrl+W',
  reopenClosed: 'Ctrl+Shift+T',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  settings: 'Ctrl+,',
  toggleSidebar: 'Ctrl+B',
  toggleShell: 'Ctrl+`',
  toggleReview: 'Ctrl+Shift+G',
  toggleFiles: 'Ctrl+Shift+E',
  toggleTeam: 'Ctrl+Shift+Y',
  toggleActivity: 'Ctrl+Alt+U',
  toggleBrowser: 'Ctrl+Alt+B',
  toggleTimeline: 'Ctrl+Alt+L',
  composer: 'Ctrl+Shift+Enter',
  deliverMessages: 'Ctrl+Shift+M',
  find: 'Ctrl+F',
  findInTerminal: 'Ctrl+Shift+F',
  splitRight: 'Ctrl+Shift+D',
  sideChat: 'Ctrl+Alt+S',
  forkChat: 'Ctrl+Alt+F',
  broadcast: 'Ctrl+Shift+B',
  popOut: 'Ctrl+Alt+P',
  cycleMode: 'Ctrl+Alt+M',
  setGoal: 'Ctrl+Alt+G',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  zoomReset: 'Ctrl+0',
  focusNextPane: 'Ctrl+Alt+Right',
  focusPrevPane: 'Ctrl+Alt+Left',
  scheduled: 'Ctrl+Alt+T',
  reviews: 'Ctrl+Alt+R'
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'dark',
  darkTheme: 'deck-dark',
  lightTheme: 'deck-light',
  contrast: 0,
  uiFont: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  codeFont: '"Cascadia Mono", "Cascadia Code", Consolas, "Courier New", monospace',
  uiFontSize: 13,
  codeFontSize: 14,
  translucentSidebar: true,
  pointerCursors: true,
  copyOnSelect: false,
  scrollback: 10000,
  notifications: { turnComplete: 'background', permission: true, question: true, sound: true },
  preventSleep: true,
  followUp: 'steer',
  composerEnter: 'enter',
  defaultProvider: 'claude',
  providers: {
    claude: { path: '', defaultModel: '', defaultEffort: '', defaultPermissionMode: '' },
    codex: { path: '', defaultModel: '', defaultEffort: '', defaultPermissionMode: '' }
  },
  shell: '',
  worktrees: { root: '', keep: 15, autoDelete: true, branchPrefix: 'claude/', cleanupMerged: true, deleteRemoteMerged: true },
  mesh: {
    enabled: true,
    claimMode: 'ask',
    autoWake: true,
    autoWakeIdleMs: 8000,
    repoPeers: true,
    staleReadGuard: true
  },
  shortcuts: {},
  restoreSessions: 'ask',
  autoOpenFiles: false,
  alwaysOnTop: false,
  buddy: false,
  sessionTemplates: [
    { id: 'tpl-plan', name: 'Plan first', permissionMode: 'plan' },
    { id: 'tpl-edits', name: 'Accept edits', permissionMode: 'acceptEdits' },
    { id: 'tpl-reviewer', name: 'Reviewer', role: 'reviewer', permissionMode: 'plan' },
    { id: 'tpl-lead', name: 'Team lead', role: 'lead' }
  ],
  promptTemplates: [
    { id: 'pt-tests', name: 'Write tests', text: 'Write thorough tests for the code I just changed, run them, and fix any failures.' },
    { id: 'pt-explain', name: 'Explain this repo', text: 'Give me a concise tour of this codebase: architecture, key modules, and how data flows.' },
    { id: 'pt-review', name: 'Review my changes', text: '/review' }
  ],
  customThemes: [],
  reviewInstructions: '',
  goalMaxIterations: 25,
  showTimeline: false,
  chat: {
    uiAwareness: true,
    renderingGuidance: '',
    density: 'comfortable',
    width: 'wide',
    thinking: 'collapsed',
    tools: 'grouped',
    fontSize: 14,
    sendKey: 'enter'
  },
  updates: { channel: 'stable', auto: true }
}

export const MESH_COLORS = ['#e8a54b', '#5fb3f9', '#b78bf7', '#4cc38a', '#f06a8a', '#3fd0c9', '#f2cc60', '#9aa4ff']
