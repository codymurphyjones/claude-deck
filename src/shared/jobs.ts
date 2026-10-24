// Repo jobs: multi-step prompt collections stored in <repo>/repo_jobs/<slug>/.
//
//   repo_jobs/<slug>/job.json        manifest (steps, expectations, pivots, defaults)
//   repo_jobs/<slug>/context.md      shared brief given to Claude at the start of a run
//   repo_jobs/<slug>/steps/<id>.md   the prompt for each step

import type { ProviderId } from './agent'

export const JOBS_DIR = 'repo_jobs'

/** Where a job definition lives: a repo's repo_jobs folder, or the app-level routines library (~/.claude-deck/routines). */
export type JobSource = 'repo' | 'routine'

/** Something a step must achieve. `text` is judged by Claude; `command` is run by Claude Deck and must exit 0. */
export interface JobCheck {
  kind: 'text' | 'command'
  text: string
  timeoutSec?: number
}

/** A pre-planned change of course: if `when` happens, do `then` instead of pushing through. */
export interface JobPivot {
  when: string
  then: string
}

export interface JobStep {
  id: string
  title: string
  prompt: string
  expectations: JobCheck[]
  pivots: JobPivot[]
  /** Total tries including retries after failed expectations. */
  maxAttempts: number
  onFail: 'stop' | 'continue'
  /** Start a new conversation for this step instead of continuing the previous one. */
  freshSession?: boolean
}

export type JobWorkspace = 'worktree' | 'inplace'
export type JobBranchMode = 'new' | 'direct'

export interface JobRunOptions {
  /** Branch to run against (default: the repo's current branch). */
  branch?: string
  /**
   * Start from a conversation instead of a branch: the chat's worktree folder. Its changes come
   * along, committed or not: copied into the run's worktree, or worked on in place ("Working copy").
   */
  from?: string
  workspace: JobWorkspace
  /** In a worktree: commit to a new jobs/<slug>-<id> branch, or directly onto `branch`. */
  branchMode: JobBranchMode
  /** Zero-based step index to start from. */
  fromStep?: number
  /** Run only this zero-based step. */
  onlyStep?: number
  /** Agent that runs the steps (default: settings.defaultProvider). */
  provider?: ProviderId
  model?: string
  effort?: string
  permissionMode?: string
}

export interface JobDef {
  slug: string
  name: string
  description: string
  context: string
  /** Pivots that apply to every step. */
  pivots: JobPivot[]
  steps: JobStep[]
  defaults: Partial<JobRunOptions>
}

export type JobStepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped'

export interface JobCheckResult {
  kind: JobCheck['kind']
  text: string
  ok: boolean
  output?: string
}

export interface JobStepRun {
  stepId: string
  title: string
  status: JobStepStatus
  attempts: number
  summary: string
  checks: JobCheckResult[]
  pivot?: string
  costUsd?: number
  startedAt?: number
  finishedAt?: number
}

export interface JobRun {
  id: string
  root: string
  slug: string
  jobName: string
  /** Set for runs of an app-level routine; `root` is then the target repo. */
  source?: 'routine'
  trigger: 'manual' | 'schedule'
  options: JobRunOptions
  status: 'running' | 'success' | 'failed' | 'stopped' | 'error'
  startedAt: number
  finishedAt?: number
  cwd: string
  branch?: string
  worktreePath?: string
  provider?: ProviderId
  agentSessionId?: string
  steps: JobStepRun[]
  costUsd: number
  error?: string
  unread: boolean
}

export const DEFAULT_RUN_OPTIONS: JobRunOptions = { workspace: 'worktree', branchMode: 'new' }

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'job'
  )
}

