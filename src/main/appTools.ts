import { BrowserWindow, webContents, type WebContents } from 'electron'
import * as path from 'path'
import type { ProcessInfo, ScriptPackage } from '@shared/processes'
import type { SessionInfo } from '@shared/types'
import type { JobService } from './jobs/jobService'
import { findProjectForFolder } from './library'
import { notify } from './notify/notifyService'
import type { ProcessService } from './processes/processService'
import type { SessionService } from './sessions/sessionService'
import { shortId } from './util'

// Agent tools that act on the Claude Deck app itself (served by the deck-mesh MCP server next to
// the peer-coordination tools, but they don't need a mesh group). Each returns text for the agent.
// The user stays in charge: tools open and fill in the UI; nothing is committed, run on a schedule
// or deleted behind their back.

export const APP_TOOLS = new Set(['open_file', 'show_diff', 'request_review', 'run_process', 'read_process', 'open_browser', 'notify', 'run_routine'])

export interface AppToolDeps {
  sessions: SessionService
  processes: ProcessService
  jobs: JobService
}

type Args = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown, def: number, min: number, max: number): number => (Number.isFinite(Number(v)) && v !== undefined && v !== null && v !== '' ? Math.min(max, Math.max(min, Number(v))) : def)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ asking the UI
// Tools that drive the interface send a request to the session's window and wait for its reply.

const pending = new Map<string, (r: unknown) => void>()

export function resolveAgentReply(reqId: string, result: unknown): void {
  pending.get(reqId)?.(result)
}

function hostOf(s: SessionInfo): WebContents | undefined {
  const wc = webContents.fromId(s.hostWindow)
  if (wc && !wc.isDestroyed()) return wc
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())?.webContents
}

function askUi(s: SessionInfo, tool: string, args: Args, timeoutMs = 20_000): Promise<string> {
  const wc = hostOf(s)
  if (!wc) return Promise.resolve('No Claude Deck window is open.')
  const reqId = shortId()
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      pending.delete(reqId)
      resolve('Claude Deck did not respond in time.')
    }, timeoutMs)
    pending.set(reqId, (r) => {
      clearTimeout(t)
      pending.delete(reqId)
      resolve(typeof r === 'string' ? r : JSON.stringify(r, null, 2))
    })
    wc.send('agent:request', { reqId, sessionId: s.id, tool, args })
  })
}

/** A path from the agent (absolute, or relative to its cwd) as a repo-relative, forward-slash path. */
function repoRel(s: SessionInfo, p: string): string {
  const abs = path.resolve(s.cwd, p)
  const rel = path.relative(s.root, abs)
  return (rel.startsWith('..') ? abs : rel).replace(/\\/g, '/')
}

// ------------------------------------------------------------------ dispatch

export async function callAppTool(d: AppToolDeps, s: SessionInfo, tool: string, a: Args): Promise<string> {
  switch (tool) {
    case 'open_file':
      return d.sessions.openFileFor(s, a)

    case 'show_diff': {
      const view = str(a.view) || undefined
      if (view && !['unstaged', 'staged', 'lastTurn', 'branch'].includes(view)) return 'view must be one of: unstaged, staged, lastTurn, branch.'
      return askUi(s, tool, { view, path: str(a.path) ? repoRel(s, str(a.path)) : undefined })
    }

    case 'request_review': {
      const raw = Array.isArray(a.notes) ? (a.notes as Args[]) : []
      const notes = raw
        .map((n) => ({ path: str(n.path) ? repoRel(s, str(n.path)) : '', line: Math.floor(Number(n.line) || 0), text: str(n.text) }))
        .filter((n) => n.path && n.text)
      if (!notes.length) return 'Pass at least one note: { path, line, text }.'
      const view = str(a.view) || 'unstaged'
      return askUi(s, tool, { notes, view, summary: str(a.summary) || undefined })
    }

    case 'run_process':
      return runProcess(d, s, a)
    case 'read_process':
      return readProcess(d, s, a)

    case 'open_browser': {
      const read = str(a.read) || 'text'
      const wait = num(a.waitSeconds, 2, 0, 30)
      return askUi(s, tool, { url: str(a.url) || undefined, read, waitSeconds: wait }, (wait + 25) * 1000)
    }

    case 'notify': {
      const message = str(a.message)
      if (!message) return 'Pass the notification text as "message".'
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
  return `Unknown app tool ${tool}`
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
  const running = d.processes.list().find((p) => p.cwd === pkg.dir && p.script === script && p.status === 'running')
  const p = running ? await d.processes.restart(running.id) : d.processes.start(found.projectId, pkg.dir, script)
  // Give it a moment to boot (or finish), then report what it printed.
  const wait = num(a.waitSeconds, 8, 0, 120) * 1000
  const until = Date.now() + wait
  while (Date.now() < until && d.processes.list().find((x) => x.id === p.id)?.status === 'running') await sleep(250)
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
