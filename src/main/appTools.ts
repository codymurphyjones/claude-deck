import { BrowserWindow, dialog, type WebContents } from 'electron'
import * as path from 'path'
import { agentBrowserUrl, appToolTier, isAgentDiffView, type AppToolName } from '@shared/agentTools'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'
import type { SessionInfo } from '@shared/types'
import type { JobService } from './jobs/jobService'
import { pushTimeline, settings } from './context'
import { findProjectForFolder } from './library'
import { mainWindow, notify } from './notify/notifyService'
import type { ProcessService } from './processes/processService'
import type { SessionService } from './sessions/sessionService'
import { shortId } from './util'

// Agent tools that act on the Claude Deck app itself (served by the deck-mesh MCP server next to
// the peer-coordination tools, but they don't need a mesh group). Each returns text for the agent.
// The user stays in charge: tools open and fill in the UI; nothing is committed, run on a schedule
// or deleted behind their back, and tools that run things need the user's approval (see
// APP_TOOL_TIERS in @shared/agentTools).

export interface AppToolDeps {
  sessions: SessionService
  processes: ProcessService
  jobs: JobService
}

type Args = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
/** `v` as a number clamped to [min, max]; `def` when it's missing or not a number. */
const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
}

// ------------------------------------------------------------------ asking the UI
// Tools that drive the interface send a request to the main window and wait for its reply.

const pending = new Map<string, (r: unknown) => void>()

export function resolveAgentReply(reqId: string, result: unknown): void {
  const done = pending.get(reqId)
  if (done) done(result)
  else console.warn(`[app tools] reply for ${reqId} arrived after it timed out`)
}

/**
 * The window that answers app tools: the main window, which has the tabs, Review pane and browser.
 * A popped-out session's own window only shows its chat, so it isn't asked.
 */
function uiHost(): WebContents | undefined {
  const w = mainWindow() ?? BrowserWindow.getAllWindows().find((x) => !x.isDestroyed())
  return w && !w.webContents.isDestroyed() ? w.webContents : undefined
}

function askUi(s: SessionInfo, tool: AppToolName, args: Args, timeoutMs = 20_000): Promise<string> {
  const wc = uiHost()
  if (!wc) return Promise.resolve('No Claude Deck window is open.')
  const reqId = shortId()
  const started = Date.now()
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pending.delete(reqId)
      console.warn(`[app tools] ${tool} for session ${s.id} got no reply in ${timeoutMs} ms`)
      resolve('Claude Deck did not respond in time.')
    }, timeoutMs)
    pending.set(reqId, (r) => {
      clearTimeout(t)
      pending.delete(reqId)
      const ms = Date.now() - started
      if (ms > 5_000) console.info(`[app tools] ${tool} took ${ms} ms`)
      resolve(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
    })
    wc.send('agent:request', { reqId, sessionId: s.id, tool, args })
  })
}

/**
 * A path from the agent (absolute, or relative to its cwd) as a repo-relative, forward-slash path;
 * absolute (still forward-slashed) when it's outside the repo.
 */
function repoRel(s: SessionInfo, p: string): string {
  const abs = path.resolve(s.cwd, p)
  const rel = path.relative(s.root, abs)
  const outside = !rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  return (outside ? abs : rel).replace(/\\/g, '/')
}

// ------------------------------------------------------------------ approval
// Claude asks through its own permission prompt (confirm-tier tools aren't pre-allowed for it).
// Other providers don't prompt for MCP tools, so the app asks instead.

const allowedForSession = new Map<string, Set<AppToolName>>()

async function approved(s: SessionInfo, tool: AppToolName, what: string): Promise<boolean> {
  if (appToolTier(tool, settings().agentPermissions.appTools) !== 'confirm') return true
  if ((s.provider ?? 'claude') === 'claude') return true
  if (s.permissionMode === 'bypassPermissions') return true
  if (allowedForSession.get(s.id)?.has(tool)) return true
  const win = mainWindow()
  const opts = {
    type: 'question' as const,
    message: `${s.name} wants to ${what}`,
    detail: 'Claude Deck agent tool: ' + tool,
    buttons: ['Allow', 'Allow for this chat', 'Deny'],
    defaultId: 0,
    cancelId: 2
  }
  const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  if (response === 1) allowedForSession.set(s.id, (allowedForSession.get(s.id) ?? new Set()).add(tool))
  return response !== 2
}

// ------------------------------------------------------------------ dispatch

/** Per session: when its notify tool last fired, to keep a looping agent from spamming toasts. */
const lastNotify = new Map<string, number>()
const NOTIFY_MIN_GAP_MS = 10_000

