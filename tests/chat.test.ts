import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it } from 'vitest'
import { applyChatOp, applyChatOps, chatToText, type ChatItem, type ChatOp } from '@shared/chat'
import { LineBuffer } from '../src/main/util'
import { lineDiff } from '@shared/lineDiff'
import { loadConversation } from '../src/main/agents/claude/history'

describe('chat ops', () => {
  it('appends, streams deltas and patches items', () => {
    let items: ChatItem[] = []
    items = applyChatOp(items, { op: 'append', item: { kind: 'text', id: 't1', ts: 0, text: 'Hel', streaming: true } })
    items = applyChatOp(items, { op: 'delta', id: 't1', field: 'text', text: 'lo' })
    items = applyChatOp(items, { op: 'patch', id: 't1', patch: { streaming: false } })
    expect(items[0]).toMatchObject({ text: 'Hello', streaming: false })
    items = applyChatOp(items, { op: 'append', item: { kind: 'tool', id: 'x', ts: 0, name: 'Bash', input: { command: 'ls' }, status: 'done', result: 'a.txt' } })
    expect(chatToText(items)).toContain('[tool Bash] ls')
    expect(applyChatOp(items, { op: 'remove', id: 't1' })).toHaveLength(1)
  })

  it('applies a burst of ops like applying them one by one', () => {
    const start: ChatItem[] = [{ kind: 'text', id: 'a', ts: 0, text: 'x', streaming: false }]
    const ops: ChatOp[] = [
      { op: 'append', item: { kind: 'text', id: 't1', ts: 0, text: 'He', streaming: true } },
      { op: 'delta', id: 't1', field: 'text', text: 'll' },
      { op: 'delta', id: 't1', field: 'text', text: 'o' },
      { op: 'append', item: { kind: 'tool', id: 'x', ts: 0, name: 'Write', input: {}, partialInput: '', status: 'streaming' } },
      { op: 'delta', id: 'x', field: 'partialInput', text: '{"a":1}' },
      { op: 'patch', id: 't1', patch: { streaming: false } },
      { op: 'remove', id: 'missing' },
      { op: 'delta', id: 'missing', field: 'text', text: 'ignored' }
    ]
    const batched = applyChatOps(start, ops)
    expect(batched).toEqual(ops.reduce(applyChatOp, start))
    expect(batched[0]).toBe(start[0]) // untouched items keep their identity
    expect(start).toHaveLength(1) // input not mutated
  })
})

describe('line buffer', () => {
  it('splits lines across chunks, including very long ones', () => {
    const lines: string[] = []
    const buf = new LineBuffer()
    const big = 'z'.repeat(200_000)
    buf.push('{"a":1}\n{"b"', (l) => lines.push(l))
    buf.push(':2}\n' + big.slice(0, 1000), (l) => lines.push(l))
    for (let i = 1000; i < big.length; i += 64 * 1024) buf.push(big.slice(i, i + 64 * 1024), (l) => lines.push(l))
    buf.push('\n\ntail', (l) => lines.push(l))
    expect(lines).toEqual(['{"a":1}', '{"b":2}', big, ''])
    expect(buf.rest()).toBe('tail')
    expect(buf.rest()).toBe('')
  })
})

describe('line diff', () => {
  it('marks added and removed lines', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc\nd')
    expect(d.map((l) => l.t + l.s)).toEqual([' a', '-b', '+B', ' c', '+d'])
  })
})

describe('transcript history', () => {
  it('rebuilds user, assistant, tool calls and results', () => {
    const file = path.join(os.tmpdir(), `deck-hist-${Date.now()}.jsonl`)
    const lines = [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'Fix the bug' } },
      { type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'a.ts' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '1→const a = 1' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
      { type: 'system', subtype: 'turn_duration', durationMs: 1200 }
    ]
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'))
    const items = loadConversation(file)
    fs.rmSync(file)
    expect(items.map((i) => i.kind)).toEqual(['user', 'text', 'tool', 'text', 'turn'])
    const tool = items[2] as Extract<ChatItem, { kind: 'tool' }>
    expect(tool.status).toBe('done')
    expect(tool.result).toContain('const a = 1')
  })
})
