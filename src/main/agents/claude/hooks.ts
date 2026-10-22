import { toolKindOf, type AgentEvent } from '@shared/agent'
import type { LifecycleResult } from '../types'

/** Payload hookRelay.cjs forwards from Claude Code's hooks. */
export type HookPayload = {
  hook_event_name?: string
  session_id?: string
  transcript_path?: string
  permission_mode?: string
  prompt?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  message?: string
  notification_type?: string
  last_assistant_message?: string
  stop_hook_active?: boolean
}

export type HookResult = { stdout?: string; exitCode?: number }

/** Claude hook → normalized lifecycle event (undefined for hooks the app ignores). */
export function hookToEvent(p: HookPayload): AgentEvent | undefined {
  const ids = { sessionId: p.session_id, transcriptPath: p.transcript_path }
  switch (p.hook_event_name) {
    case 'SessionStart':
      return { type: 'session-start', ...ids }
    case 'UserPromptSubmit':
      return { type: 'turn-start', prompt: p.prompt ?? '', permissionMode: p.permission_mode, ...ids }
    case 'PreToolUse':
    case 'PostToolUse': {
      const name = p.tool_name ?? ''
      return { type: p.hook_event_name === 'PreToolUse' ? 'tool-start' : 'tool-end', toolKind: toolKindOf(name), name, input: p.tool_input ?? {}, ...ids }
    }
    case 'Notification': {
      const msg = p.message ?? ''
      const type = p.notification_type ?? ''
      const reason = type === 'permission_prompt' || /permission/i.test(msg) ? 'permission' : type === 'idle_prompt' || /waiting for your input/i.test(msg) ? 'idle' : 'other'
      return { type: 'needs-input', reason, message: msg, ...ids }
    }
    case 'Stop':
      return { type: 'turn-end', lastAssistantMessage: p.last_assistant_message, continued: p.stop_hook_active, permissionMode: p.permission_mode, ...ids }
    case 'SessionEnd':
      return { type: 'session-end' }
  }
  return undefined
}

/** Normalized result → the hook's stdout. */
export function resultToHook(hookEvent: string | undefined, r: LifecycleResult): HookResult {
  if (r.continueWith) return { stdout: JSON.stringify({ decision: 'block', reason: r.continueWith }) }
  if (r.deny) return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: r.deny.decision, permissionDecisionReason: r.deny.reason } }) }
  if (r.context && hookEvent) return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: hookEvent, additionalContext: r.context } }) }
  return {}
}
