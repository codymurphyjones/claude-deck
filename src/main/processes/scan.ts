import * as fs from 'fs'
import * as path from 'path'
import { LOCKFILES, pickPm, type ScriptPackage } from '@shared/processes'
import { run } from '../util'

const SKIP = new Set(['node_modules', 'dist', 'out', 'build', 'coverage', 'bower_components', 'vendor', 'target'])
const MAX_DEPTH = 8
const MAX_PACKAGES = 300

/**
 * The package.json folders of a git repo that are part of the project: tracked, or new and not
 * ignored. Git applies every .gitignore (nested ones too), .git/info/exclude and the global excludes,
 * so ignored code (build output, vendored or generated folders, scratch copies) isn't offered.
 * Undefined when `folder` isn't in a git repo.
 */
async function gitPackageDirs(folder: string): Promise<string[] | undefined> {
  const r = await run('git', ['-c', 'core.quotepath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ':(glob)**/package.json'], { cwd: folder, timeout: 30_000 })
  if (r.code !== 0) return undefined
  const dirs = r.stdout
    .split('\0')
    .filter((f) => f && path.posix.basename(f) === 'package.json')
    // Still never a dependency folder, even one committed by mistake.
    .filter((f) => !f.split('/').some((seg) => seg === 'node_modules'))
    .map((f) => path.join(folder, path.posix.dirname(f)))
  // Shallowest first, then by path (as the directory walk orders them).
  const depth = (d: string): number => path.relative(folder, d).split(path.sep).filter(Boolean).length
  return [...new Set(dirs)].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))
}

/** Without git: every package.json folder, breadth-first, skipping dot and build/dependency folders. */
async function walkPackageDirs(folder: string): Promise<string[]> {
  const found: string[] = []
  let level = [folder]
  for (let depth = 0; depth <= MAX_DEPTH && level.length && found.length < MAX_PACKAGES; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
      if (entries.some((e) => e.isFile() && e.name === 'package.json')) found.push(dir)
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) next.push(path.join(dir, e.name))
    }
    level = next.sort()
  }
  return found
}

/** Every package.json with scripts under `folder` that's part of the project, shallowest first. */
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

  const dirs = (await gitPackageDirs(folder)) ?? (await walkPackageDirs(folder))
  for (const dir of dirs) {
    if (out.length >= MAX_PACKAGES) break
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8'))
      const scripts = Object.fromEntries(Object.entries(pkg?.scripts ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      if (!Object.keys(scripts).length) continue
      const rel = path.relative(folder, dir).replace(/\\/g, '/')
      out.push({ dir, rel, name: typeof pkg.name === 'string' ? pkg.name : rel || path.basename(dir), pm: pickPm(pkg.packageManager, await locksUpward(dir)), scripts })
    } catch {
      /* unreadable or deleted package.json */
    }
  }
  return out
}
