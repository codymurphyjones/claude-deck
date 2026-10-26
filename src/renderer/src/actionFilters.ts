import { hiddenRules, withHidden, type HiddenRules, type HideScope } from '@shared/actionFilters'
import { api } from './api'
import { get, set, useStore } from './store'

// The Actions view's hide rules (shared/actionFilters.ts), from settings: everywhere and per project.

export function useHiddenRules(projectId: string): HiddenRules {
  const s = useStore((st) => st.settings.actions)
  return hiddenRules(s, projectId)
}

/** Hide (or show again) `key`, everywhere or in this project. */
export async function setHidden(projectId: string, key: string, scope: HideScope, hide: boolean): Promise<void> {
  const cur = get().settings.actions ?? { hidden: [], hiddenByProject: {} }
  const actions = withHidden(cur, projectId, key, scope, hide)
  set((st) => ({ settings: { ...st.settings, actions } }))
  set({ settings: await api.updateSettings({ actions }) })
}

/** Menu items to hide an item in this project or everywhere. */
export function hideMenuItems(projectId: string, keys: { project: string; everywhere: string }, what: string): { label: string; icon: string; onClick: () => unknown }[] {
  return [
    { label: `Hide ${what} in this project`, icon: 'eye', onClick: () => setHidden(projectId, keys.project, 'project', true) },
    { label: `Hide ${what} everywhere`, icon: 'eye', onClick: () => setHidden(projectId, keys.everywhere, 'everywhere', true) }
  ]
}
