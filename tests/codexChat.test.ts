import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo, WorktreeRecord } from '@shared/types'

// The Codex chat's answers to Codex: the team edit guard before edits, approvals per mode, deny
// feedback reaching the agent, and the worktree push block in Codex's shell environment.

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))
let mesh = true
vi.mock('../src/main/context', () => ({
  settings: () => ({ mesh: { enabled: mesh }, providers: { codex: { defaultModel: '', defaultEffort: '', defaultPermissionMode: '' } } }),
  state: () => ({ worktrees: [] }),
  broadcast: () => undefined
}))
vi.mock('../src/main/sessions/launch', () => ({ agentEnv: () => ({}), meshServer: () => ({ command: 'node', args: [] }), sessionBrief: () => '', sessionDirs: () => [] }))

type Sent = { kind: 'respond' | 'request' | 'error'; id?: unknown; method?: string; body?: unknown }

async function makeChat(mode: string | undefined, cwd = path.resolve('/repo'), launch: object = {}) {
  const { CodexChat } = await import('../src/main/agents/codex/chat')
  const session = { id: 's1', cwd, launch: { permissionMode: mode, ...launch } } as unknown as SessionInfo
  const chat = new CodexChat('codex', session)
  const sent: Sent[] = []
  const c = chat as unknown as Record<string, unknown>
  // Codex's server, stubbed: record what the chat sends.
  c.server = {
    alive: true,
    respond: (id: unknown, body: unknown) => sent.push({ kind: 'respond', id, body }),
    respondError: (id: unknown, body: unknown) => sent.push({ kind: 'error', id, body }),
    request: async (method: string, body: unknown) => {
      sent.push({ kind: 'request', method, body })
      return {}
    }
  }
  c.threadId = 'th1'
  c.turnId = 'tu1'
  return { chat, c, sent }
}

const editItem = { id: 'e1', type: 'fileChange', status: 'inProgress', changes: [{ path: path.resolve('/repo/a.ts'), kind: { type: 'update' }, diff: '' }] }
const run = async (c: Record<string, unknown>, method: string, params: object, id = 7): Promise<void> => (c.handleRequest as (i: unknown, m: string, p: object) => Promise<void>).call(c, id, method, params)

