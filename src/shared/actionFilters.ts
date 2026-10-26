// What the Actions view hides (Settings → actions): rules that apply everywhere, and per project.
// Keys:
//   script:<name>          a script of that name, in any package
//   script:<rel>|<name>    one package's script (rel: the package's folder, '' for the root)
//   folder:<rel>           a package folder (all its scripts)
//   tool:<kind>            a command folder: 'mono', 'npm', 'yarn', 'pnpm', 'bun'
//   action:<id>            one command of a command folder (e.g. action:yarn:publish)

export type HideScope = 'project' | 'everywhere'

export const scriptKey = (name: string): string => `script:${name}`
export const packageScriptKey = (rel: string, name: string): string => `script:${rel}|${name}`
export const folderKey = (rel: string): string => `folder:${rel}`
export const toolKey = (kind: string): string => `tool:${kind}`
export const actionKey = (id: string): string => `action:${id}`

export interface HiddenRules {
  everywhere: ReadonlySet<string>
  project: ReadonlySet<string>
}

export function hiddenRules(settings: { hidden: string[]; hiddenByProject: Record<string, string[]> } | undefined, projectId: string): HiddenRules {
  return { everywhere: new Set(settings?.hidden ?? []), project: new Set(settings?.hiddenByProject[projectId] ?? []) }
}

/** Where a key is hidden: 'everywhere' wins over 'project'; undefined if it isn't. */
export function hiddenBy(rules: HiddenRules, key: string): HideScope | undefined {
  return rules.everywhere.has(key) ? 'everywhere' : rules.project.has(key) ? 'project' : undefined
}

const any = (rules: HiddenRules, keys: string[]): boolean => keys.some((k) => !!hiddenBy(rules, k))

export const isScriptHidden = (rules: HiddenRules, rel: string, name: string): boolean => any(rules, [scriptKey(name), packageScriptKey(rel, name), folderKey(rel)])
export const isFolderHidden = (rules: HiddenRules, rel: string): boolean => any(rules, [folderKey(rel)])
export const isToolHidden = (rules: HiddenRules, kind: string): boolean => any(rules, [toolKey(kind)])
export const isActionHidden = (rules: HiddenRules, kind: string, id: string): boolean => any(rules, [toolKey(kind), actionKey(id)])

/** The settings after hiding (or showing) `key` in `scope`. */
export function withHidden(
  settings: { hidden: string[]; hiddenByProject: Record<string, string[]> },
  projectId: string,
  key: string,
  scope: HideScope,
  hide: boolean
): { hidden: string[]; hiddenByProject: Record<string, string[]> } {
  const toggle = (list: string[]): string[] => (hide ? [...new Set([...list, key])] : list.filter((k) => k !== key))
  if (scope === 'everywhere') return { ...settings, hidden: toggle(settings.hidden) }
  const own = toggle(settings.hiddenByProject[projectId] ?? [])
  const byProject = { ...settings.hiddenByProject, [projectId]: own }
  if (!own.length) delete byProject[projectId]
  return { ...settings, hiddenByProject: byProject }
}
