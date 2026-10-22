import * as os from 'os'
import * as path from 'path'
import { PROVIDERS } from '@shared/agent'
import type { SessionInfo } from '@shared/types'
import { settings } from '../../context'
import { locateBinary } from '../../runtime'
import { plainEnv } from '../../sessions/launch'
import { run, spawnLines } from '../../util'
import type { AgentAdapter, HeadlessOptions, HeadlessResult } from '../types'
import { ClaudeChat } from './chat'
import { claudeHistory, claudeHome } from './transcripts'

function locate(): string {
  const home = os.homedir()
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude'
  return locateBinary('claude', settings().providers.claude.path, [
    path.join(home, '.local', 'bin', exe),
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'claude.cmd') : undefined,
    path.join(home, '.claude', 'local', exe)
  ])
}

/** Run `claude -p` unattended, streaming JSON so the session id is known early. */
function headless(opts: HeadlessOptions): { done: Promise<HeadlessResult>; kill: () => void } {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none']
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  const model = opts.model || settings().providers.claude.defaultModel
  if (model) args.push('--model', model)
  if (opts.effort) args.push('--effort', opts.effort)
  args.push('--permission-mode', opts.permissionMode || 'acceptEdits')
  if (opts.extraArgs) args.push(...opts.extraArgs)
  const res: HeadlessResult = { code: 0, text: '', isError: false, finished: false }
  let lastText = ''
  const proc = spawnLines(locate(), args, {
    cwd: opts.cwd,
    env: plainEnv(),
    onLine: (line) => {
      try {
        const j = JSON.parse(line)
        if (j.type === 'system' && j.session_id && j.session_id !== res.sessionId) {
          res.sessionId = j.session_id
          opts.onSession?.(j.session_id)
        }
        if (j.type === 'assistant') {
          const t = (j.message?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text: string }) => c.text).join('')
          if (t) lastText = t
        }
        if (j.type === 'result') {
          res.finished = true
          res.text = j.result ?? lastText
          res.costUsd = j.total_cost_usd
          res.isError = !!j.is_error
          res.sessionId = j.session_id ?? res.sessionId
        }
      } catch {
        /* non-JSON line */
      }
    }
  })
  return {
    kill: proc.kill,
    done: proc.done.then((code) => {
      res.code = code
      if (!res.finished) res.text = lastText
      return res
    })
  }
}

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  descriptor: PROVIDERS.claude,
  locate,
  createChat: (s: SessionInfo) => new ClaudeChat(locate(), s),
  headless,
  async complete(prompt, opts) {
    const r = await run(locate(), ['-p', prompt, '--model', opts.model || PROVIDERS.claude.fastModel, '--tools', '', '--permission-prompts', 'none'], {
      cwd: opts.cwd,
      input: opts.input,
      timeout: 120_000
    })
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Claude could not complete the request')
    return r.stdout.trim()
  },
  history: claudeHistory,
  auth: {
    async status() {
      const r = await run(locate(), ['auth', 'status', '--json'], { timeout: 30_000 })
      try {
        const j = JSON.parse(r.stdout)
        return { checked: true, loggedIn: !!j.loggedIn, email: j.email, authMethod: j.authMethod, subscriptionType: j.subscriptionType, orgName: j.orgName }
      } catch {
        // Older CLIs or API-key setups: treat an API key as signed in.
        return process.env.ANTHROPIC_API_KEY
          ? { checked: true, loggedIn: true, authMethod: 'api-key' }
          : { checked: true, loggedIn: false, error: (r.stderr || r.stdout).trim().slice(0, 300) || undefined }
      }
    },
    loginArgs(opts = {}) {
      const args = ['auth', 'login']
      if (opts.console) args.push('--console')
      if (opts.sso) args.push('--sso')
      if (opts.email) args.push('--email', opts.email)
      return args
    },
    async logout() {
      await run(locate(), ['auth', 'logout'], { timeout: 30_000 })
    }
  },
  instructionsPath: (root) => (root ? path.join(root, 'CLAUDE.md') : path.join(claudeHome(), 'CLAUDE.md'))
}
