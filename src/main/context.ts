import { BrowserWindow } from 'electron'
import * as path from 'path'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import { migrateSessionRefs, migrateSettings } from '@shared/migrate'
import type { ChatRecord, OpenTabState, Project, Settings, TimelineEvent, WorktreeRecord } from '@shared/types'
import { runtime } from './runtime'
import { JsonStore } from './store'
import { shortId } from './util'

export interface AppState {
  projects: Project[]
  chats: ChatRecord[]
  worktrees: WorktreeRecord[]
  openTabs: OpenTabState[]
  recentFolders: string[]
  pinnedReviews: string[]
  viewedFiles: Record<string, string[]>
}

let settingsStore: JsonStore<Settings>
let stateStore: JsonStore<AppState>

export function initStores(): void {
  settingsStore = new JsonStore<Settings>(path.join(runtime.userData, 'settings.json'), structuredClone(DEFAULT_SETTINGS))
  stateStore = new JsonStore<AppState>(path.join(runtime.userData, 'state.json'), {
    projects: [],
    chats: [],
    worktrees: [],
    openTabs: [],
    recentFolders: [],
    pinnedReviews: [],
    viewedFiles: {}
  })
  migrateSettings(settingsStore.data)
  migrateSessionRefs(stateStore.data.chats)
  for (const t of stateStore.data.openTabs) migrateSessionRefs(t.sessions)
}

export const settings = (): Settings => settingsStore.data
export const updateSettings = (patch: Partial<Settings>): Settings => {
  settingsStore.update((s) => Object.assign(s, patch))
  broadcast('settings:changed', settingsStore.data)
  return settingsStore.data
}
export const state = (): AppState => stateStore.data
export const updateState = (fn: (s: AppState) => void): void => stateStore.update(fn)
export const flushStores = (): void => {
  settingsStore?.saveNow()
  stateStore?.saveNow()
}

/** Send an event to every renderer window. */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

export function toast(text: string, kind: 'info' | 'error' | 'success' = 'info'): void {
  broadcast('toast', { id: shortId(), kind, text })
}

// ---- Cross-session timeline (in-memory ring) ----
const timeline: TimelineEvent[] = []
export function pushTimeline(ev: Omit<TimelineEvent, 'id' | 'ts'>): void {
  const full: TimelineEvent = { ...ev, id: shortId(), ts: Date.now() }
  timeline.push(full)
  if (timeline.length > 2000) timeline.splice(0, timeline.length - 2000)
  broadcast('timeline:event', full)
}
export const getTimeline = (): TimelineEvent[] => timeline