/** A step id unique among `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  const b = slugify(base) || 'step'
  if (!set.has(b)) return b
  for (let i = 2; ; i++) if (!set.has(`${b}-${i}`)) return `${b}-${i}`
}

export function newStep(title = 'New step', taken: Iterable<string> = []): JobStep {
  return { id: uniqueId(title, taken), title, prompt: '', expectations: [], pivots: [], maxAttempts: 2, onFail: 'stop' }
}

export function newJob(name = 'New job'): JobDef {
  return { slug: slugify(name), name, description: '', context: '', pivots: [], steps: [newStep('Step 1')], defaults: {} }
}

/** Coerce untrusted JSON (from disk or from Claude) into a well-formed job. */
export function normalizeJob(raw: unknown, slug?: string): JobDef {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const pivots = (v: unknown): JobPivot[] =>
    Array.isArray(v) ? v.map((p) => ({ when: str(p?.when), then: str(p?.then) })).filter((p) => p.when || p.then) : []
  const checks = (v: unknown): JobCheck[] =>
    Array.isArray(v)
      ? v
          .map((c): JobCheck => {
            if (typeof c === 'string') return { kind: 'text', text: c }
            const out: JobCheck = { kind: c?.kind === 'command' ? 'command' : 'text', text: str(c?.text) }
            if (typeof c?.timeoutSec === 'number' && c.timeoutSec > 0) out.timeoutSec = c.timeoutSec
            return out
          })
          .filter((c) => c.text.trim())
      : []
  const taken: string[] = []
  const steps = (Array.isArray(o.steps) ? o.steps : []).map((s: Record<string, unknown>, i: number): JobStep => {
    const title = str(s?.title) || `Step ${i + 1}`
    const id = uniqueId(str(s?.id) || title, taken)
    taken.push(id)
    const step: JobStep = {
      id,
      title,
      prompt: str(s?.prompt),
      expectations: checks(s?.expectations),
      pivots: pivots(s?.pivots),
      maxAttempts: Math.max(1, Math.min(10, Math.round(Number(s?.maxAttempts) || 2))),
      onFail: s?.onFail === 'continue' ? 'continue' : 'stop'
    }
    if (s?.freshSession) step.freshSession = true
    return step
  })
  const d = (o.defaults && typeof o.defaults === 'object' ? o.defaults : {}) as Record<string, unknown>
  const defaults: Partial<JobRunOptions> = {}
  if (d.workspace === 'worktree' || d.workspace === 'inplace') defaults.workspace = d.workspace
  if (d.branchMode === 'new' || d.branchMode === 'direct') defaults.branchMode = d.branchMode
  for (const k of ['branch', 'model', 'effort', 'permissionMode'] as const) if (str(d[k])) defaults[k] = str(d[k])
  if (d.provider === 'claude' || d.provider === 'codex') defaults.provider = d.provider
  const name = str(o.name) || slug || 'Untitled job'
  return { slug: slugify(slug || str(o.slug) || name), name, description: str(o.description), context: str(o.context), pivots: pivots(o.pivots), steps, defaults }
}

/** The manifest written to job.json: everything except the markdown bodies. */
export function manifestOf(job: JobDef): Record<string, unknown> {
  return {
    name: job.name,
    description: job.description,
    defaults: job.defaults,
    pivots: job.pivots,
    steps: job.steps.map(({ prompt: _p, ...s }) => s)
  }
}

export function resolveRunOptions(job: JobDef, override: Partial<JobRunOptions> = {}): JobRunOptions {
  const o = { ...DEFAULT_RUN_OPTIONS, ...job.defaults }
  for (const [k, v] of Object.entries(override)) if (v !== undefined && v !== '') (o as Record<string, unknown>)[k] = v
  return o
}

/** Zero-based indices of the steps a run will execute. */
export function stepsToRun(job: JobDef, opts: Pick<JobRunOptions, 'fromStep' | 'onlyStep'>): number[] {
  const n = job.steps.length
  if (opts.onlyStep !== undefined) return opts.onlyStep >= 0 && opts.onlyStep < n ? [opts.onlyStep] : []
  const from = Math.max(0, Math.min(n, opts.fromStep ?? 0))
  return Array.from({ length: n - from }, (_, i) => from + i)
}

const REPORT = `When you are finished, end your reply with exactly these three lines:
STEP_STATUS: done | partial | blocked
PIVOT: <number of the pivot you followed, or none>
SUMMARY: <one line describing what you did>
Use "done" only if every expectation is met, "partial" if some are not, and "blocked" if the step cannot be completed at all.`

function numbered<T>(items: T[], fmt: (x: T) => string): string {
  return items.map((x, i) => `${i + 1}. ${fmt(x)}`).join('\n')
}

export function stepPivots(job: JobDef, step: JobStep): JobPivot[] {
  return [...step.pivots, ...job.pivots]
}

const RUN_CONTEXT =
  'Specific to this run. It refines the routine; where it limits scope (particular files, components, areas), stay strictly within it and leave everything else untouched.'

function runContext(extra?: string): string | undefined {
  return extra?.trim() ? `## Run context\n${RUN_CONTEXT}\n\n${extra.trim()}` : undefined
}

