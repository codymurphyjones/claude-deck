// First: picks the profile's userData folder before anything reads app paths or takes the lock.
import { profileName } from './profile'
import { app, BrowserWindow, Menu, nativeTheme, net, protocol } from 'electron'
import { installProcessDiagnostics } from './diagnostics'
import * as fs from 'fs'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { AuthService } from './auth/authService'
import { Scheduler } from './automations/scheduler'
import { broadcast, flushStores, initStores, settings, state } from './context'
import { ControlServer } from './control/server'
import { registerIpc } from './ipc'
import { PtyService } from './pty/ptyService'
import { SessionService } from './sessions/sessionService'
import { WindowManager } from './windows'
import { initUpdater, stopUpdater } from './updater'
import { JobService } from './jobs/jobService'
import { ProcessService } from './processes/processService'
import { isAppTool } from '@shared/agentTools'
import { callAppTool } from './appTools'
import { MergedWorktreeCleanup } from './worktrees/mergedCleanup'
import { HeadWatcher } from './git/headWatcher'
import { setWorktreeSource } from './git/pushGuard'
import { onLibraryChanged } from './library'

// If Claude Deck was launched from inside a Claude Code session, don't let that
// session's identity leak into the sessions we start (it disables transcripts etc.).
for (const k of Object.keys(process.env))
  if (
    k === 'CLAUDECODE' ||
    k === 'CLAUDE_PID' ||
    k === 'AI_AGENT' ||
    k === 'CLAUDE_EFFORT' ||
    /^CLAUDE_CODE_(CHILD_SESSION|SESSION_ID|SESSION_ATTENDED|ENTRYPOINT|EXECPATH|MESSAGING_|SSE_PORT)/.test(k)
  )
    delete process.env[k]

protocol.registerSchemesAsPrivileged([
  { scheme: 'deck-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  installProcessDiagnostics()
  // A separate taskbar identity and a "(dev)"-style title keep a profile window distinguishable from the installed app.
  app.setAppUserModelId(profileName ? `com.magerx.claudedeck.${profileName.toLowerCase().replace(/[^a-z0-9]+/g, '')}` : 'com.magerx.claudedeck')
  const titleSuffix = profileName ? ` (${profileName.toLowerCase()})` : ''
  if (titleSuffix)
    app.on('browser-window-created', (_e, w) =>
      w.on('page-title-updated', (ev, title) => {
        ev.preventDefault()
        w.setTitle(title + titleSuffix)
      })
    )

  /** Folder/file paths passed on the command line (Explorer menu, "Open with"). */
  const pathArgs = (argv: string[]): string[] =>
    argv
      .slice(app.isPackaged ? 1 : 2)
      .filter((a) => !a.startsWith('-') && a !== '.' && path.isAbsolute(a))
      .filter((a) => {
        try {
          return fs.existsSync(a) && path.resolve(a) !== path.resolve(app.getAppPath())
        } catch {
          return false
        }
      })

  let windows: WindowManager | undefined
  let pendingOpen: string[] = pathArgs(process.argv)

  app.on('second-instance', (_e, argv) => {
    const paths = pathArgs(argv)
    windows?.focusMain()
    if (paths.length) broadcast('app:openPaths', paths)
  })

  app.whenReady().then(async () => {
    // No application menu: its accelerators (Ctrl+W, Ctrl+R…) would fight the app's shortcuts.
    Menu.setApplicationMenu(null)
    initStores()
    protocol.handle('deck-file', (req) => {
      // deck-file://local/<absolute path> — local file previews for the renderer.
      const u = new URL(req.url)
      let p = decodeURIComponent(u.pathname)
      if (process.platform === 'win32') p = p.replace(/^\/([A-Za-z]:)/, '$1')
      return net.fetch(pathToFileURL(p).toString())
    })

    const pty = new PtyService()
    const auth = new AuthService()
    const sessions = new SessionService(pty, auth)
    const jobs = new JobService()
    const processes = new ProcessService(pty)
    const scheduler = new Scheduler(sessions, jobs)
    windows = new WindowManager(sessions)
    windows.hasBackgroundWork = () => jobs.busy() || processes.busy() || scheduler.data().automations.some((a) => a.status === 'active')

    const control = new ControlServer()
    control.on('hook', (sid, params) => sessions.handleHook(sid, params as never))
    control.on('mesh', async (sid, params) => {
      const s = sessions.get(sid)
      if (!s) return 'Unknown session'
      const { tool, args } = params as { tool: string; args: Record<string, unknown> }
      // App tools work without a mesh group; the rest coordinate peers.
      if (isAppTool(tool)) return callAppTool({ sessions, processes, jobs }, s, tool, args ?? {})
      return sessions.mesh.callTool(s, tool, args ?? {})
    })
    await control.start()

    // Every push checks that it isn't publishing a chat's worktree branch (git/pushGuard.ts).
    setWorktreeSource(() => state().worktrees)
    registerIpc({ sessions, auth, scheduler, jobs, processes, windows })
    const win = windows.createMain()
    sessions.defaultHost = win.webContents.id
    win.webContents.once('did-finish-load', () => {
      if (pendingOpen.length) broadcast('app:openPaths', pendingOpen)
      pendingOpen = []
    })
    nativeTheme.on('updated', () => broadcast('theme:system', nativeTheme.shouldUseDarkColors))
    if (settings().buddy) windows.toggleBuddy(true)

    void auth.refreshAll()
    scheduler.start()
    const mergedCleanup = new MergedWorktreeCleanup((w) => sessions.isWorktreeProtected(w.id))
    mergedCleanup.start()
    // Each project folder's (and Claude Deck-held branch's) checked-out branch, followed live.
    const heads = new HeadWatcher((folder, branch) => sessions.folderBranchChanged(folder, branch))
    const watchFolders = (): string[] => [...state().projects.flatMap((p) => p.folders), ...state().worktrees.filter((w) => w.holdsBranch && !w.deleted).map((w) => w.path)]
    void heads.sync(watchFolders())
    onLibraryChanged(() => void heads.sync(watchFolders()))
    initUpdater()

    app.on('before-quit', () => {
      if (windows) windows.quitting = true
      scheduler.stop()
      mergedCleanup.stop()
      heads.stop()
      jobs.stop()
      processes.stopAll()
      stopUpdater()
      pty.killAll()
      control.stop()
      flushStores()
    })
  })

  app.on('window-all-closed', () => {
    if (!windows || windows.quitting || !windows.hasBackgroundWork()) app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windows?.focusMain()
  })
}