/** One line saying what an app tool call asked for, for the Timeline. */
function describeCall(tool: AppToolName, a: Args): string {
  const q = (v: unknown): string => (str(v) ? ` ${str(v)}` : '')
  switch (tool) {
    case 'open_file':
      return `Opened${q(a.path)}${a.line ? `:${a.line}` : ''} in the editor`
    case 'show_diff':
      return `Showed${q(a.path) || ' changes'} in Review${str(a.view) ? ` (${str(a.view)})` : ''}`
    case 'request_review':
      return `Pinned ${Array.isArray(a.notes) ? a.notes.length : 0} review note(s)`
    case 'run_process':
      return `Ran script${q(a.script)}${str(a.folder) ? ` in ${str(a.folder)}` : ''}`
    case 'read_process':
      return `Read output of${q(a.script) || ' script runs'}`
    case 'open_browser':
      return `Opened${q(a.url) || ' the browser pane'} (${str(a.read) || 'text'})`
    case 'notify':
      return `Notified you:${q(a.message)}`
    case 'run_routine':
      return `Opened the run dialog for routine${q(a.routine)}`
  }
}

/**
 * Run an app tool for a session and record it in the Timeline (what it asked for, and how it went),
 * so everything an agent did to the app can be reviewed afterwards.
 */
export async function callAppTool(d: AppToolDeps, s: SessionInfo, tool: AppToolName, a: Args): Promise<string> {
  const what = describeCall(tool, a)
  const log = (outcome: string): void => {
    const line = outcome.split('\n').find((l) => l.trim()) ?? ''
    pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'agent', text: `${what}${line ? ` → ${line.length > 160 ? line.slice(0, 160) + '…' : line}` : ''}`, group: s.meshGroup })
  }
  try {
    const result = await runAppTool(d, s, tool, a)
    log(result)
    return result
  } catch (e) {
    log(`failed: ${(e as Error).message}`)
    throw e
  }
}

async function runAppTool(d: AppToolDeps, s: SessionInfo, tool: AppToolName, a: Args): Promise<string> {
  switch (tool) {
    case 'open_file':
      return d.sessions.openFileFor(s, a)

    case 'show_diff': {
      const view = str(a.view) || undefined
      if (view && !isAgentDiffView(view)) return 'view must be one of: unstaged, staged, lastTurn, branch.'
      return askUi(s, tool, { view, path: str(a.path) ? repoRel(s, str(a.path)) : undefined })
    }

    case 'request_review': {
      const view = str(a.view) || 'unstaged'
      if (!isAgentDiffView(view)) return 'view must be one of: unstaged, staged, lastTurn, branch.'
      const raw = Array.isArray(a.notes) ? (a.notes as Args[]) : []
      const notes = raw
        .map((n) => ({ path: str(n?.path) ? repoRel(s, str(n.path)) : '', line: Math.floor(num(n?.line, 0, 0, Number.MAX_SAFE_INTEGER)), text: str(n?.text) }))
        .filter((n) => n.path && n.text)
      if (!notes.length) return 'Pass at least one note: { path, line, text }.'
      return askUi(s, tool, { notes, view, summary: str(a.summary) || undefined })
    }

    case 'run_process':
      return runProcess(d, s, a)
    case 'read_process':
      return readProcess(d, s, a)

    case 'open_browser': {
      const read = str(a.read) || 'text'
      if (!['text', 'console', 'screenshot', 'all', 'none'].includes(read)) return 'read must be one of: text, console, screenshot, all, none.'
      let url: string | undefined
      if (str(a.url)) {
        const u = agentBrowserUrl(str(a.url))
        if ('error' in u) return u.error
        url = u.url
      }
      if (url && !(await approved(s, tool, `open ${url} in the browser pane and read it`))) return 'The user declined to open the page.'
      const wait = num(a.waitSeconds, 2, 0, 30)
      return askUi(s, tool, { url, read, waitSeconds: wait }, (wait + 25) * 1000)
    }

    case 'notify': {
      const message = str(a.message)
      if (!message) return 'Pass the notification text as "message".'
      const since = Date.now() - (lastNotify.get(s.id) ?? 0)
      if (since < NOTIFY_MIN_GAP_MS) return `Not sent: this chat sent a notification ${Math.round(since / 1000)}s ago. Notify only when something the user asked about happens.`
      lastNotify.set(s.id, Date.now())
      notify('agent', s, str(a.title) || s.name, message)
      return 'Notification sent.'
    }

    case 'run_routine': {
      const want = str(a.routine).toLowerCase()
      const routines = await d.jobs.listRoutines()
      if (!routines.length) return 'There are no routines yet. The user can create them in the Routines view.'
      const exact = routines.filter((r) => r.slug.toLowerCase() === want || r.name.toLowerCase() === want)
      const hits = exact.length ? exact : want ? routines.filter((r) => r.slug.toLowerCase().includes(want) || r.name.toLowerCase().includes(want)) : []
      const list = (rs: typeof routines): string => rs.map((r) => `- "${r.name}" (${r.slug})${r.description ? `: ${r.description}` : ''}`).join('\n')
      if (hits.length !== 1) return `${hits.length ? 'Several routines match' : `No routine matches "${str(a.routine)}"`}. Ask the user which one; available:\n${list(hits.length ? hits : routines)}`
      return askUi(s, tool, { slug: hits[0].slug, name: hits[0].name, cwd: s.root, context: str(a.context) || undefined })
    }
  }
  return `Unknown app tool ${tool satisfies never}`
}

