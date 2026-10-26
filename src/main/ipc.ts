import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { uniqueFolders } from '@shared/paths'
import type { Automation, AutomationRun, BoardItem, DiffFile, DiffView, EnvironmentConfig, LaunchOptions, MeshMessageKind, MeshRole, Project, ChatRecord, Settings, SessionKind } from '@shared/types'
import type { AuthService } from './auth/authService'
import type { Scheduler } from './automations/scheduler'
import { ROUTINES_DIR, type JobService } from './jobs/jobService'
import type { ProcessService } from './processes/processService'
import type { JobDef, JobRun, JobRunOptions } from '@shared/jobs'
import { getTimeline, settings, state, toast, updateSettings, updateState } from './context'
import { loadEnvironment, saveEnvironment } from './env/environmentService'
import * as git from './git/gitService'
import * as gh from './github/ghService'
import * as repo from './git/repoService'
import { applyCommitPrefix, cleanCommitMessage, type CommitAction, type StashAction } from '@shared/repo'
import { archiveProjectChats, emitLibrary, removeChat, removeProject, updateChat, updateProject } from './library'
import type { LoadResult } from './loading/progressiveLoader'
import { runtime } from './runtime'
import { adapter } from './agents/registry'
import type { ProviderId } from '@shared/agent'
import type { SessionService } from './sessions/sessionService'
import { insights, listTranscripts, searchTranscripts } from './transcripts/transcriptService'
import { resolveAgentReply } from './appTools'
import { openInExternalEditor } from './externalEditor'
import { tsHandlers } from './lsp/tsHost'
import { run, shortId } from './util'
import * as wt from './worktrees/worktreeService'
import * as branchSync from './worktrees/branchSync'
import type { WindowManager } from './windows'
import * as updater from './updater'
import { diagLogDir, diagLogFile, logDiag, recentDiag } from './diagnostics'
import { withProgress } from './progress'
import type { DiagLevel } from '@shared/diagnostics'
import type { ReleaseInfo } from '@shared/types'
import type { ActionValues } from '@shared/actions'

type Handler = (e: IpcMainInvokeEvent, ...args: never[]) => unknown

const fileListCache = new Map<string, { at: number; files: string[] }>()

async function listProjectFiles(root: string): Promise<string[]> {
  const c = fileListCache.get(root)
  if (c && Date.now() - c.at < 30_000) return c.files
  let files: string[] = []
  const r = await run('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, timeout: 20_000 })
  if (r.code === 0) files = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  else {
    const walk = (dir: string, rel: string, depth: number): void => {
      if (depth > 6 || files.length > 20_000) return
      let ents: fs.Dirent[] = []
      try {
        ents = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'out') continue
        const r2 = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(dir, e.name), r2, depth + 1)
        else files.push(r2)
      }
    }
    walk(root, '', 0)
  }
  fileListCache.set(root, { at: Date.now(), files })
  return files
}

/** Progressive loads in flight, by the renderer-chosen load id. */
const loads = new Map<string, AbortController>()

/** Run a progressive load, sending each batch to the caller on `load:batch` as it is ready. */
async function progressive<T>(e: IpcMainInvokeEvent, loadId: string, start: (emit: (records: T[]) => void, signal: AbortSignal) => Promise<LoadResult>): Promise<LoadResult> {
  const ctl = new AbortController()
  loads.set(loadId, ctl)
  try {
    return await start((records) => {
      if (!ctl.signal.aborted && !e.sender.isDestroyed()) e.sender.send('load:batch', loadId, records)
    }, ctl.signal)
  } finally {
    loads.delete(loadId)
  }
}

const BINARY_EXT =/\.(png|jpe?g|gif|webp|bmp|ico|pdf|zip|gz|tar|7z|exe|dll|so|dylib|woff2?|ttf|otf|mp[34]|mov|avi|wasm|bin)$/i

