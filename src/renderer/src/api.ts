import type {
  AuthStatus,
  Automation,
  AutomationRun,
  BoardItem,
  ChatRecord,
  CommitInfo,
  DiffFile,
  DiffView,
  EnvironmentConfig,
  GitInfo,
  Insights,
  LaunchOptions,
  MeshGroupState,
  MeshMessageKind,
  MeshRole,
  OpenTabState,
  Project,
  PullRequestDetail,
  PullRequestSummary,
  ReleaseInfo,
  UpdateState,
  SessionInfo,
  SessionKind,
  Settings,
  TimelineEvent,
  TranscriptSummary,
  WorktreeRecord
} from '@shared/types'
import type { ChatItem, ChatMeta } from '@shared/chat'
import type { JobDef, JobRun, JobRunOptions } from '@shared/jobs'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'

interface Bridge {
  call: (method: string, ...args: unknown[]) => Promise<unknown>
  write: (id: string, data: string) => void
  resize: (id: string, cols: number, rows: number) => void
  on: (channel: string, cb: (...args: never[]) => void) => () => void
  pathForFile: (file: File) => string
  platform: string
}

declare global {
  interface Window {
    deckBridge: Bridge
  }
}

export const bridge: Bridge = window.deckBridge

const c =
  <R, A extends unknown[] = []>(method: string) =>
  (...args: A): Promise<R> =>
    bridge.call(method, ...args) as Promise<R>

export type LiveSession = SessionInfo & { contextTokens?: number; queuedCount?: number }

export interface Library {
  projects: Project[]
  chats: ChatRecord[]
  worktrees: WorktreeRecord[]
  recentFolders: string[]
}

export interface InitData {
  settings: Settings
  sessions: LiveSession[]
  auth: AuthStatus
  library: Library
  automations: { automations: Automation[]; runs: AutomationRun[] }
  jobRuns: JobRun[]
  processes: ProcessInfo[]
  mesh: MeshGroupState[]
  timeline: TimelineEvent[]
  savedTabs: OpenTabState[]
  windowId: number
  homedir: string
  platform: string
  version: string
  claudePath: string
  pinnedReviews: string[]
}

type HunkAction = 'stage' | 'unstage' | 'revert'