describe('Codex chat answers', () => {
  it('declines an edit the team guard refuses, even when the approval arrives right behind the edit, and tells the agent why', async () => {
    const { chat, c, sent } = await makeChat('bypassPermissions')
    let release!: () => void
    chat.lifecycle = (ev) =>
      ev.type === 'tool-start' ? new Promise((r) => (release = () => r({ deny: { decision: 'deny', reason: 'a.ts is claimed by "other chat"' } }))) : Promise.resolve({})
    ;(c.itemStarted as (i: object) => void).call(c, editItem)
    const pending = run(c, 'item/fileChange/requestApproval', { itemId: 'e1' })
    release()
    await pending
    expect(sent.find((x) => x.kind === 'respond')?.body).toEqual({ decision: 'decline' })
    expect(sent.find((x) => x.method === 'turn/steer')?.body).toMatchObject({ threadId: 'th1', expectedTurnId: 'tu1', input: [{ type: 'text', text: expect.stringContaining('claimed by "other chat"') }] })
  })

  it('with the guard on, asks Codex before every edit and answers for the chosen mode', async () => {
    const policy = async (mode?: string): Promise<unknown> => ((await makeChat(mode)).c.policy as () => { approvalPolicy?: string }).call((await makeChat(mode)).c).approvalPolicy
    expect(await policy('acceptEdits')).toBe('untrusted')
    expect(await policy('bypassPermissions')).toBe('untrusted')
    expect(await policy('plan')).toBe('on-request')
    // Workspace edits: an edit that passes the guard is approved without asking; a command asks.
    const { chat, c, sent } = await makeChat('acceptEdits')
    chat.lifecycle = async () => ({})
    ;(c.itemStarted as (i: object) => void).call(c, editItem)
    await run(c, 'item/fileChange/requestApproval', { itemId: 'e1' }, 1)
    expect(sent.find((x) => x.id === 1)?.body).toEqual({ decision: 'accept' })
    await run(c, 'item/commandExecution/requestApproval', { itemId: 'x1', command: 'npm publish' }, 2)
    expect(sent.find((x) => x.id === 2)).toBeUndefined()
    expect((c.pendingPerms as Map<string, unknown>).has('2')).toBe(true)
    // Without team coordination, Codex's own policy applies (nothing to check edits against).
    mesh = false
    expect(await policy('acceptEdits')).toBe('on-request')
    mesh = true
  })

  it('sends the reason given when the user denies a request to the agent', async () => {
    const { chat, c, sent } = await makeChat(undefined)
    chat.lifecycle = async () => ({})
    await run(c, 'item/commandExecution/requestApproval', { itemId: 'x1', command: 'rm -rf build' }, 3)
    chat.respondPermission('3', { allow: false, message: 'Use the clean script instead.' })
    expect(sent.find((x) => x.id === 3)?.body).toEqual({ decision: 'decline' })
    expect(sent.find((x) => x.method === 'turn/steer')?.body).toMatchObject({ input: [{ type: 'text', text: 'Use the clean script instead.' }] })
  })

  it('puts the worktree push block in Codex’s shell environment for a chat’s worktree', async () => {
    const { setWorktreeSource } = await import('../src/main/git/pushGuard')
    const wt = path.resolve('/data/worktrees/repo-1')
    setWorktreeSource(() => [{ id: 'w', path: wt, repoRoot: path.resolve('/repo'), baseRef: 'x', branch: 'claude/main-1', target: 'main', permanent: false, createdAt: 0, lastUsed: 0 } as WorktreeRecord])
    const { c, sent } = await makeChat('acceptEdits', wt)
    c.server = { ...(c.server as object), request: async (method: string, body: unknown) => (sent.push({ kind: 'request', method, body }), method === 'thread/start' ? { thread: { id: 't' } } : {}), notify: () => undefined }
    await (c.open as () => Promise<void>).call(c)
    const start = sent.find((x) => x.method === 'thread/start')?.body as { config: Record<string, Record<string, string>> }
    const set = start.config['shell_environment_policy.set']
    expect(set.GIT_CONFIG_COUNT).toBeDefined()
    expect(Object.values(set)).toContain('url.claude-deck-chat-branches-are-never-pushed://.pushInsteadOf')
  })

  it('steers a message sent mid-turn into the running turn, and queues it when Codex refuses', async () => {
    const { chat, c, sent } = await makeChat(undefined)
    ;(c.meta as { busy: boolean }).busy = true
    chat.send('also update the README')
    await new Promise((r) => setTimeout(r, 0))
    expect(sent.find((x) => x.method === 'turn/steer')?.body).toEqual({ threadId: 'th1', expectedTurnId: 'tu1', input: [{ type: 'text', text: 'also update the README' }] })
    expect((c.queue as unknown[]).length).toBe(0)
    c.server = { ...(c.server as object), request: async () => Promise.reject(new Error('no turn/steer')) }
    chat.send('and the changelog')
    await new Promise((r) => setTimeout(r, 0))
    expect((c.queue as { text: string }[]).map((q) => q.text)).toEqual(['and the changelog'])
  })

  it('shows Codex questions as a question card and answers them by question id', async () => {
    const { chat, c, sent } = await makeChat('plan')
    await run(c, 'item/tool/requestUserInput', { itemId: 'i1', questions: [{ id: 'db', header: 'Database', question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }, 9)
    const card = (c.items as { name?: string; input?: { questions?: { question: string }[] } }[]).find((x) => x.name === 'AskUserQuestion')
    expect(card?.input?.questions?.[0].question).toBe('Which database?')
    chat.respondPermission('9', { allow: true, updatedInput: { answers: { 'Which database?': 'SQLite' } } })
    expect(sent.find((x) => x.id === 9)?.body).toEqual({ answers: { db: { answers: ['SQLite'] } } })
  })

  it('shows the turn plan as a to-do list and keeps the real context window', async () => {
    const { c } = await makeChat(undefined)
    const handle = (m: string, p: object): void => (c.handle as (m: string, p: object) => void).call(c, m, p)
    handle('turn/plan/updated', { turnId: 'tu1', explanation: 'Small fix', plan: [{ step: 'Read code', status: 'completed' }, { step: 'Fix it', status: 'inProgress' }, { step: 'Test', status: 'pending' }] })
    handle('turn/plan/updated', { turnId: 'tu1', plan: [{ step: 'Read code', status: 'completed' }, { step: 'Fix it', status: 'completed' }, { step: 'Test', status: 'inProgress' }] })
    const todos = (c.items as { name?: string; input?: { todos: { status: string }[] } }[]).filter((x) => x.name === 'TodoWrite')
    expect(todos).toHaveLength(1)
    expect(todos[0].input?.todos.map((t) => t.status)).toEqual(['completed', 'completed', 'in_progress'])
    handle('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, outputTokens: 5 }, modelContextWindow: 272000 } })
    expect((c.meta as { contextWindow?: number }).contextWindow).toBe(272000)
  })

  it('remembers an always-allowed command with the rule Codex proposes', async () => {
    const { chat, c, sent } = await makeChat(undefined)
    chat.lifecycle = async () => ({})
    await run(c, 'item/commandExecution/requestApproval', { itemId: 'x1', command: 'npm test', proposedExecpolicyAmendment: ['npm', 'test'] }, 4)
    chat.respondPermission('4', { allow: true, always: true })
    expect(sent.find((x) => x.id === 4)?.body).toEqual({ decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['npm', 'test'] } } })
  })

  it('forks a thread when asked, and runs plan mode as Codex plan mode', async () => {
    const { c, sent } = await makeChat('plan', path.resolve('/repo'), { resumeId: 'old', fork: true })
    c.server = { ...(c.server as object), request: async (method: string, body: unknown) => (sent.push({ kind: 'request', method, body }), method === 'thread/fork' ? { thread: { id: 'new' }, model: 'gpt-5' } : {}), notify: () => undefined }
    c.threadId = undefined
    await (c.open as () => Promise<void>).call(c)
    expect(sent.find((x) => x.method === 'thread/fork')?.body).toMatchObject({ threadId: 'old' })
    expect(c.threadId).toBe('new')
    c.ready = Promise.resolve()
    await (c.startTurn as (m: object) => Promise<void>).call(c, { text: 'plan it', userItemId: 'u1' })
    expect(sent.find((x) => x.method === 'turn/start')?.body).toMatchObject({ collaborationMode: { mode: 'plan', settings: { model: 'gpt-5' } } })
  })
})
