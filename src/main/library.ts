import { baseName, normalizeKey } from '@shared/paths'
import type { ChatRecord, Project } from '@shared/types'
import { broadcast, state, updateState } from './context'
import { shortId } from './util'

const WIN = process.platform === 'win32'

const libraryListeners: (() => void)[] = []
/** Run `fn` whenever the library (projects, chats, worktrees) changes. */
export function onLibraryChanged(fn: () => void): void {
  libraryListeners.push(fn)
}

export function emitLibrary(): void {
  const s = state()
  broadcast('library:changed', { projects: s.projects, chats: s.chats, worktrees: s.worktrees, recentFolders: s.recentFolders })
  for (const fn of libraryListeners) fn()
}

export function findProjectForFolder(folder: string): Project | undefined {
  const k = normalizeKey(folder, WIN)
  return state().projects.find((p) => p.folders.some((f) => normalizeKey(f, WIN) === k))
}

export function ensureProject(folder: string): Project {
  let p = findProjectForFolder(folder)
  if (!p) {
    const created: Project = { id: 'p' + shortId(), name: baseName(folder), folders: [folder], pinned: false, createdAt: Date.now(), lastOpened: Date.now() }
    p = created
    updateState((s) => s.projects.push(created))
  } else {
    const proj = p
    updateState(() => (proj.lastOpened = Date.now()))
  }
  touchRecent(folder)
  emitLibrary()
  return p
}

export function touchRecent(folder: string): void {
  updateState((s) => {
    const k = normalizeKey(folder, WIN)
    s.recentFolders = [folder, ...s.recentFolders.filter((f) => normalizeKey(f, WIN) !== k)].slice(0, 20)
  })
}

export function updateProject(id: string, patch: Partial<Project>): void {
  updateState((s) => {
    const p = s.projects.find((x) => x.id === id)
    if (p) Object.assign(p, patch)
  })
  emitLibrary()
}

export function removeProject(id: string): void {
  updateState((s) => {
    s.projects = s.projects.filter((p) => p.id !== id)
  })
  emitLibrary()
}

export function getProject(id?: string): Project | undefined {
  return id ? state().projects.find((p) => p.id === id) : undefined
}

export function upsertChat(rec: Partial<ChatRecord> & { agentSessionId: string }): ChatRecord {
  let chat = state().chats.find((c) => c.agentSessionId === rec.agentSessionId)
  updateState((s) => {
    if (chat) Object.assign(chat, rec, { updatedAt: Date.now() })
    else {
      chat = {
        name: 'New chat',
        cwd: '',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pinned: false,
        archived: false,
        ...rec
      }
      s.chats.unshift(chat)
      if (s.chats.length > 2000) s.chats.length = 2000
    }
  })
  emitLibrary()
  return chat!
}

export function updateChat(id: string, patch: Partial<ChatRecord>): void {
  updateState((s) => {
    const c = s.chats.find((x) => x.agentSessionId === id)
    if (c) Object.assign(c, patch)
  })
  emitLibrary()
}

export function removeChat(id: string): void {
  updateState((s) => {
    s.chats = s.chats.filter((c) => c.agentSessionId !== id)
  })
  emitLibrary()
}

export function getChat(id?: string): ChatRecord | undefined {
  return id ? state().chats.find((c) => c.agentSessionId === id) : undefined
}

export function archiveProjectChats(projectId: string): void {
  updateState((s) => s.chats.filter((c) => c.projectId === projectId).forEach((c) => (c.archived = true)))
  emitLibrary()
}