/** The prompt sent to Claude for one step. `withContext` on the first step of a conversation. */
export function buildStepPrompt(job: JobDef, index: number, opts: { withContext: boolean; extra?: string; source?: JobSource }): string {
  const step = job.steps[index]
  const parts: string[] = []
  if (opts.withContext) {
    const routine = opts.source === 'routine'
    parts.push(
      routine
        ? `You are running the routine "${job.name}", a reusable app-level routine applied to this repository. It has ${job.steps.length} step(s); they are given to you one at a time.`
        : `You are running the repo job "${job.name}" (repo_jobs/${job.slug}). It has ${job.steps.length} step(s); they are given to you one at a time.`
    )
    if (job.description.trim()) parts.push(`Job goal: ${job.description.trim()}`)
    if (job.context.trim()) parts.push(`## Job context\n${job.context.trim()}`)
    if (routine) {
      const rc = runContext(opts.extra)
      if (rc) parts.push(rc)
    } else if (opts.extra?.trim()) parts.push(`## Trigger details\n${opts.extra.trim()}`)
  }
  parts.push(`## Step ${index + 1} of ${job.steps.length}: ${step.title}\n${step.prompt.trim() || '(No further instructions.)'}`)
  if (step.expectations.length)
    parts.push(
      `## Expectations\nThis step is checked against these when you finish:\n${numbered(step.expectations, (c) =>
        c.kind === 'command' ? `The command \`${c.text}\` must exit with code 0 (Claude Deck runs it after you finish).` : c.text
      )}`
    )
  const pivots = stepPivots(job, step)
  if (pivots.length)
    parts.push(`## Pivots\nIf one of these situations comes up, follow its instruction instead of pushing through:\n${numbered(pivots, (p) => `If ${p.when.trim()} → ${p.then.trim()}`)}`)
  parts.push(`## Reporting\n${REPORT}`)
  return parts.join('\n\n')
}

/**
 * What a routine run is called: "<Project> - <Routine>", so the same routine run on several
 * projects can be told apart. The project is the library project's name, else the folder's name.
 */
export function routineRunName(routineName: string, project: string | undefined): string {
  const p = project?.trim()
  return p ? `${p} - ${routineName}` : routineName
}

/** A routine composed into one message, for running it interactively in a chat. */
export function buildRoutineChatPrompt(job: JobDef, extra?: string): string {
  const parts: string[] = [`Run the routine "${job.name}" on this repository.`]
  if (job.description.trim()) parts.push(`Goal: ${job.description.trim()}`)
  if (job.context.trim()) parts.push(`## Context\n${job.context.trim()}`)
  const rc = runContext(extra)
  if (rc) parts.push(rc)
  job.steps.forEach((s, i) => {
    const sec = [`## Step ${i + 1} of ${job.steps.length}: ${s.title}\n${s.prompt.trim() || '(No further instructions.)'}`]
    if (s.expectations.length)
      sec.push(`Done when:\n${s.expectations.map((c) => `- [ ] ${c.kind === 'command' ? `\`${c.text}\` exits with code 0` : c.text}`).join('\n')}`)
    if (s.pivots.length) sec.push(`Pivots:\n${s.pivots.map((p) => `- If ${p.when.trim()} → ${p.then.trim()}`).join('\n')}`)
    parts.push(sec.join('\n\n'))
  })
  if (job.pivots.length) parts.push(`## Pivots (any step)\n${numbered(job.pivots, (p) => `If ${p.when.trim()} → ${p.then.trim()}`)}`)
  parts.push(
    job.steps.length > 1
      ? 'Work through the steps in order. When you finish, summarise what you did and how each step measures up against its "done when" list.'
      : 'When you finish, summarise what you did and how it measures up against the "done when" list.'
  )
  return parts.join('\n\n')
}

/** Follow-up sent in the same conversation when a step's expectations were not met. */
export function buildRetryPrompt(job: JobDef, index: number, attempt: number, failures: string[]): string {
  const step = job.steps[index]
  const hasPivots = stepPivots(job, step).length > 0
  return [
    `Step ${index + 1} ("${step.title}") is not complete yet. This is attempt ${attempt} of ${step.maxAttempts}.`,
    `What failed:\n${failures.map((f) => `- ${f}`).join('\n')}`,
    `Fix the problems and finish the step.${hasPivots ? ' If the original approach is not working, consider the pivots listed earlier.' : ''}`,
    REPORT
  ].join('\n\n')
}

export interface StepReport {
  status: 'done' | 'partial' | 'blocked' | 'unknown'
  pivot?: number
  summary: string
}

/** Parse the trailing STEP_STATUS / PIVOT / SUMMARY lines of Claude's reply. */
export function parseStepReport(text: string): StepReport {
  const last = (re: RegExp): string | undefined => {
    let m: RegExpExecArray | null
    let out: string | undefined
    const g = new RegExp(re.source, 'gim')
    while ((m = g.exec(text))) out = m[1].trim()
    return out
  }
  const raw = last(/^\W*STEP_STATUS:\s*\**\s*([a-z]+)/)?.toLowerCase()
  const status = raw === 'done' || raw === 'partial' || raw === 'blocked' ? raw : 'unknown'
  const pv = last(/^\W*PIVOT:\s*\**\s*(\S+)/)
  const pivot = pv && /^\d+$/.test(pv) ? +pv : undefined
  const summary = last(/^\W*SUMMARY:\s*\**\s*(.+)$/)?.replace(/\*+$/, '').trim() ?? ''
  return { status, pivot, summary }
}

