import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer store's workspace/tab model: Home, one title-bar tab per workspace (a project, or
// Quick chats), and each workspace's sub-tabs (its Overview first, chats, editor).

vi.mock('../src/renderer/src/api', () => ({
  api: { session: { saveTabs: vi.fn(), close: vi.fn(async () => undefined) }, dialog: { confirm: vi.fn(async () => 0) } },
  bridge: { on: () => () => undefined },
  errMsg: (e: unknown) => String(e)
}))

type Store = typeof import('../src/renderer/src/store')
let S: Store

beforeAll(async () => {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => undefined }) })
  S = await import('../src/renderer/src/store')
})

const projects = [
  { id: 'pA', name: 'A', folders: ['C:\\code\\a'], pinned: false, createdAt: 0, lastOpened: 0 },
  { id: 'pB', name: 'B', folders: ['C:\\code\\b'], pinned: false, createdAt: 0, lastOpened: 0 }
]
const session = (id: string, projectId?: string, cwd = projectId === 'pA' ? 'C:\\code\\a' : projectId === 'pB' ? 'C:\\code\\b' : 'C:\\tmp') =>
  ({ id, kind: 'agent', name: id, cwd, root: cwd, projectId, status: 'idle', launch: {} }) as never

beforeEach(() => {
  S.set({
    tabs: [],
    groups: [],
    activeGroup: S.HOME,
    activeTabId: undefined,
    groupActive: {},
    library: { projects, chats: [], worktrees: [], recentFolders: [] } as never,
    sessions: { a1: session('a1', 'pA'), a2: session('a2', 'pA'), b1: session('b1', 'pB'), q1: session('q1') }
  })
})

const st = () => S.get()
const groupTabs = (g: string) => st().tabs.filter((t) => t.group === g)

describe('workspaces', () => {
  it('opens a chat in its project workspace, with the Overview first', () => {
    S.addSessionToTabs('a1')
    expect(st().groups).toEqual(['pA'])
    expect(st().activeGroup).toBe('pA')
    const mine = groupTabs('pA')
    expect(mine[0].projectId).toBe('pA')
    expect(mine[1].sessionIds).toEqual(['a1'])
    expect(st().activeTabId).toBe(mine[1].id)
  })

  it('keeps one title-bar tab per project and puts loose chats in Quick chats', () => {
    S.addSessionToTabs('a1')
    S.addSessionToTabs('b1')
    S.addSessionToTabs('a2')
    S.addSessionToTabs('q1')
    expect(st().groups).toEqual(['pA', 'pB', S.QUICK])
    expect(groupTabs('pA').map((t) => t.projectId ?? t.sessionIds[0])).toEqual(['pA', 'a1', 'a2'])
    expect(groupTabs(S.QUICK).map((t) => t.sessionIds[0])).toEqual(['q1'])
  })

  it('remembers each workspace’s sub-tab when switching between them', () => {
    S.addSessionToTabs('a1')
    const a1Tab = st().activeTabId
    S.addSessionToTabs('b1')
    S.openGroup('pA')
    expect(st().activeTabId).toBe(a1Tab)
    S.goHome()
    expect(st().activeGroup).toBe(S.HOME)
    expect(st().activeTabId).toBeUndefined()
    expect(S.tabProjectRoot(st())).toBeUndefined()
  })

  it('follows the active workspace for the current project', () => {
    S.openProjectHome('pB')
    expect(st().activeGroup).toBe('pB')
    expect(S.tabProjectRoot(st())).toBe('C:\\code\\b')
    expect(S.currentProjectId()).toBe('pB')
  })

  it('shows a neighbor after the active chat closes, and closes Quick chats with its last chat', () => {
    S.addSessionToTabs('a1')
    S.addSessionToTabs('a2')
    S.removeSessionFromTabs('a2')
    expect(st().tabs.find((t) => t.id === st().activeTabId)?.sessionIds).toEqual(['a1'])
    S.addSessionToTabs('q1')
    expect(st().activeGroup).toBe(S.QUICK)
    S.removeSessionFromTabs('q1')
    expect(st().groups).toEqual(['pA'])
    expect(st().activeGroup).toBe('pA')
  })

  it('reorders within a workspace but never moves a chat before the Overview', () => {
    S.addSessionToTabs('a1')
    S.addSessionToTabs('a2')
    const a2 = st().activeTabId!
    S.moveTab(a2, 0)
    expect(groupTabs('pA').map((t) => t.projectId ?? t.sessionIds[0])).toEqual(['pA', 'a2', 'a1'])
  })

  it('does not split across workspaces', () => {
    S.addSessionToTabs('a1')
    const a1Tab = st().activeTabId!
    S.addSessionToTabs('b1', 'split', 'a1')
    expect(st().tabs.find((t) => t.id === a1Tab)?.sessionIds).toEqual(['a1'])
    expect(groupTabs('pB').some((t) => t.sessionIds.includes('b1'))).toBe(true)
  })

  it('gives each project its own editor, opened in the project holding the file', () => {
    S.openInEditor('C:\\code\\b\\src\\x.ts', { line: 3 })
    expect(st().activeGroup).toBe('pB')
    const ed = groupTabs('pB').find((t) => t.editor)!
    expect(ed.root).toBe('C:\\code\\b')
    expect(st().editorRequest).toMatchObject({ group: 'pB', line: 3 })
    // Right after the Overview.
    expect(groupTabs('pB').map((t) => (t.projectId ? 'overview' : t.editor ? 'editor' : 'chat'))).toEqual(['overview', 'editor'])
    S.openInEditor('C:\\code\\a\\README.md')
    expect(groupTabs('pA').filter((t) => t.editor)).toHaveLength(1)
    expect(st().tabs.filter((t) => t.editor)).toHaveLength(2)
  })

  it('closes a whole workspace and moves to the next one', async () => {
    S.addSessionToTabs('a1')
    S.addSessionToTabs('b1')
    S.openGroup('pA')
    await S.closeGroup('pA')
    expect(st().groups).toEqual(['pB'])
    expect(st().activeGroup).toBe('pB')
    expect(groupTabs('pA')).toHaveLength(0)
  })
})
