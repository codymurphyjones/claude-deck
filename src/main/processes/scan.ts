import * as fs from 'fs'
import * as path from 'path'
import { LOCKFILES, pickPm, type ScriptPackage } from '@shared/processes'

const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'bower_components', 'vendor', 'target'])
const MAX_DEPTH = 8
const MAX_PACKAGES = 300

/** Every package.json with scripts under `folder`, shallowest first. */
export async function scanScripts(folder: string): Promise<ScriptPackage[]> {
  const out: ScriptPackage[] = []
  const lockCache = new Map<string, string[]>()
  const locks = async (dir: string): Promise<string[]> => {
    let l = lockCache.get(dir)
    if (!l) {
      const names = await fs.promises.readdir(dir).catch(() => [] as string[])
      l = LOCKFILES.map(([f]) => f).filter((f) => names.includes(f))
      lockCache.set(dir, l)
    }
    return l
  }
  // Lockfiles live at the workspace root, so look upward (but not past the project folder).
  const locksUpward = async (dir: string): Promise<string[]> => {
    for (let d = dir; ; d = path.dirname(d)) {
      const l = await locks(d)
      if (l.length || path.relative(folder, d) === '' || path.dirname(d) === d) return l
    }
  }

  let level = [folder]
  for (let depth = 0; depth <= MAX_DEPTH && level.length && out.length < MAX_PACKAGES; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
      if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
        try {
          const pkg = JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8'))
          const scripts = Object.fromEntries(Object.entries(pkg?.scripts ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
          if (Object.keys(scripts).length) {
            const rel = path.relative(folder, dir).replace(/\\/g, '/')
            out.push({ dir, rel, name: typeof pkg.name === 'string' ? pkg.name : rel || path.basename(dir), pm: pickPm(pkg.packageManager, await locksUpward(dir)), scripts })
          }
        } catch {
          /* unreadable package.json */
        }
      }
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(path.join(dir, e.name))
    }
    level = next.sort()
  }
  return out.slice(0, MAX_PACKAGES)
}