export function registerIpc(deps: { sessions: SessionService; auth: AuthService; scheduler: Scheduler; jobs: JobService; processes: ProcessService; windows: WindowManager }): void {
  const { sessions, auth, scheduler, jobs, processes, windows } = deps
  const pendingReads = new Map<string, (text: string) => void>()

  sessions.terminalReader = (s, lines) =>
    new Promise((resolve) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.id === s.hostWindow)
      if (!win) return resolve(undefined)
      const reqId = shortId()
      const t = setTimeout(() => {
        pendingReads.delete(reqId)
        resolve(undefined)
      }, 1500)
      pendingReads.set(reqId, (text) => {
        clearTimeout(t)
        resolve(text)
      })
      win.webContents.send('term:read', reqId, s.id, lines)
    })

  const h: Record<string, Handler> = {
    // ---- app ----
    'app.init': (e) => ({
      settings: settings(),
      sessions: sessions.list(),
      auth: auth.statuses,
      library: { projects: state().projects, chats: state().chats, worktrees: state().worktrees, recentFolders: state().recentFolders },
      automations: scheduler.data(),
      jobRuns: jobs.runs(),
      processes: processes.list(),
      mesh: sessions.mesh.allGroups(),
      timeline: getTimeline().slice(-500),
      savedTabs: state().openTabs,
      windowId: e.sender.id,
      homedir: os.homedir(),
      platform: process.platform,
      version: app.getVersion(),
      agentPaths: { claude: adapter('claude').locate(), codex: adapter('codex').locate() },
      pinnedReviews: state().pinnedReviews
    }),
    'settings.update': (_e, patch: Partial<Settings>) => {
      const s = updateSettings(patch)
      windows.applySettings()
      if (patch.updates) updater.settingsChanged()
      return s
    },
    'app.quit': () => app.quit(),

    // ---- updates & version manager ----
    'update.state': () => updater.updateState(),
    'update.check': () => updater.checkForUpdates(),
    'update.download': () => updater.downloadUpdate(),
    'update.install': () => updater.installUpdate(),
    'update.releases': () => updater.listReleases(),
    'update.installVersion': (_e, rel: ReleaseInfo) => updater.installVersion(rel),
    'update.releaseHold': () => updater.releaseHold(),

    // ---- sessions ----
    'session.create': (e, kind: SessionKind, launch: LaunchOptions) => sessions.create(kind, launch, e.sender.id),
    'session.close': (_e, id: string) => sessions.close(id),
    'session.restart': (_e, id: string) => sessions.restart(id),
    'session.rename': (_e, id: string, name: string) => sessions.rename(id, name),
    'session.buffer': (_e, id: string) => sessions.buffer(id),
    'session.repaint': (_e, id: string) => sessions.repaint(id),
    'session.sendPrompt': (_e, id: string, text: string, mode?: 'steer' | 'queue') => sessions.sendPrompt(id, text, mode),
    'session.broadcast': (_e, ids: string[], text: string) => sessions.broadcastPrompt(ids, text),
    'session.setActive': (e, id: string | undefined, focused: boolean) => sessions.setActive(e.sender.id, id, focused),
    'session.openShell': (_e, parentId: string, command?: string) => sessions.openShell(parentId, command),
    'session.fork': (_e, id: string, opts: { worktree?: boolean; side?: boolean }) => sessions.fork(id, opts),
    'session.handoff': (_e, id: string) => sessions.handoff(id),
    'session.setGoal': (_e, id: string, text: string) => sessions.setGoal(id, text),
    'session.updateGoal': (_e, id: string, action: 'pause' | 'resume' | 'clear' | 'edit', text?: string) => sessions.updateGoal(id, action, text),
    'session.setRole': (_e, id: string, role: MeshRole) => sessions.setRole(id, role),
    'session.cycleMode': (_e, id: string) => sessions.cycleMode(id),
    'session.deliverMessages': (_e, id: string) => sessions.mesh.tryWake(id, true),
    'session.saveTabs': (_e, tabs: { sessionIds: string[] }[]) => sessions.saveOpenTabs(tabs),
    'session.list': () => sessions.list(),
    'session.markAllRead': () => sessions.markAllRead(),
    'session.focus': (_e, id: string) => sessions.focus(id),
    'term.readResult': (_e, reqId: string, text: string) => pendingReads.get(reqId)?.(text),

    // ---- chat (structured Claude sessions) ----
    'chat.snapshot': (_e, id: string) => sessions.chatSnapshot(id),
    'chat.send': (_e, id: string, text: string, images?: { mediaType: string; data: string }[]) => sessions.chatSend(id, text, images),
    'chat.interrupt': (_e, id: string) => sessions.chatInterrupt(id),
    'chat.permission': (_e, id: string, requestId: string, d: { allow: boolean; always?: boolean; message?: string; updatedInput?: Record<string, unknown> }) =>
      sessions.chatPermission(id, requestId, d),
    'chat.setMode': (_e, id: string, mode: string) => sessions.setMode(id, mode),
    'chat.setModel': (_e, id: string, model: string) => sessions.setModel(id, model),
    'chat.typing': (_e, id: string) => sessions.typing(id),

    // ---- files ----
    'fs.resolveDrop': async (_e, paths: string[]) => {
      const out: string[] = []
      for (const p of paths) {
        try {
          const st = await fs.promises.stat(p)
          out.push(st.isDirectory() ? p : path.dirname(p))
        } catch {
          /* ignore vanished paths */
        }
      }
      return uniqueFolders(out, process.platform === 'win32')
    },
    'fs.stat': async (_e, p: string) => {
      try {
        const st = await fs.promises.stat(p)
        return { exists: true, isDir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }
      } catch {
        return { exists: false }
      }
    },
    'fs.readFile': async (_e, p: string) => {
      const st = await fs.promises.stat(p)
      if (BINARY_EXT.test(p) || st.size > 8 * 1024 * 1024) return { binary: true, size: st.size, content: '' }
      return { binary: false, size: st.size, content: await fs.promises.readFile(p, 'utf8') }
    },
    'fs.writeFile': (_e, p: string, content: string) => fs.promises.writeFile(p, content, 'utf8'),
    'fs.listFiles': (_e, root: string) => listProjectFiles(root),
    // Find in files for the editor: git grep over tracked and untracked (not ignored) text files.
    'fs.grep': async (_e, root: string, query: string, opts: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean } = {}) => {
      if (!query) return { results: [], truncated: false }
      // Paths come back relative to `root` (the editor's project folder, which may be inside a repo).
      const args = ['grep', '-n', '-I', '--no-color', '--untracked', opts.regex ? '-E' : '-F']
      if (!opts.caseSensitive) args.push('-i')
      if (opts.wholeWord) args.push('-w')
      args.push('-e', query)
      const r = await run('git', args, { cwd: root, timeout: 20_000 })
      // git grep exits 1 for "no matches"; anything else is an error (bad regex, not a repo…).
      if (r.code > 1) throw new Error(r.stderr.trim() || 'Search failed')
      const MAX = 2000
      const lines = r.stdout.split('\n').filter(Boolean)
      const results = lines.slice(0, MAX).flatMap((l) => {
        const m = /^(.*?):(\d+):(.*)$/.exec(l)
        return m ? [{ path: m[1], line: +m[2], text: m[3].length > 300 ? m[3].slice(0, 300) + '…' : m[3] }] : []
      })
      return { results, truncated: lines.length > MAX }
    },
    'fs.saveTempImage': async (_e, dataUrl: string) => {
      const m = /^data:image\/(\w+);base64,(.*)$/.exec(dataUrl)
      if (!m) throw new Error('Not an image')
      const file = path.join(runtime.tempDir, `paste-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`)
      await fs.promises.writeFile(file, Buffer.from(m[2], 'base64'))
      return file
    },
    // A text file in the app's temp folder (e.g. the editor's unsaved version, for Claude to merge).
    'fs.saveTempText': async (_e, name: string, content: string) => {
      const file = path.join(runtime.tempDir, `${Date.now()}-${path.basename(name).replace(/[^\w.-]+/g, '_')}`)
      await fs.promises.writeFile(file, content, 'utf8')
      return file
    },
    // ---- editor TypeScript language service (ts.*; runs in a utility process) ----
    ...tsHandlers(),
    'clipboard.readImage': async () => {
      for (const item of await clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'))
        if (!type) continue
        const blob = (await item.getType(type)) as Blob
        return `data:${type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`
      }
      return undefined
    },
    'clipboard.writeImage': (_e, dataUrl: string) => {
      const png = nativeImage.createFromDataURL(dataUrl).toPNG()
      return clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    },
    'clipboard.writeText': (_e, t: string) => clipboard.writeText(t),
    'clipboard.readText': () => clipboard.readText(),
    'dialog.openFolder': async (e) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'multiSelections'] })
      return r.canceled ? [] : r.filePaths
    },
    'dialog.openFile': async (e, filters?: { name: string; extensions: string[] }[]) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters })
      return r.canceled ? undefined : r.filePaths[0]
    },
    'dialog.saveFile': async (e, defaultPath?: string) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showSaveDialog(win, { defaultPath, properties: ['showOverwriteConfirmation', 'createDirectory'] })
      return r.canceled ? undefined : r.filePath
    },
    'dialog.confirm': async (e, message: string, detail?: string, buttons: string[] = ['OK', 'Cancel']) => {
      const win = BrowserWindow.fromWebContents(e.sender)!
      const r = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1 })
      return r.response
    },
    'shell.openExternal': (_e, url: string) => {
      if (/^https?:\/\//i.test(url)) return shell.openExternal(url)
    },
    'shell.openPath': (_e, p: string) => shell.openPath(p),
    'shell.showItem': (_e, p: string) => shell.showItemInFolder(p),
    // Failures are shown here, so the many callers (file links, Review, Files…) needn't each handle them.
    'shell.openInEditor': (_e, p: string, line?: number) =>
      openInExternalEditor(p, line).catch((e: Error) => {
        logDiag('error', 'ipc:shell.openInEditor', e)
        toast(e.message, 'error')
      }),

    // ---- auth ----
    'auth.refresh': (_e, p?: ProviderId) => (p ? auth.refresh(p) : auth.refreshAll()),
    'auth.logout': (_e, p: ProviderId) => auth.logout(p),

    // ---- library ----
    'library.get': () => ({ projects: state().projects, chats: state().chats, worktrees: state().worktrees, recentFolders: state().recentFolders }),
    'library.updateProject': (_e, id: string, patch: Partial<Project>) => updateProject(id, patch),
    'library.removeProject': (_e, id: string) => removeProject(id),
    'library.updateChat': (_e, id: string, patch: Partial<ChatRecord>) => updateChat(id, patch),
    'library.archiveProjectChats': (_e, id: string) => archiveProjectChats(id),
    'library.removeChat': (_e, id: string) => removeChat(id),
    'library.addFolderToProject': (_e, id: string, folder: string) => {
      const p = state().projects.find((x) => x.id === id)
      if (p && !p.folders.includes(folder)) updateProject(id, { folders: [...p.folders, folder] })
    },
    'library.makePrimary': (_e, id: string, folder: string) => {
      const p = state().projects.find((x) => x.id === id)
      if (p) updateProject(id, { folders: [folder, ...p.folders.filter((f) => f !== folder)] })
    },
    'library.transcripts': () => listTranscripts(),
    'library.search': (_e, q: string) => searchTranscripts(q),
    'library.insights': () => insights(),
    'library.pinReview': (_e, key: string, pinned: boolean) => {
      updateState((s) => {
        s.pinnedReviews = pinned ? [...new Set([...s.pinnedReviews, key])] : s.pinnedReviews.filter((k) => k !== key)
      })
      return state().pinnedReviews
    },
    'library.viewedFiles': (_e, key: string, files?: string[]) => {
      if (files) updateState((s) => (s.viewedFiles[key] = files))
      return state().viewedFiles[key] ?? []
    },

    // ---- git ----
    'git.info': (_e, cwd: string) => git.info(cwd),
    'git.diff': (_e, cwd: string, view: DiffView, opts: { ref?: string; base?: string }) => git.diff(cwd, view, opts),
    'load.gitDiff': (e, loadId: string, cwd: string, view: DiffView, opts: { ref?: string; base?: string }) =>
      progressive(e, loadId, (emit, signal) => git.diffProgressive(cwd, view, opts, emit, signal)),
    'load.cancel': (_e, loadId: string) => loads.get(loadId)?.abort(),
    'git.applyHunk': (_e, cwd: string, file: DiffFile, idx: number, action: 'stage' | 'unstage' | 'revert') => git.applyHunk(cwd, file, idx, action),
    'git.applyFile': (_e, cwd: string, file: DiffFile, action: 'stage' | 'unstage' | 'revert') => git.applyFile(cwd, file, action),
    'git.applyAll': (_e, cwd: string, action: 'stage' | 'unstage' | 'revert') => git.applyAll(cwd, action),
    // The commit prefix is added here, at commit time, so drafted messages stay as drafted.
    'git.commit': (_e, cwd: string, msg: string, opts: { all?: boolean; amend?: boolean }) => git.commit(cwd, applyCommitPrefix(msg, settings().git.commitPrefix), opts),
    'git.push': (_e, cwd: string) => git.push(cwd),
    'git.pull': (_e, cwd: string) => git.pull(cwd),
    'git.createBranch': (_e, cwd: string, name: string) => git.createBranch(cwd, name),
    'git.switchBranch': (_e, cwd: string, name: string) => git.switchBranch(cwd, name),
    'git.branches': (_e, cwd: string) => git.branches(cwd),
    'git.commits': (_e, cwd: string) => git.recentCommits(cwd),
    'git.createPr': (_e, cwd: string, opts: { title?: string; body?: string; draft?: boolean; base?: string }) => git.createPr(cwd, opts),
    // A file's committed (HEAD) version, for the editor's Edit Diff. null: not in HEAD (new/untracked, or no repo).
    'git.fileAtHead': async (_e, file: string) => {
      const r = await run('git', ['show', `HEAD:./${path.basename(file)}`], { cwd: path.dirname(file), timeout: 15_000 })
      return r.code === 0 ? r.stdout : null
    },
    'git.generateCommitMessage': async (_e, cwd: string) => {
      const diff = await git.rawDiffForMessage(cwd)
      if (!diff.trim()) throw new Error('No changes to describe')
      const raw = await adapter().complete(
        'Write a git commit message for the changes on stdin: an imperative subject line under 72 characters, then optionally a blank line and a short body. ' +
          'Reply with the commit message text only, exactly as it should be committed: no code fences, no markdown headings, no quotes, no introduction or explanation.',
        { cwd, input: diff }
      )
      const msg = cleanCommitMessage(raw)
      if (!msg) throw new Error('The drafted commit message was empty')
      return msg
    },

    // ---- worktrees ----
    'worktree.list': () => state().worktrees,
    'worktree.delete': async (_e, id: string) => {
      await wt.deleteWorktree(id)
      emitLibrary()
    },
    'worktree.restore': (_e, id: string) => wt.restoreWorktree(id),
    'worktree.createBranch': (_e, id: string, name: string, exact?: boolean) => wt.createBranchHere(id, name, exact),
    // Chats on their own worktree branches (see worktrees/branchSync.ts).
    'branches.status': (_e, worktreeId: string) => branchSync.chatBranchStatus(worktreeId),
    'branches.merge': (_e, worktreeId: string, opts?: { stashLocal?: boolean }) => branchSync.mergeIntoTarget(worktreeId, opts),
    'branches.vsRemote': (_e, cwd: string, branch: string) => git.toplevel(cwd).then((root) => branchSync.branchVsRemote(root ?? cwd, branch)),
    'branches.push': (_e, cwd: string, branch: string) => git.toplevel(cwd).then((root) => branchSync.pushBranch(root ?? cwd, branch)),
    'worktree.createPermanent': (_e, cwd: string, name?: string) => wt.createWorktree({ repoCwd: cwd, permanent: true, name }),
    // Active branches held in the data folder (Chats view).
    'worktree.checkoutBranch': (_e, cwd: string, branch: string, opts?: { from?: string }) => wt.checkoutBranch(cwd, branch, opts),
    // Deleting from Claude Deck (Chats page). Worktrees the app made for chats are closed and removed:
    // uncommitted work is kept as a snapshot ref, and their branch's commits stay reachable from it,
    // so a deleted worktree can be restored from the Worktrees list. Chats are archived, not erased.
    //
    // A chat: the worktree(s) made to serve it go, and it's archived.
    'chat.delete': async (_e, chatId: string) => {
      const c = state().chats.find((x) => x.agentSessionId === chatId)
      if (!c) throw new Error('That chat no longer exists.')
      const own = state().worktrees.filter((w) => !w.deleted && !w.holdsBranch && !w.permanent && (w.id === c.worktreeId || w.chatId === chatId))
      for (const s of sessions.list()) if (s.agentSessionId === chatId && s.status !== 'exited') await sessions.close(s.id)
      await withProgress(`cleanup:${(own[0]?.repoRoot ?? c.cwd).toLowerCase()}`, `Deleting ${c.name}`, async (p) => {
        for (const w of own) {
          p.step(`Removing its worktree (${w.branch ?? path.basename(w.path)})…`)
          await removeChatWorktree(w.id)
        }
      })
      updateChat(chatId, { archived: true })
      emitLibrary()
    },
    // A branch (a group on the Chats page): every worktree made for its chats, its copy held in Claude
    // Deck (if any), and all its chats archived. The user's own folder and the git branch itself stay.
    'branches.remove': async (_e, projectId: string, branch: string) => {
      const project = state().projects.find((p) => p.id === projectId)
      if (!project) throw new Error('That project no longer exists.')
      const repo = ((await git.toplevel(project.folders[0])) ?? project.folders[0]).toLowerCase()
      const sameRepo = (r: string): boolean => path.resolve(r).toLowerCase() === path.resolve(repo).toLowerCase()
      const deps = state().worktrees.filter((w) => !w.deleted && !w.holdsBranch && w.target === branch && sameRepo(w.repoRoot))
      const held = state().worktrees.find((w) => !w.deleted && w.holdsBranch && w.branch === branch && sameRepo(w.repoRoot))
      const ids = new Set([...deps.map((w) => w.id), ...(held ? [held.id] : [])])
      const chats = state().chats.filter((c) => !c.archived && c.projectId === projectId && (ids.has(c.worktreeId ?? '') || (!c.worktreeId && c.branch === branch)))
      await withProgress(`cleanup:${repo}`, `Deleting ${branch} from Claude Deck`, async (p) => {
        const chatIds = new Set(chats.map((c) => c.agentSessionId))
        for (const s of sessions.list()) if (s.status !== 'exited' && ((s.worktreeId && ids.has(s.worktreeId)) || (s.agentSessionId && chatIds.has(s.agentSessionId)))) await sessions.close(s.id)
        for (const [i, w] of deps.entries()) {
          p.step(`Removing chat worktree ${i + 1} of ${deps.length}…`)
          await removeChatWorktree(w.id)
        }
        if (held) {
          p.step(`Removing ${branch}'s folder…`)
          await wt.releaseBranch(held.id, [], { force: true })
        }
      })
      for (const c of chats) updateChat(c.agentSessionId, { archived: true })
      emitLibrary()
      return { worktrees: deps.length, chats: chats.length, held: !!held }
    },
    'worktree.forget': (_e, id: string) => {
      updateState((s) => (s.worktrees = s.worktrees.filter((w) => w.id !== id)))
      emitLibrary()
    },

    // ---- environments ----
    'env.load': (_e, root: string) => loadEnvironment(root),
    'env.save': (_e, root: string, cfg: EnvironmentConfig) => saveEnvironment(root, cfg),
    'env.runAction': (_e, parentId: string, command: string) => sessions.runAction(parentId, command),

    // ---- automations ----
    'automations.get': () => scheduler.data(),
    'automations.upsert': (_e, a: Partial<Automation>) => scheduler.upsert(a),
    'automations.remove': (_e, id: string) => scheduler.remove(id),
    'automations.runNow': (_e, id: string) => scheduler.runNow(id),
    'automations.updateRun': (_e, id: string, patch: Partial<AutomationRun>) => scheduler.updateRun(id, patch),
    'automations.markAllRead': () => scheduler.markAllRead(),

    // ---- repo jobs ----
    'jobs.list': (_e, root: string) => jobs.list(root),
    'jobs.save': (_e, root: string, job: JobDef, prevSlug?: string) => jobs.save(root, job, prevSlug),
    'jobs.remove': (_e, root: string, slug: string) => jobs.remove(root, slug),
    'jobs.assist': (_e, root: string, instruction: string, current?: JobDef) => jobs.assist(root, instruction, current),
    'jobs.run': async (_e, root: string, slug: string, opts: Partial<JobRunOptions>, extra?: string) => (await jobs.start(root, slug, opts, 'manual', extra)).run,
    'jobs.stop': (_e, id: string) => jobs.stopRun(id),
    'jobs.runs': () => jobs.runs(),
    'jobs.updateRun': (_e, id: string, patch: Partial<JobRun>) => jobs.updateRun(id, patch),
    'jobs.removeRun': (_e, id: string) => jobs.removeRun(id),
    'jobs.markAllRead': () => jobs.markAllRead(),

    // ---- routines (app-level jobs, run against any repo) ----
    'routines.dir': () => ROUTINES_DIR,
    'routines.list': () => jobs.listRoutines(),
    'routines.save': (_e, job: JobDef, prevSlug?: string) => jobs.saveRoutine(job, prevSlug),
    'routines.remove': (_e, slug: string) => jobs.removeRoutine(slug),
    'routines.assist': (_e, instruction: string, current?: JobDef, cwd?: string) => jobs.assist(cwd || os.homedir(), instruction, current, { routine: true }),
    'routines.run': async (_e, root: string, slug: string, opts: Partial<JobRunOptions>, extra?: string) => (await jobs.start(root, slug, opts, 'manual', extra, 'routine')).run,

    // ---- project actions (background processes) ----
    'processes.scan': (_e, projectId: string, refresh?: boolean) => processes.scan(projectId, refresh),
    'processes.list': () => processes.list(),
    'processes.start': (_e, projectId: string, cwd: string, script: string) => processes.start(projectId, cwd, script),
    // .mono commands and package-manager commands (shared/actions.ts), run from their forms.
    'processes.tools': (_e, projectId: string, refresh?: boolean) => processes.tools(projectId, refresh),
    'processes.runAction': (_e, projectId: string, toolset: string, actionId: string, values: ActionValues) => processes.runAction(projectId, toolset, actionId, values),
    'processes.stop': (_e, id: string) => processes.stop(id),
    'processes.restart': (_e, id: string) => processes.restart(id),
    'processes.dismiss': (_e, id: string) => processes.dismiss(id),
    'processes.close': (_e, id: string) => processes.close(id),

    // ---- mesh ----
    // The mode a Claude chat starts in when Claude Deck doesn't pass one: the user's own Claude setting.
    'agent.claudeDefaultMode': async () => {
      try {
        const j = JSON.parse(await fs.promises.readFile(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'))
        return typeof j?.permissions?.defaultMode === 'string' ? j.permissions.defaultMode : null
      } catch {
        return null
      }
    },
    // The UI's answer to an agent app tool (see appTools.ts).
    'agent.reply': (_e, reqId: string, result: unknown) => resolveAgentReply(reqId, result),
    'mesh.groups': () => sessions.mesh.allGroups(),
    'mesh.send': (_e, key: string, to: string, text: string, kind?: MeshMessageKind) => sessions.mesh.userSend(key, to, text, kind),
    'mesh.board': (_e, key: string, op: 'add' | 'update' | 'delete', item: Partial<BoardItem>) => sessions.mesh.userBoard(key, op, item),
    'mesh.releaseClaim': (_e, key: string, claim: string) => sessions.mesh.userReleaseClaim(key, claim),
    'mesh.setNote': (_e, key: string, noteKey: string, value: string | null) => sessions.mesh.userSetNote(key, noteKey, value),
    'mesh.clear': (_e, key: string) => sessions.mesh.clearHistory(key),

    // ---- github ----
    'gh.list': (_e, cwd: string, filter: 'review' | 'assigned' | 'authored' | 'all') => gh.listPrs(cwd, filter),
    'gh.detail': (_e, cwd: string, n: number) => gh.prDetail(cwd, n),
    // Open PRs by others whose newest commit isn't yours: the ones you can approve (project Overview).
    'gh.approvable': (_e, cwd: string) => gh.approvablePrs(cwd),
    'gh.review': (_e, cwd: string, n: number, kind: 'approve' | 'request-changes' | 'comment', body: string) => gh.submitReview(cwd, n, kind, body),
    'gh.comment': (_e, cwd: string, n: number, body: string) => gh.comment(cwd, n, body),

    // ---- repo manager ----
    'repo.status': (_e, cwd: string) => repo.status(cwd),
    'repo.init': (_e, cwd: string) => repo.init(cwd),
    'repo.fetch': (_e, cwd: string) => repo.fetch(cwd),
    'repo.pull': (_e, cwd: string, mode?: 'rebase' | 'merge') => repo.pull(cwd, mode),
    'repo.push': (_e, cwd: string, opts?: { force?: boolean; tags?: boolean }) => repo.push(cwd, opts),
    'repo.branches': (_e, cwd: string) => repo.branchList(cwd),
    'repo.createBranch': (_e, cwd: string, name: string, opts?: { from?: string; checkout?: boolean }) => repo.createBranch(cwd, name, opts),
    'repo.checkout': (_e, cwd: string, name: string, remote?: boolean) => repo.checkout(cwd, name, remote),
    'repo.deleteBranch': (_e, cwd: string, name: string, opts?: { force?: boolean; remote?: boolean }) => repo.deleteBranch(cwd, name, opts),
    'repo.renameBranch': (_e, cwd: string, from: string, to: string) => repo.renameBranch(cwd, from, to),
    'repo.merge': (_e, cwd: string, name: string) => repo.merge(cwd, name),
    'repo.rebase': (_e, cwd: string, onto: string) => repo.rebase(cwd, onto),
    'repo.resolveOperation': (_e, cwd: string, action: 'continue' | 'abort') => repo.resolveOperation(cwd, action),
    'repo.markResolved': (_e, cwd: string, file: string) => repo.markResolved(cwd, file),
    'repo.log': (_e, cwd: string, opts?: { limit?: number; skip?: number; ref?: string }) => repo.log(cwd, opts),
    'repo.lastMessage': (_e, cwd: string) => repo.lastMessage(cwd),
    'repo.commitAction': (_e, cwd: string, sha: string, action: CommitAction) => repo.commitAction(cwd, sha, action),
    'repo.compare': (_e, cwd: string, base: string) => repo.compare(cwd, base),
    'repo.stashes': (_e, cwd: string) => repo.stashes(cwd),
    'repo.stashSave': (_e, cwd: string, message: string, opts?: { untracked?: boolean; staged?: boolean }) => repo.stashSave(cwd, message, opts),
    'repo.stashAction': (_e, cwd: string, index: number, action: StashAction) => repo.stashAction(cwd, index, action),
    'repo.stashDiff': (_e, cwd: string, index: number) => repo.stashDiff(cwd, index),
    'repo.tags': (_e, cwd: string) => repo.tags(cwd),
    'repo.createTag': (_e, cwd: string, name: string, opts?: { ref?: string; message?: string }) => repo.createTag(cwd, name, opts),
    'repo.deleteTag': (_e, cwd: string, name: string, remote?: string) => repo.deleteTag(cwd, name, remote),
    'repo.pushTag': (_e, cwd: string, name: string, remote?: string) => repo.pushTag(cwd, name, remote),
    'repo.remotes': (_e, cwd: string) => repo.remotes(cwd),
    'repo.currentPr': (_e, cwd: string) => repo.currentPr(cwd),

    // ---- personalization ----
    'instructions.read': async (_e, provider: ProviderId, root?: string) => {
      const file = adapter(provider).instructionsPath(root)
      try {
        return { file, content: await fs.promises.readFile(file, 'utf8') }
      } catch {
        return { file, content: '' }
      }
    },
    'instructions.write': async (_e, file: string, content: string) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await fs.promises.writeFile(file, content, 'utf8')
    },

    // ---- windows ----
    'window.popOut': (_e, id: string) => windows.popOut(id),
    'window.popIn': (_e, id: string) => windows.popIn(id),
    'window.devtools': (e) => e.sender.toggleDevTools(),
    'window.setTitleBarOverlay': (e, color: string, symbolColor: string) => windows.setOverlay(e.sender.id, color, symbolColor),
    'window.toggleBuddy': (_e, show: boolean) => windows.toggleBuddy(show),
    'window.focusMain': () => windows.focusMain(),
    'window.capturePageRegion': async (_e, webContentsId: number, rect: { x: number; y: number; width: number; height: number }) => {
      const { webContents } = await import('electron')
      const wc = webContents.fromId(webContentsId)
      if (!wc) throw new Error('Page is gone')
      const img = await wc.capturePage(rect)
      const file = path.join(runtime.tempDir, `page-${Date.now()}.png`)
      await fs.promises.writeFile(file, img.toPNG())
      return file
    },
    'window.registerExplorerMenu': (_e, on: boolean) => windows.registerExplorerMenu(on),
    'image.fromPath': (_e, p: string) => nativeImage.createFromPath(p).toDataURL(),

    // ---- diagnostics ----
    'diag.log': (_e, level: DiagLevel, source: string, message: string, stack?: string) => void logDiag(level, source, message, stack),
    'diag.recent': () => recentDiag(),
    'diag.logFile': () => diagLogFile(),
    'diag.openFolder': async () => {
      await fs.promises.mkdir(diagLogDir(), { recursive: true })
      return shell.openPath(diagLogDir())
    }
  }

  // Every renderer call funnels through here, so this is the one place a failing handler gets logged
  // (many call sites fire-and-forget). The error is still rethrown for the caller to handle.
  ipcMain.handle('deck:call', async (e, method: string, args: unknown[]) => {
    try {
      const fn = h[method]
      if (!fn) throw new Error(`Unknown method ${method}`)
      return await (fn as (e: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(e, ...args)
    } catch (err) {
      logDiag('error', `ipc:${method}`, err)
      throw err
    }
  })

  // Hot paths: fire-and-forget, no promise round-trip.
  ipcMain.on('deck:write', (_e, id: string, data: string) => sessions.write(id, data))
  ipcMain.on('deck:resize', (_e, id: string, cols: number, rows: number) => sessions.resize(id, cols, rows))
}

/**
 * Remove a worktree made for a chat (its work kept as a snapshot ref, restorable), and its own
 * sub-branch: the snapshot keeps that branch's commits reachable.
 */
async function removeChatWorktree(id: string): Promise<void> {
  const w = state().worktrees.find((x) => x.id === id)
  if (!w || w.deleted) return
  await wt.deleteWorktree(id)
  if (w.target && w.branch) await git.rawGit(w.repoRoot, ['branch', '-D', w.branch])
}
