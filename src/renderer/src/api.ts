import type { ProviderId } from '@shared/agent'
import type {
  AuthStatus,
  Automation,
  AutomationRun,
  BranchVsRemote,
  ChatBranchStatus,
  ChatMergeResult,
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
import type { BranchInfo, CommitAction, CurrentPr, RemoteInfo, RepoStatus, StashAction, StashInfo, TagInfo } from '@shared/repo'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'
import type { ActionValues, ToolSet } from '@shared/actions'
import type { LoadResult } from '@shared/progressive'
import type { DiagEntry, DiagLevel } from '@shared/diagnostics'

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
  auth: Record<ProviderId, AuthStatus>
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
  agentPaths: Record<ProviderId, string>
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
    grep: c<{ results: { path: string; line: number; text: string }[]; truncated: boolean }, [string, string, { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }?]>('fs.grep'),
    saveTempImage: c<string, [string]>('fs.saveTempImage'),
    saveTempText: c<string, [string, string]>('fs.saveTempText')
  },
  // Editor TypeScript language service (src/main/lsp). Offsets are into the text last sent with update.
  ts: {
    status: c<{ available: boolean; version?: string; bundled?: boolean }, [string?]>('ts.status'),
    update: c<{ available: boolean }, [string, string, string?]>('ts.update'),
    close: c<void, [string]>('ts.close'),
    diagnostics: c<import('@shared/tsLang').TsDiagnostic[] | null, [string]>('ts.diagnostics'),
    quickInfo: c<import('@shared/tsLang').TsQuickInfo | null, [string, number]>('ts.quickInfo'),
    definition: c<import('@shared/tsLang').TsLocation[] | null, [string, number]>('ts.definition'),
    completions: c<{ items: import('@shared/tsLang').TsCompletion[]; isMember: boolean } | null, [string, number, string?]>('ts.completions'),
    completionDetails: c<import('@shared/tsLang').TsCompletionDetails | null, [string, number, string, string?, unknown?]>('ts.completionDetails')
  },
  clipboard: {
    readImage: c<string | undefined>('clipboard.readImage'),
    writeImage: c<void, [string]>('clipboard.writeImage'),
    writeText: c<void, [string]>('clipboard.writeText'),
    readText: c<string>('clipboard.readText')
  },
  dialog: {
    openFolder: c<string[]>('dialog.openFolder'),
    openFile: c<string | undefined, [{ name: string; extensions: string[] }[]?]>('dialog.openFile'),
    saveFile: c<string | undefined, [string?]>('dialog.saveFile'),
    confirm: c<number, [string, string?, string[]?]>('dialog.confirm')
  },
  shell: {
    openExternal: c<void, [string]>('shell.openExternal'),
    openPath: c<string, [string]>('shell.openPath'),
    showItem: c<void, [string]>('shell.showItem'),
    openInEditor: c<void, [string, number?]>('shell.openInEditor')
  },
  auth: {
    refresh: c<AuthStatus | AuthStatus[], [ProviderId?]>('auth.refresh'),
    logout: c<void, [ProviderId]>('auth.logout')
  },
  library: {
    get: c<Library>('library.get'),
    updateProject: c<void, [string, Partial<Project>]>('library.updateProject'),
    removeProject: c<void, [string]>('library.removeProject'),
    updateChat: c<void, [string, Partial<ChatRecord>]>('library.updateChat'),
    archiveProjectChats: c<void, [string]>('library.archiveProjectChats'),
    removeChat: c<void, [string]>('library.removeChat'),
    /** Remove the worktree(s) made for a chat and archive it. */
    deleteChat: c<void, [string]>('chat.delete'),
    addFolderToProject: c<void, [string, string]>('library.addFolderToProject'),
    makePrimary: c<void, [string, string]>('library.makePrimary'),
    transcripts: c<TranscriptSummary[]>('library.transcripts'),
    search: c<{ agentSessionId: string; snippet: string }[], [string]>('library.search'),
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
    generateCommitMessage: c<string, [string]>('git.generateCommitMessage'),
    fileAtHead: c<string | null, [string]>('git.fileAtHead')
  },
  /** Progressive loads: batches arrive on `load:batch`; use loadProgressive() in ./progressive. */
  load: {
    gitDiff: c<LoadResult, [string, string, DiffView, { ref?: string; base?: string }]>('load.gitDiff')
  },
  worktree: {
    delete: c<void, [string]>('worktree.delete'),
    restore: c<WorktreeRecord, [string]>('worktree.restore'),
    createBranch: c<string, [string, string, boolean?]>('worktree.createBranch'),
    createPermanent: c<WorktreeRecord, [string, string?]>('worktree.createPermanent'),
    forget: c<void, [string]>('worktree.forget'),
    checkoutBranch: c<WorktreeRecord, [string, string, { from?: string }?]>('worktree.checkoutBranch')
  },
  branches: {
    status: c<ChatBranchStatus, [string]>('branches.status'),
    merge: c<ChatMergeResult, [string, { stashLocal?: boolean }?]>('branches.merge'),
    vsRemote: c<BranchVsRemote, [string, string]>('branches.vsRemote'),
    push: c<void, [string, string]>('branches.push'),
    /** Delete a branch from Claude Deck: its chats' worktrees, its held copy; its chats archived. */
    remove: c<{ worktrees: number; chats: number; held: boolean }, [string, string]>('branches.remove')
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
    run: c<JobRun, [string, string, Partial<JobRunOptions>, string?]>('jobs.run'),
    stop: c<void, [string]>('jobs.stop'),
    updateRun: c<void, [string, Partial<JobRun>]>('jobs.updateRun'),
    removeRun: c<void, [string]>('jobs.removeRun'),
    markAllRead: c<void>('jobs.markAllRead')
  },
  routines: {
    dir: c<string>('routines.dir'),
    list: c<JobDef[]>('routines.list'),
    save: c<JobDef, [JobDef, string?]>('routines.save'),
    remove: c<void, [string]>('routines.remove'),
    assist: c<JobDef, [string, JobDef?, string?]>('routines.assist'),
    run: c<JobRun, [string, string, Partial<JobRunOptions>, string?]>('routines.run')
  },
  processes: {
    scan: c<ScriptPackage[], [string, boolean?]>('processes.scan'),
    tools: c<ToolSet[], [string, boolean?]>('processes.tools'),
    runAction: c<ProcessInfo, [string, string, string, ActionValues]>('processes.runAction'),
    list: c<ProcessInfo[]>('processes.list'),
    start: c<ProcessInfo, [string, string, string]>('processes.start'),
    stop: c<void, [string]>('processes.stop'),
    restart: c<ProcessInfo, [string]>('processes.restart'),
    dismiss: c<void, [string]>('processes.dismiss'),
    close: c<void, [string]>('processes.close')
  },
  agent: {
    reply: c<void, [string, unknown]>('agent.reply'),
    claudeDefaultMode: c<string | null>('agent.claudeDefaultMode')
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
    approvable: c<PullRequestSummary[], [string]>('gh.approvable'),
    detail: c<PullRequestDetail, [string, number]>('gh.detail'),
    review: c<void, [string, number, 'approve' | 'request-changes' | 'comment', string]>('gh.review'),
    comment: c<void, [string, number, string]>('gh.comment')
  },
  repo: {
    status: c<RepoStatus, [string]>('repo.status'),
    init: c<void, [string]>('repo.init'),
    fetch: c<string, [string]>('repo.fetch'),
    pull: c<string, [string, ('rebase' | 'merge')?]>('repo.pull'),
    push: c<string, [string, { force?: boolean; tags?: boolean }?]>('repo.push'),
    branches: c<BranchInfo[], [string]>('repo.branches'),
    createBranch: c<void, [string, string, { from?: string; checkout?: boolean }?]>('repo.createBranch'),
    checkout: c<void, [string, string, boolean?]>('repo.checkout'),
    deleteBranch: c<void, [string, string, { force?: boolean; remote?: boolean }?]>('repo.deleteBranch'),
    renameBranch: c<void, [string, string, string]>('repo.renameBranch'),
    merge: c<string, [string, string]>('repo.merge'),
    rebase: c<string, [string, string]>('repo.rebase'),
    resolveOperation: c<void, [string, 'continue' | 'abort']>('repo.resolveOperation'),
    markResolved: c<void, [string, string]>('repo.markResolved'),
    log: c<CommitInfo[], [string, { limit?: number; skip?: number; ref?: string }?]>('repo.log'),
    lastMessage: c<string, [string]>('repo.lastMessage'),
    commitAction: c<string, [string, string, CommitAction]>('repo.commitAction'),
    compare: c<DiffFile[], [string, string]>('repo.compare'),
    stashes: c<StashInfo[], [string]>('repo.stashes'),
    stashSave: c<void, [string, string, { untracked?: boolean; staged?: boolean }?]>('repo.stashSave'),
    stashAction: c<void, [string, number, StashAction]>('repo.stashAction'),
    stashDiff: c<DiffFile[], [string, number]>('repo.stashDiff'),
    tags: c<TagInfo[], [string]>('repo.tags'),
    createTag: c<void, [string, string, { ref?: string; message?: string }?]>('repo.createTag'),
    deleteTag: c<void, [string, string, string?]>('repo.deleteTag'),
    pushTag: c<string, [string, string, string?]>('repo.pushTag'),
    remotes: c<RemoteInfo[], [string]>('repo.remotes'),
    currentPr: c<CurrentPr | null, [string]>('repo.currentPr')
  },
  instructions: {
    read: c<{ file: string; content: string }, [ProviderId, string?]>('instructions.read'),
    write: c<void, [string, string]>('instructions.write')
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
  diag: {
    log: c<void, [DiagLevel, string, string, string?]>('diag.log'),
    recent: c<DiagEntry[]>('diag.recent'),
    logFile: c<string>('diag.logFile'),
    openFolder: c<string>('diag.openFolder')
  },
  focusSession: c<void, [string]>('session.focus'),
  quit: c<void>('app.quit')
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
