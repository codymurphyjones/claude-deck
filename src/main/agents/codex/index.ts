import * as os from 'os'
import * as path from 'path'
import { PROVIDERS } from '@shared/agent'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { locateBinary } from '../../runtime'
import { plainEnv } from '../../sessions/launch'
import { pushBlockEnv } from '../../git/pushGuard'
import { run, spawnLines } from '../../util'
import type { AgentAdapter, HeadlessOptions, HeadlessResult } from '../types'
import { CodexChat } from './chat'
import { AppServer } from './appServer'
import * as fs from 'fs'
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
function execArgs(opts: { model?: string; effort?: string; permissionMode?: string; cwd?: string }): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check']
  const model = opts.model || settings().providers.codex.defaultModel
  if (model) args.push('--model', model)
  if (opts.effort) args.push('-c', `model_reasoning_effort=${opts.effort}`)
  const mode = opts.permissionMode || 'acceptEdits'
  if (mode === 'bypassPermissions') args.push('--dangerously-bypass-approvals-and-sandbox')
  else args.push('--sandbox', modePolicy(mode).sandbox ?? 'workspace-write')
  // In a chat's worktree: the push block (git/pushGuard.ts), set explicitly in Codex's shell environment
  // so its filtering (which can drop GIT_CONFIG_KEY_n) can't remove it. A TOML inline table.
  const block = opts.cwd ? pushBlockEnv(opts.cwd) : {}
  if (Object.keys(block).length) args.push('-c', `shell_environment_policy.set={${Object.entries(block).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}}`)
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
    env: plainEnv(opts.cwd),
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

/**
 * The signed-in ChatGPT account's email and plan, from the ID token Codex saved (auth.json). Read
 * only, nothing sent anywhere; nothing when signed in with an API key or the file isn't readable.
 */
function accountInfo(): { email?: string; subscriptionType?: string } {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8')) as { tokens?: { id_token?: string } }
    const payload = auth.tokens?.id_token?.split('.')[1]
    if (!payload) return {}
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
    const openai = (claims['https://api.openai.com/auth'] ?? {}) as Record<string, unknown>
    return {
      email: typeof claims.email === 'string' ? claims.email : undefined,
      subscriptionType: typeof openai.chatgpt_plan_type === 'string' ? openai.chatgpt_plan_type : undefined
    }
  } catch {
    return {}
  }
}

let modelCache: { models: [string, string][]; efforts: string[] } | undefined
/**
 * The models Codex offers now (`model/list` on a short-lived app-server), with their efforts. Cached
 * for the session; undefined when Codex isn't installed or doesn't answer, so the built-in list is used.
 */
async function listModels(): Promise<{ models: [string, string][]; efforts: string[] } | undefined> {
  if (modelCache) return modelCache
  const server = new AppServer()
  try {
    server.start(locate(), [], { cwd: os.homedir(), env: plainEnv() })
    const ask = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), 15_000))])
    await ask(server.request('initialize', { clientInfo: { name: 'claude_deck', title: 'Claude Deck', version: '0' } }))
    server.notify('initialized')
    const res = await ask(server.request<{ data?: { model: string; displayName?: string; hidden?: boolean; supportedReasoningEfforts?: { reasoningEffort: string }[] }[] }>('model/list', { includeHidden: false }))
    const list = (res.data ?? []).filter((m) => !m.hidden && m.model)
    if (!list.length) return undefined
    const efforts = [...new Set(list.flatMap((m) => (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort)))]
    modelCache = { models: [['', 'Default'], ...list.map((m) => [m.model, m.displayName || m.model] as [string, string])], efforts: ['', ...efforts] }
    return modelCache
  } catch {
    return undefined
  } finally {
    server.kill()
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  descriptor: PROVIDERS.codex,
  locate,
  createChat: (s: SessionInfo) => new CodexChat(locate(), s),
  headless,
  listModels,
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
        return { checked: true, loggedIn: true, authMethod: method, ...accountInfo() }
      }
      if (process.env.OPENAI_API_KEY) return { checked: true, loggedIn: true, authMethod: 'api-key' }
      return { checked: true, loggedIn: false, error: out.slice(0, 300) || undefined }
    },
    // Device code: for machines where the browser sign-in can't reach back (remote, headless).
    loginArgs: (opts = {}) => (opts.device ? ['login', '--device-auth'] : ['login']),
    async loginWithApiKey(key: string) {
      const r = await run(locate(), ['login', '--with-api-key'], { input: key, timeout: 60_000 })
      if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || 'codex login --with-api-key failed')
    },
    async logout() {
      await run(locate(), ['logout'], { timeout: 30_000 })
    }
  },
  instructionsPath: (root) => (root ? path.join(root, 'AGENTS.md') : path.join(codexHome(), 'AGENTS.md'))
}
