import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '@shared/types'

// Mesh context stays lean (the peer roster isn't re-injected unchanged: every injection is re-sent
// with each later request), and the spend guard's pause stops automatic peer wake-ups.

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-'))
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' } }))
vi.mock('../src/main/runtime', () => ({ runtime: { userData } }))
vi.mock('../src/main/git/gitService', () => ({ commonDir: async () => undefined }))
vi.mock('../src/main/context', () => ({
  settings: () => ({ mesh: { enabled: true, autoWake: true, autoWakeIdleMs: 0, claimMode: 'ask', repoPeers: true, staleReadGuard: true } }),
  broadcast: () => undefined,
  pushTimeline: () => undefined
}))

const session = (id: string, name: string): SessionInfo =>
  ({
    id,
    name,
    kind: 'agent',
    cwd: '/repo',
    root: '/repo',
    meshGroup: 'dir:/repo',
    status: 'idle',
    role: 'free',
    createdAt: 0,
    lastActivity: 0,
    lastUserInput: 0,
    files: [],
    launch: {},
    pendingMessages: 0
  }) as unknown as SessionInfo

async function setup() {
  const { MeshService } = await import('../src/main/mesh/meshService')
  const a = session('a', 'Alpha')
  const b = session('b', 'Beta')
  const all = [a, b]
  let paused: string | undefined
  const injected: string[] = []
  const mesh = new MeshService({
    sessions: () => all,
    get: (id) => all.find((x) => x.id === id),
    inject: (id, text) => (injected.push(`${id}:${text}`), true),
    readTerminal: async () => '',
    shellOf: () => undefined,
    sessionChanged: () => undefined,
    paused: () => paused
  })
  mesh.ensureGroup('dir:/repo', 'repo')
  return { mesh, a, b, injected, pause: (why?: string) => (paused = why) }
}

describe('mesh context and the spend guard', () => {
  it('injects the peer roster at start and when it changes, not on every prompt', async () => {
    const { mesh, a, b } = await setup()
    expect(mesh.contextForPrompt(a, true)).toContain('"Beta"')
    expect(mesh.contextForPrompt(a, false)).toBeUndefined()
    b.lastPrompt = 'fix the parser'
    expect(mesh.contextForPrompt(a, false)).toContain('fix the parser')
    b.status = 'working' // a status change alone doesn't re-send it
    expect(mesh.contextForPrompt(a, false)).toBeUndefined()
  })

  it('still delivers new messages with the prompt even when the roster is unchanged', async () => {
    const { mesh, a, b } = await setup()
    mesh.contextForPrompt(a, true)
    await mesh.callTool(b, 'mesh_send', { to: 'Alpha', kind: 'request', text: 'please rebase' })
    expect(mesh.contextForPrompt(a, false)).toContain('please rebase')
  })

  it('suppresses stop-reasons and wake-ups while spending is paused', async () => {
    const { mesh, a, b, injected, pause } = await setup()
    await mesh.callTool(b, 'mesh_send', { to: 'Alpha', kind: 'request', text: 'run the tests' })
    pause('over the limit')
    expect(mesh.stopReason(a)).toBeUndefined()
    expect(mesh.tryWake(a.id)).toBe(false)
    expect(injected).toEqual([])
    pause(undefined)
    expect(mesh.tryWake(a.id)).toBe(true)
    expect(injected[0]).toContain('run the tests')
  })
})
