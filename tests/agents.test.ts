import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { toolKindOf } from '@shared/agent'
import type { ChatItem } from '@shared/chat'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { migrateSessionRefs, migrateSettings } from '@shared/migrate'
import type { Settings } from '@shared/types'
import { hookToEvent, resultToHook } from '../src/main/agents/claude/hooks'
import { codexHistory, loadRollout } from '../src/main/agents/codex/history'
import { parseApplyPatch, parseUnifiedDiff, patchTool, shellText, shellTool } from '../src/main/agents/codex/tools'

type Tool = Extract<ChatItem, { kind: 'tool' }>

const ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

function rollout(lines: object[]): string {
  const file = path.join(os.tmpdir(), `rollout-2026-01-01T00-00-00-${ID}.jsonl`)
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
  return file
}

const rec = (type: string, payload: object, ts = '2026-01-01T00:00:00Z') => ({ timestamp: ts, type, payload })

describe('codex rollouts', () => {
  const lines = [
    rec('session_meta', { id: ID, cwd: 'C:/repo', git: { branch: 'main' } }),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] }),
    rec('event_msg', { type: 'user_message', message: 'Fix the bug' }),
    rec('response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Thinking about it' }] }),
    rec('response_item', { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'ls -la'] }) }),
    rec('response_item', { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'a.ts\nb.ts', metadata: { exit_code: 0 } }) }),
    rec('response_item', { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-const a = 1\n+const a = 2\n*** End Patch' }),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'c2', output: 'Success. Updated the following files:\nM a.ts' }),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }),
    rec('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 1200, output_tokens: 300 }, last_token_usage: { input_tokens: 900, output_tokens: 120 } } }, '2026-01-01T00:00:05Z'),
    rec('event_msg', { type: 'task_complete', last_agent_message: 'Done.' }, '2026-01-01T00:00:06Z')
  ]

  it('rebuilds chat items in the shared shape', () => {
    const file = rollout(lines)
    const items = loadRollout(file)
    fs.rmSync(file)
    expect(items.map((i) => i.kind)).toEqual(['user', 'thinking', 'tool', 'tool', 'text', 'turn'])
    const [shell, edit] = items.filter((i): i is Tool => i.kind === 'tool')
    expect(shell).toMatchObject({ name: 'Bash', toolKind: 'shell', input: { command: 'ls -la' }, status: 'done', result: 'a.ts\nb.ts' })
    expect(edit).toMatchObject({ name: 'Edit', toolKind: 'edit', input: { file_path: 'a.ts', old_string: 'const a = 1', new_string: 'const a = 2' } })
  })

  it('summarizes like any other transcript', () => {
    const file = rollout(lines)
    const sum = codexHistory.summarize(file)
    expect(codexHistory.idOf(file)).toBe(ID)
    expect(codexHistory.usage(file)).toEqual({ context: 900, output: 120 })
    fs.rmSync(file)
    expect(sum).toMatchObject({ agentSessionId: ID, provider: 'codex', cwd: 'C:/repo', branch: 'main', title: 'Fix the bug', messages: 1, inputTokens: 1200, outputTokens: 300 })
    expect(sum.byDay['2026-01-01']).toBe(1500)
    expect(sum.longestTurnMs).toBe(6000)
  })
})

describe('codex tool normalization', () => {
  it('unwraps shell invocations', () => {
    expect(shellText(['bash', '-lc', 'npm test'])).toBe('npm test')
    expect(shellText(['git', 'commit', '-m', 'a b'])).toBe('git commit -m "a b"')
    expect(shellTool(['powershell.exe', '-Command', 'Get-ChildItem']).name).toBe('PowerShell')
  })

  it('turns patches into write/edit cards', () => {
    const patches = parseApplyPatch('*** Begin Patch\n*** Add File: new.ts\n+export {}\n*** Update File: b.ts\n@@\n x\n-y\n+z\n@@\n-p\n+q\n*** End Patch')
    expect(patches.map(patchTool)).toEqual([
      { name: 'Write', toolKind: 'write', input: { file_path: 'new.ts', content: 'export {}' } },
      { name: 'MultiEdit', toolKind: 'edit', input: { file_path: 'b.ts', edits: [{ old_string: 'x\ny', new_string: 'x\nz' }, { old_string: 'p', new_string: 'q' }] } }
    ])
    expect(patchTool(parseUnifiedDiff('c.ts', 'update', '--- a/c.ts\n+++ b/c.ts\n@@ -1 +1 @@\n-old\n+new'))).toMatchObject({ name: 'Edit', input: { old_string: 'old', new_string: 'new' } })
  })
})

describe('claude hooks', () => {
  it('map to lifecycle events and back', () => {
    expect(hookToEvent({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' }, session_id: 's' })).toMatchObject({ type: 'tool-end', toolKind: 'edit', sessionId: 's' })
    expect(hookToEvent({ hook_event_name: 'Stop', last_assistant_message: 'ok', stop_hook_active: true })).toMatchObject({ type: 'turn-end', lastAssistantMessage: 'ok', continued: true })
    expect(hookToEvent({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'x' })).toMatchObject({ type: 'needs-input', reason: 'permission' })
    expect(JSON.parse(resultToHook('Stop', { continueWith: 'go on' }).stdout!)).toEqual({ decision: 'block', reason: 'go on' })
    expect(JSON.parse(resultToHook('UserPromptSubmit', { context: 'peers' }).stdout!).hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: 'peers' })
    expect(resultToHook('PostToolUse', {})).toEqual({})
    expect(toolKindOf('mcp__deck-mesh__mesh_send')).toBe('mcp')
  })
})

describe('migration', () => {
  it('moves Claude-only settings into providers.claude', () => {
    const s = { ...structuredClone(DEFAULT_SETTINGS), claudePath: 'C:/claude.exe', defaultModel: 'opus', defaultEffort: '', defaultPermissionMode: 'plan' } as unknown as Settings
    migrateSettings(s)
    expect(s.providers.claude).toMatchObject({ path: 'C:/claude.exe', defaultModel: 'opus', defaultPermissionMode: 'plan' })
    expect('claudePath' in s).toBe(false)
    expect(s.defaultProvider).toBe('claude')
  })

  it('renames session ids and stamps the provider', () => {
    const [a, b] = migrateSessionRefs<Record<string, unknown>>([{ claudeSessionId: 'x' }, { agentSessionId: 'y', provider: 'codex' }])
    expect(a).toEqual({ agentSessionId: 'x', provider: 'claude' })
    expect(b).toEqual({ agentSessionId: 'y', provider: 'codex' })
  })
})
