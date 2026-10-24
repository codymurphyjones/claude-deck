import * as fs from 'fs'
import * as path from 'path'
import { broadcast } from '../context'
import { rawGit as git, currentBranch } from './gitService'

// The branch each watched folder has checked out, kept current however it changes: in Claude Deck,
// a terminal, an editor, another tool. Git rewrites HEAD (via HEAD.lock, then a rename) on every
// switch, so the folder's git dir is watched for that, and "branches:changed" is broadcast when the
// branch really differs. Views showing a folder's branch (the Chats page, Overview, Repository,
// Review) refresh on it.

interface Watch {
  watcher?: fs.FSWatcher
  branch?: string
  timer?: NodeJS.Timeout
}

export class HeadWatcher {
  private watches = new Map<string, Watch>()

  constructor(private onChange: (folder: string, branch: string | undefined, previous: string | undefined) => void = () => undefined) {}

  /** Watch exactly these folders (project folders, branches held in Claude Deck…). */
  async sync(folders: string[]): Promise<void> {
    const want = new Map(folders.map((f) => [path.resolve(f).toLowerCase(), path.resolve(f)]))
    for (const [k, w] of this.watches) {
      if (want.has(k)) continue
      w.watcher?.close()
      if (w.timer) clearTimeout(w.timer)
      this.watches.delete(k)
    }
    for (const [k, folder] of want) {
      if (this.watches.has(k)) continue
      const w: Watch = {}
      this.watches.set(k, w)
      await this.start(folder, w)
    }
  }

  private async start(folder: string, w: Watch): Promise<void> {
    if (!fs.existsSync(folder)) return
    // A worktree's HEAD lives in its own git dir (.git/worktrees/<name>), not the repo's.
    const r = await git(folder, ['rev-parse', '--absolute-git-dir'], undefined, 10_000)
    if (r.code !== 0) return
    const gitDir = path.normalize(r.stdout.trim())
    w.branch = await currentBranch(folder)
    try {
      w.watcher = fs.watch(gitDir, (_event, file) => {
        if (file && !/^HEAD(\.lock)?$/.test(String(file))) return
        if (w.timer) clearTimeout(w.timer)
        w.timer = setTimeout(() => void this.check(folder, w), 150)
      })
      w.watcher.on('error', () => w.watcher?.close())
    } catch {
      /* the folder can't be watched (e.g. a network drive): views still refresh on focus */
    }
  }

  private async check(folder: string, w: Watch): Promise<void> {
    const branch = await currentBranch(folder)
    if (branch === w.branch) return
    const previous = w.branch
    w.branch = branch
    this.onChange(folder, branch, previous)
    broadcast('branches:changed', { folder, branch, previous })
  }

  stop(): void {
    for (const w of this.watches.values()) {
      w.watcher?.close()
      if (w.timer) clearTimeout(w.timer)
    }
    this.watches.clear()
  }
}
