import * as fs from 'fs'
import * as path from 'path'
import { monoActions, monoRunner, packageManagerActions, type MonoConfig, type MonoFile, type ToolSet } from '@shared/actions'
import { LOCKFILES, pickPm, type ScriptPackage } from '@shared/processes'

// A project folder's command folders for the Actions view, besides its package.json scripts: its
// `.mono` commands (when it has a .mono folder) and its package manager's own commands.

const readJson = async (file: string): Promise<unknown> => JSON.parse(await fs.promises.readFile(file, 'utf8'))

/** `.mono/*.json`: each file a command, except config.json (the runner's settings). */
async function readMono(dir: string): Promise<{ files: Record<string, MonoFile>; config: MonoConfig; notes: string[] } | undefined> {
  const monoDir = path.join(dir, '.mono')
  const names = await fs.promises.readdir(monoDir).catch(() => undefined)
  if (!names) return undefined
  const files: Record<string, MonoFile> = {}
  let config: MonoConfig = {}
  const notes: string[] = []
  for (const n of names.filter((x) => x.toLowerCase().endsWith('.json')).sort()) {
    const name = n.slice(0, -5)
    try {
      const data = await readJson(path.join(monoDir, n))
      if (!data || typeof data !== 'object') throw new Error('not an object')
      if (name === 'config') config = data as MonoConfig
      // mono refuses a command named "tools" (it's its built-in).
      else if (name !== 'tools') files[name] = data as MonoFile
    } catch (e) {
      notes.push(`.mono/${n} couldn't be read: ${(e as Error).message}`)
    }
  }
  return { files, config, notes }
}

/** The tool sets of one project folder. `packages`: its package.json scripts (from scanScripts). */
export async function scanTools(folder: string, packages: ScriptPackage[], relPrefix = ''): Promise<ToolSet[]> {
  const out: ToolSet[] = []
  const rootPkg = (await readJson(path.join(folder, 'package.json')).catch(() => undefined)) as Record<string, unknown> | undefined
  const entries = await fs.promises.readdir(folder).catch(() => [] as string[])
  const locks = LOCKFILES.map(([f]) => f).filter((f) => entries.includes(f))
  if (!rootPkg && !locks.length && !entries.includes('.mono')) return out

  const pm = pickPm(rootPkg?.packageManager, locks)
  const pmVersion = typeof rootPkg?.packageManager === 'string' && rootPkg.packageManager.startsWith(`${pm}@`) ? rootPkg.packageManager.slice(pm.length + 1).split('+')[0] : undefined
  // Yarn 2+ ("Berry") has its own commands: told by packageManager, or its .yarnrc.yml.
  const yarnBerry = pm === 'yarn' && (pmVersion ? Number(pmVersion.split('.')[0]) >= 2 : entries.includes('.yarnrc.yml'))
  const deps = (k: string): string[] => Object.keys((rootPkg?.[k] as Record<string, string> | undefined) ?? {})
  const workspaces = packages.filter((p) => p.dir !== folder).map((p) => ({ name: p.name, rel: p.rel, scripts: Object.keys(p.scripts) }))
  const context = {
    workspaces,
    scripts: [...new Set(packages.flatMap((p) => Object.keys(p.scripts)))].sort(),
    dependencies: [...new Set([...deps('dependencies'), ...deps('devDependencies'), ...deps('peerDependencies')])].sort()
  }
  const rel = relPrefix

  const mono = await readMono(folder)
  if (mono) {
    out.push({
      id: `mono:${rel}`,
      kind: 'mono',
      title: '.mono',
      dir: folder,
      rel,
      actions: monoActions(mono.files, mono.config, monoRunner(pm), workspaces),
      context,
      notes: mono.notes.length ? mono.notes : undefined
    })
  }
  if (rootPkg || locks.length) {
    out.push({
      id: `pm:${rel}`,
      kind: pm,
      title: `${pm}${pmVersion ? ` ${pmVersion}` : pm === 'yarn' ? (yarnBerry ? ' 2+' : ' 1') : ''}`,
      dir: folder,
      rel,
      actions: packageManagerActions(pm, { yarnBerry }),
      context
    })
  }
  return out
}