export function jobRunBranchName(slug: string, runId: string): string {
  return `jobs/${slug}-${runId.slice(-6)}`
}

/** Brief for an interactive chat that helps the user design jobs by editing files directly. */
export function jobDesignBrief(): string {
  return `You are helping the user design "repo jobs" for Claude Deck. A job is a multi-step task order stored in the repository:

${JOBS_DIR}/<slug>/job.json        manifest
${JOBS_DIR}/<slug>/context.md      shared brief given at the start of every run (optional)
${JOBS_DIR}/<slug>/steps/<id>.md   the prompt for each step, one file per step

job.json shape:
{
  "name": "Human readable name",
  "description": "One-paragraph goal of the whole job",
  "defaults": { "workspace": "worktree" | "inplace", "branchMode": "new" | "direct", "branch"?: "...", "model"?: "...", "effort"?: "...", "permissionMode"?: "acceptEdits" | "auto" | "plan" | "bypassPermissions" },
  "pivots": [ { "when": "situation", "then": "what to do instead" } ],          // apply to every step
  "steps": [
    {
      "id": "kebab-id",                       // matches steps/<id>.md
      "title": "Short step title",
      "expectations": [ { "kind": "text", "text": "verifiable outcome" }, { "kind": "command", "text": "npm test", "timeoutSec": 600 } ],
      "pivots": [ { "when": "...", "then": "..." } ],
      "maxAttempts": 2,                       // retries when expectations fail
      "onFail": "stop" | "continue",
      "freshSession": false                   // true = new conversation for this step
    }
  ]
}

Steps run in order, normally in one continuing conversation, so later steps can build on earlier ones. After each step Claude Deck runs every "command" expectation; failures are fed back for another attempt. Good jobs:
- split work into small, verifiable steps (investigate → plan → implement → verify → document)
- give each step concrete expectations, preferring command checks (tests, type checks, builds) where possible
- anticipate likely obstacles with pivots (e.g. "if the API is missing → add a minimal shim and note it")
- keep prompts self-contained and specific to this repository; read the codebase first.

Ask clarifying questions when the goal is ambiguous, then write or update the files directly.`
}

const ROUTINE_NOTE = `This is a ROUTINE: an app-level job reused across many different repositories, with run-specific context added each time (e.g. which area to focus on). Keep it repo-agnostic: don't hard-code paths, names or commands from one codebase; describe what to look for instead (e.g. "find the project's test command and run it"). Prefer "text" expectations unless a command is universal.`

/** Brief for a chat that designs routines by editing files in the routines library (the chat's working folder). */
export function routineDesignBrief(): string {
  return `${jobDesignBrief().replace(/"repo jobs"/g, '"routines"').split(`${JOBS_DIR}/`).join('')}

${ROUTINE_NOTE}
The current folder is the routines library: each routine is a folder <slug>/ holding job.json, context.md and steps/<id>.md.`
}

/** Prompt for one-shot drafting/revising a job as JSON. */
export function jobAssistPrompt(instruction: string, current?: JobDef, opts: { routine?: boolean } = {}): string {
  return `${jobDesignBrief()}
${opts.routine ? `\n${ROUTINE_NOTE}\n` : ''}
Instead of writing files, reply with ONLY a single JSON object (no code fence, no commentary) describing the whole job. It uses the job.json shape above, except each step also has a "prompt" field with its full markdown prompt, and the top level also has a "context" field with the shared brief.
Explore the repository as needed so the steps, expectations (including real test/build commands for this repo) and pivots are concrete.

${current ? `Current job:\n${JSON.stringify({ ...manifestOf(current), context: current.context, steps: current.steps }, null, 2)}\n\nRevise it as follows:\n${instruction}` : `Design a job for:\n${instruction}`}`
}

/** Pull the first top-level JSON object out of a model reply. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const src = fenced ? fenced[1] : text
  const start = src.indexOf('{')
  if (start < 0) throw new Error('No JSON object in reply')
  let depth = 0
  let inStr = false
  for (let i = start; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === '\\') i++
      else if (ch === '"') inStr = false
    } else if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return JSON.parse(src.slice(start, i + 1))
  }
  throw new Error('Unterminated JSON object in reply')
}
