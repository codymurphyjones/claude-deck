import * as os from 'os'
import * as path from 'path'
import { PROVIDERS } from '@shared/agent'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { locateBinary } from '../../runtime'
import { plainEnv } from '../../sessions/launch'
import { run, spawnLines } from '../../util'
import type { AgentAdapter, HeadlessOptions, HeadlessResult } from '../types'
import { CodexChat } from './chat'
import { codexHistory, codexHome } from './history'
import { modePolicy } from './policy'

type Json = Record<string, unknown>

function locate(): string {
  const home = os.homedir()
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined
  return locateBinary('codex', settings().providers.codex.path, [
    // Prefer the native binary the npm package ships: .cmd shims mangle quoted arguments.
    npm ? path.join(npm, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe') : undefined,
    npm ? path.join(npm, 'codex.cmd') : undefined,
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : undefined
  ])
}

/** `codex exec` flags for an unattended run (approvals can't be answered, so never ask). */
function execArgs(opts: { model?: string; effort?: string; permissionMode?: string }): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  const model = opts.model || settings().providers.codex.defaultModel
  if (model) args.push('--model', model)
  if (opts.effort) args.push('-c', `model_reasoning_effort=${opts.effort}`)
  const mode = opts.permissionMode || 'acceptEdits'
  if (mode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox')
  else args.push('--sandbox', modePolicy(mode).sandbox ?? 'workspace-write')
  return args
}

/** Run `codex exec --json` unattended; the prompt goes over stdin. */
function headless(opts: HeadlessOptions): { done: Promise<HeadlessResult>; kill: () => void } {
  const args = execArgs(opts)
  if (opts.extraArgs) args.push(...opts.extraArgs)
  if (opts.resumeId) args.push('resume', opts.resumeId)
  args.push('-')
  const res: HeadlessResult = { code: 0, text: '', isError: false, finished: false }
  const proc = spawnLines(locate(), args, {
    cwd: opts.cwd,
    env: plainEnv(),
    input: opts.prompt,
    onLine: (line) => {
      let j: Json
      try {
        j = JSON.parse(line)
      } catch {
        return
      }
      const id = (j.thread_id ?? j.session_id) as string | undefined
      if (j.type === 'thread.started' && id && id !== res.sessionId) {
        res.sessionId = id
        opts.onSession?.(id)
      } else if (j.type === 'item.completed' && (j.item as Json | undefined)?.type === 'agent_message') res.text = String((j.item as Json).text ?? res.text)
      else if (j.type === 'turn.completed') res.finished = true
      else if (j.type === 'turn.failed' || j.type === 'error') {
        res.finished = true
        res.isError = true
        res.text = String(((j.error as Json | undefined)?.message ?? j.message ?? res.text) || 'Codex failed')
      }
    }
  })
  return {
    kill: proc.kill,
    done: proc.done.then((code) => {
      res.code = code
      if (code !== 0 && !res.finished) res.isError = true
      return res
    })
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  descriptor: PROVIDERS.codex,
  locate,
  createChat: (s: SessionInfo) => new CodexChat(locate(), s),
  headless,
  async complete(prompt, opts) {
    const h = headless({ prompt: opts.input ? `${prompt}\n\n${opts.input}` : prompt, cwd: opts.cwd, model: opts.model || PROVIDERS.codex.fastModel, permissionMode: 'plan' })
    const r = await h.done
    if (r.isError || !r.text.trim()) throw new Error(r.text.trim() || 'Codex could not complete the request')
    return r.text.trim()
  },
  history: codexHistory,
  auth: {
    async status() {
      const r = await run(locate(), ['login', 'status'], { timeout: 30_000 })
      const out = `${r.stdout}\n${r.stderr}`.trim()
      if (r.code === 0 && /logged in/i.test(out) && !/not logged in/i.test(out)) {
        const method = /api key/i.test(out) ? 'api-key' : /chatgpt/i.test(out) ? 'chatgpt' : undefined
        return { checked: true, loggedIn: true, authMethod: method }
      }
      if (process.env.OPENAI_API_KEY) return { checked: true, loggedIn: true, authMethod: 'api-key' }
      return { checked: true, loggedIn: false, error: out.slice(0, 300) || undefined }
    },
    loginArgs: () => ['login'],
    async logout() {
      await run(locate(), ['logout'], { timeout: 30_000 })
    }
  },
  instructionsPath: (root) => (root ? path.join(root, 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md'))
}
