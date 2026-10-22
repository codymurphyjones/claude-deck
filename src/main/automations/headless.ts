import { settings } from '../context'
import { locateClaude } from '../runtime'
import { plainEnv } from '../sessions/launch'
import { spawnLines } from '../util'

export interface HeadlessResult {
  code: number
  /** Final result text (falls back to the last assistant text). */
  text: string
  isError: boolean
  /** Whether a `result` event arrived. */
  finished: boolean
  sessionId?: string
  costUsd?: number
}

/** Run `claude -p` unattended, streaming JSON so the session id is known early. */
export function runHeadless(opts: {
  prompt: string
  cwd: string
  resumeId?: string
  model?: string
  effort?: string
  permissionMode?: string
  extraArgs?: string[]
  onSession?: (id: string) => void
}): { done: Promise<HeadlessResult>; kill: () => void } {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none']
  if (opts.resumeId) args.push('--resume', opts.resumeId)
  const model = opts.model || settings().defaultModel
  if (model) args.push('--model', model)
  if (opts.effort) args.push('--effort', opts.effort)
  args.push('--permission-mode', opts.permissionMode || 'acceptEdits')
  if (opts.extraArgs) args.push(...opts.extraArgs)
  const res: HeadlessResult = { code: 0, text: '', isError: false, finished: false }
  let lastText = ''
  const proc = spawnLines(locateClaude(settings().claudePath), args, {
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