// ------------------------------------------------------------------ processes

interface ScriptHit {
  pkg: ScriptPackage
  script: string
}

async function findScript(d: AppToolDeps, s: SessionInfo, script: string, folder: string): Promise<{ projectId: string; hits: ScriptHit[]; all: ScriptHit[] } | string> {
  const project = findProjectForFolder(s.root)
  if (!project) return `${s.root} isn't a Claude Deck project, so it has no script actions.`
  let pkgs = await d.processes.scan(project.id)
  const collect = (): ScriptHit[] => pkgs.flatMap((pkg) => Object.keys(pkg.scripts).map((sc) => ({ pkg, script: sc })))
  let all = collect()
  if (!all.some((h) => h.script === script)) {
    pkgs = await d.processes.scan(project.id, true)
    all = collect()
  }
  let hits = all.filter((h) => h.script === script)
  if (folder) hits = hits.filter((h) => h.pkg.rel === folder || h.pkg.name === folder || h.pkg.dir === path.resolve(s.cwd, folder))
  // The package in the session's own folder wins over nested ones.
  if (hits.length > 1) {
    const here = hits.filter((h) => path.resolve(h.pkg.dir) === path.resolve(s.cwd))
    if (here.length === 1) hits = here
  }
  return { projectId: project.id, hits, all }
}

const describeScripts = (all: ScriptHit[]): string => all.map((h) => `- ${h.script}${h.pkg.rel ? ` (in ${h.pkg.rel})` : ''}: ${h.pkg.scripts[h.script]}`).join('\n')

function processReport(d: AppToolDeps, p: ProcessInfo, lines: number): string {
  const head = `${p.command}${p.rel ? ` in ${p.rel}` : ''}: ${p.status}${p.exitCode !== undefined ? ` (exit code ${p.exitCode})` : ''}`
  const out = d.processes.output(p.id, lines)
  return `${head}\n--- last ${lines} lines of output ---\n${out || '(no output yet)'}`
}

async function runProcess(d: AppToolDeps, s: SessionInfo, a: Args): Promise<string> {
  const script = str(a.script)
  if (!script) return 'Pass the package.json script to run as "script" (e.g. "dev" or "test").'
  const found = await findScript(d, s, script, str(a.folder))
  if (typeof found === 'string') return found
  if (!found.hits.length) return `No "${script}" script here. Available scripts:\n${describeScripts(found.all) || '(none)'}`
  if (found.hits.length > 1) return `"${script}" exists in several packages; pass "folder" with one of: ${found.hits.map((h) => h.pkg.rel || '(root)').join(', ')}.`
  const { pkg } = found.hits[0]
  if (!(await approved(s, 'run_process', `run "${script}" (${pkg.scripts[script]})${pkg.rel ? ` in ${pkg.rel}` : ''}`))) return 'The user declined to run the script.'
  const running = d.processes.list().find((p) => p.cwd === pkg.dir && p.script === script && p.status === 'running')
  const p = running ? await d.processes.restart(running.id) : d.processes.start(found.projectId, pkg.dir, script)
  // Give it a moment to boot (or finish), then report what it printed.
  await d.processes.waitForExit(p.id, num(a.waitSeconds, 8, 0, 120) * 1000)
  const now = d.processes.list().find((x) => x.id === p.id) ?? p
  return `${running ? 'Restarted' : 'Started'} ${now.command}.${now.status === 'running' ? ' Still running (output so far below); use read_process to check on it later.' : ''}\n${processReport(d, now, 60)}`
}

async function readProcess(d: AppToolDeps, s: SessionInfo, a: Args): Promise<string> {
  const project = findProjectForFolder(s.root)
  const mine = d.processes.list().filter((p) => p.projectId === project?.id)
  const script = str(a.script)
  const lines = num(a.lines, 80, 5, 400)
  if (!script) {
    if (!mine.length) return 'No script runs for this project yet. Use run_process to start one.'
    return mine.map((p) => `- ${p.script}${p.rel ? ` (in ${p.rel})` : ''}: ${p.status}${p.exitCode !== undefined ? `, exit ${p.exitCode}` : ''}`).join('\n')
  }
  const folder = str(a.folder)
  const runs = mine.filter((p) => p.script === script && (!folder || p.rel === folder)).sort((x, y) => y.startedAt - x.startedAt)
  if (!runs.length) return `"${script}" hasn't been run${folder ? ` in ${folder}` : ''}. Use run_process to start it.`
  return processReport(d, runs[0], lines)
}