export const api = {
  init: c<InitData>('app.init'),
  updateSettings: c<Settings, [Partial<Settings>]>('settings.update'),
  session: {
    create: c<LiveSession, [SessionKind, LaunchOptions]>('session.create'),
    close: c<void, [string]>('session.close'),
    restart: c<void, [string]>('session.restart'),
    rename: c<void, [string, string]>('session.rename'),
    buffer: c<string, [string]>('session.buffer'),
    repaint: c<void, [string]>('session.repaint'),
    sendPrompt: c<void, [string, string, ('steer' | 'queue')?]>('session.sendPrompt'),
    broadcast: c<void, [string[], string]>('session.broadcast'),
    setActive: c<void, [string | undefined, boolean]>('session.setActive'),
    openShell: c<LiveSession, [string, string?]>('session.openShell'),
    fork: c<LiveSession, [string, { worktree?: boolean; side?: boolean }]>('session.fork'),
    handoff: c<void, [string]>('session.handoff'),
    setGoal: c<void, [string, string]>('session.setGoal'),
    updateGoal: c<void, [string, 'pause' | 'resume' | 'clear' | 'edit', string?]>('session.updateGoal'),
    setRole: c<void, [string, MeshRole]>('session.setRole'),
    cycleMode: c<void, [string]>('session.cycleMode'),
    deliverMessages: c<boolean, [string]>('session.deliverMessages'),
    saveTabs: c<void, [{ sessionIds: string[] }[]]>('session.saveTabs'),
    readResult: c<void, [string, string]>('term.readResult'),
    markAllRead: c<void>('session.markAllRead')
  },
  fs: {
    resolveDrop: c<string[], [string[]]>('fs.resolveDrop'),
    stat: c<{ exists: boolean; isDir?: boolean; size?: number; mtime?: number }, [string]>('fs.stat'),
    readFile: c<{ binary: boolean; size: number; content: string }, [string]>('fs.readFile'),
    writeFile: c<void, [string, string]>('fs.writeFile'),
    listFiles: c<string[], [string]>('fs.listFiles'),
    saveTempImage: c<string, [string]>('fs.saveTempImage')
  },
  clipboard: {
    readImage: c<string | undefined>('clipboard.readImage'),
    writeText: c<void, [string]>('clipboard.writeText'),
    readText: c<string>('clipboard.readText')
  },
  dialog: {
    openFolder: c<string[]>('dialog.openFolder'),
    openFile: c<string | undefined, [{ name: string; extensions: string[] }[]?]>('dialog.openFile'),
    confirm: c<number, [string, string?, string[]?]>('dialog.confirm')
  },
  shell: {
    openExternal: c<void, [string]>('shell.openExternal'),
    openPath: c<string, [string]>('shell.openPath'),
    showItem: c<void, [string]>('shell.showItem'),
    openInEditor: c<void, [string, number?]>('shell.openInEditor')
  },
  auth: {
    refresh: c<AuthStatus>('auth.refresh'),
    logout: c<void>('auth.logout')
  },
  library: {
    get: c<Library>('library.get'),
    updateProject: c<void, [string, Partial<Project>]>('library.updateProject'),
    removeProject: c<void, [string]>('library.removeProject'),
    updateChat: c<void, [string, Partial<ChatRecord>]>('library.updateChat'),
    archiveProjectChats: c<void, [string]>('library.archiveProjectChats'),
    addFolderToProject: c<void, [string, string]>('library.addFolderToProject'),
    makePrimary: c<void, [string, string]>('library.makePrimary'),
    transcripts: c<TranscriptSummary[]>('library.transcripts'),
    search: c<{ claudeSessionId: string; snippet: string }[], [string]>('library.search'),
    insights: c<Insights>('library.insights'),
    pinReview: c<string[], [string, boolean]>('library.pinReview'),
    viewedFiles: c<string[], [string, string[]?]>('library.viewedFiles')
  },
  git: {
    info: c<GitInfo, [string]>('git.info'),
    diff: c<DiffFile[], [string, DiffView, { ref?: string; base?: string }]>('git.diff'),
    applyHunk: c<void, [string, DiffFile, number, HunkAction]>('git.applyHunk'),
    applyFile: c<void, [string, DiffFile, HunkAction]>('git.applyFile'),
    applyAll: c<void, [string, HunkAction]>('git.applyAll'),
    commit: c<string, [string, string, { all?: boolean; amend?: boolean }]>('git.commit'),
    push: c<string, [string]>('git.push'),
    pull: c<string, [string]>('git.pull'),
    createBranch: c<void, [string, string]>('git.createBranch'),
    switchBranch: c<void, [string, string]>('git.switchBranch'),
    branches: c<string[], [string]>('git.branches'),
    commits: c<CommitInfo[], [string]>('git.commits'),
    createPr: c<string, [string, { title?: string; body?: string; draft?: boolean; base?: string }]>('git.createPr'),
    generateCommitMessage: c<string, [string]>('git.generateCommitMessage')
  },
  worktree: {
    delete: c<void, [string]>('worktree.delete'),
    restore: c<WorktreeRecord, [string]>('worktree.restore'),
    createBranch: c<string, [string, string]>('worktree.createBranch'),
    createPermanent: c<WorktreeRecord, [string, string?]>('worktree.createPermanent'),
    forget: c<void, [string]>('worktree.forget')
  },
  env: {
    load: c<EnvironmentConfig, [string]>('env.load'),
    save: c<void, [string, EnvironmentConfig]>('env.save'),
    runAction: c<LiveSession, [string, string]>('env.runAction')
  },
  automations: {
    get: c<{ automations: Automation[]; runs: AutomationRun[] }>('automations.get'),
    upsert: c<Automation, [Partial<Automation>]>('automations.upsert'),
    remove: c<void, [string]>('automations.remove'),
    runNow: c<void, [string]>('automations.runNow'),
    updateRun: c<void, [string, Partial<AutomationRun>]>('automations.updateRun'),
    markAllRead: c<void>('automations.markAllRead')
  },
  jobs: {
    list: c<JobDef[], [string]>('jobs.list'),
    save: c<JobDef, [string, JobDef, string?]>('jobs.save'),
    remove: c<void, [string, string]>('jobs.remove'),
    assist: c<JobDef, [string, string, JobDef?]>('jobs.assist'),
    run: c<JobRun, [string, string, Partial<JobRunOptions>]>('jobs.run'),
    stop: c<void, [string]>('jobs.stop'),
    updateRun: c<void, [string, Partial<JobRun>]>('jobs.updateRun'),
    removeRun: c<void, [string]>('jobs.removeRun'),
    markAllRead: c<void>('jobs.markAllRead')
  },
  processes: {
    scan: c<ScriptPackage[], [string, boolean?]>('processes.scan'),
    list: c<ProcessInfo[]>('processes.list'),
    start: c<ProcessInfo, [string, string, string]>('processes.start'),
    stop: c<void, [string]>('processes.stop'),
    restart: c<ProcessInfo, [string]>('processes.restart'),
    dismiss: c<void, [string]>('processes.dismiss'),
    close: c<void, [string]>('processes.close')
  },
  mesh: {
    groups: c<MeshGroupState[]>('mesh.groups'),
    send: c<void, [string, string, string, MeshMessageKind?]>('mesh.send'),
    board: c<void, [string, 'add' | 'update' | 'delete', Partial<BoardItem>]>('mesh.board'),
    releaseClaim: c<void, [string, string]>('mesh.releaseClaim'),
    setNote: c<void, [string, string, string | null]>('mesh.setNote'),
    clear: c<void, [string]>('mesh.clear')
  },
  gh: {
    list: c<PullRequestSummary[], [string, 'review' | 'assigned' | 'authored' | 'all']>('gh.list'),
    detail: c<PullRequestDetail, [string, number]>('gh.detail'),
    review: c<void, [string, number, 'approve' | 'request-changes' | 'comment', string]>('gh.review'),
    comment: c<void, [string, number, string]>('gh.comment')
  },
  claudeMd: {
    read: c<{ file: string; content: string }, [string?]>('claudeMd.read'),
    write: c<void, [string, string]>('claudeMd.write')
  },
  window: {
    popOut: c<void, [string]>('window.popOut'),
    popIn: c<void, [string]>('window.popIn'),
    devtools: c<void>('window.devtools'),
    setTitleBarOverlay: c<void, [string, string]>('window.setTitleBarOverlay'),
    toggleBuddy: c<void, [boolean]>('window.toggleBuddy'),
    focusMain: c<void>('window.focusMain'),
    capturePageRegion: c<string, [number, { x: number; y: number; width: number; height: number }]>('window.capturePageRegion'),
    registerExplorerMenu: c<void, [boolean]>('window.registerExplorerMenu')
  },
  chat: {
    snapshot: c<{ items: ChatItem[]; meta: ChatMeta }, [string]>('chat.snapshot'),
    send: c<boolean, [string, string, { mediaType: string; data: string }[]?]>('chat.send'),
    interrupt: c<void, [string]>('chat.interrupt'),
    permission: c<void, [string, string, { allow: boolean; always?: boolean; message?: string; updatedInput?: Record<string, unknown> }]>('chat.permission'),
    setMode: c<void, [string, string]>('chat.setMode'),
    setModel: c<void, [string, string]>('chat.setModel'),
    typing: c<void, [string]>('chat.typing')
  },
  update: {
    state: c<UpdateState>('update.state'),
    check: c<UpdateState>('update.check'),
    download: c<void>('update.download'),
    install: c<void>('update.install'),
    releases: c<ReleaseInfo[]>('update.releases'),
    installVersion: c<void, [ReleaseInfo]>('update.installVersion'),
    releaseHold: c<void>('update.releaseHold')
  },
  focusSession: c<void, [string]>('session.focus'),
  quit: c<void>('app.quit')
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
