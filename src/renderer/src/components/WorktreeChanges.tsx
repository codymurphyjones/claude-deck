import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { GitInfo, WorktreeRecord } from '@shared/types'
import { api, bridge } from '../api'
import { set, useStore } from '../store'
import { Icon } from './Icon'

// Chats work in their own worktrees, so their uncommitted changes aren't in the project folder's
// `git status`. This lists the repo's worktrees that have changes, each opening its own diff.

const same = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** The live worktrees of the repo `root` belongs to (`root` may itself be one), other than `root`. */
function useRepoWorktrees(root: string): WorktreeRecord[] {
  const all = useStore((s) => s.library.worktrees)
  return useMemo(() => {
    const live = all.filter((w) => !w.deleted)
    const repo = live.find((w) => same(w.path, root))?.repoRoot ?? root
    return live.filter((w) => same(w.repoRoot, repo) && !same(w.path, root))
  }, [all, root])
}

/** The repo's chat worktrees with a label each (the chat's name and branch), newest first. */
export function useChatWorktrees(root: string): { path: string; label: string; branch?: string }[] {
  const wts = useRepoWorktrees(root)
  const chats = useStore((s) => s.library.chats)
  const sessions = useStore((s) => s.sessions)
  return useMemo(
    () =>
      [...wts]
        .sort((a, b) => b.lastUsed - a.lastUsed)
        .map((w) => {
          const name = Object.values(sessions).find((s) => s.worktreeId === w.id && s.kind === 'agent')?.name ?? chats.find((c) => c.worktreeId === w.id)?.name ?? 'Worktree'
          return { path: w.path, branch: w.branch, label: `${name} · ${w.branch ?? 'detached'}` }
        }),
    [wts, chats, sessions]
  )
}

/** `heading` shows above the list, only when some worktree has changes. */
export function WorktreeChanges({ root, heading }: { root: string; heading?: ReactNode }) {
  const wts = useRepoWorktrees(root)
  const chats = useStore((s) => s.library.chats)
  const sessions = useStore((s) => s.sessions)
  const [info, setInfo] = useState<Record<string, GitInfo>>({})
  const ids = wts.map((w) => w.id).join('|')

  // `ahead` from git info counts against upstream / the default branch; a chat's branch is measured
  // against the branch it merges into instead.
  const load = useCallback(() => {
    for (const w of wts)
      void Promise.all([api.git.info(w.path), w.branch && w.target ? api.branches.status(w.id).catch(() => null) : null]).then(
        ([gi, st]) => setInfo((m) => ({ ...m, [w.id]: st ? { ...gi, ahead: st.ahead } : w.target ? gi : { ...gi, ahead: 0 } })),
        () => undefined
      )
  }, [ids])
  useEffect(load, [load])
  // Chats edit and commit in the background: refresh on their file activity and after merges.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const later = (): void => {
      clearTimeout(t)
      t = setTimeout(load, 1200)
    }
    const offs = [bridge.on('session:fileTouched', later), bridge.on('branches:changed', later)]
    window.addEventListener('focus', later)
    return () => {
      offs.forEach((o) => o())
      window.removeEventListener('focus', later)
      clearTimeout(t)
    }
  }, [load])

  const nameOf = (w: WorktreeRecord): string =>
    Object.values(sessions).find((s) => s.worktreeId === w.id && s.kind === 'agent')?.name ??
    chats.find((c) => c.worktreeId === w.id || (w.chatId && c.agentSessionId === w.chatId))?.name ??
    w.branch ??
    w.path.split(/[\\/]/).pop()!
  const changed = wts.filter((w) => info[w.id]?.isRepo && (info[w.id].dirty || (w.target && info[w.id].ahead)))
  if (!changed.length) return null

  return (
    <>
      {heading}
      {changed.map((w) => {
        const gi = info[w.id]
        const label = nameOf(w)
        const open = (): void =>
          set({
            repoDiff: gi.dirty
              ? { kind: 'working', view: 'unstaged', title: `Changes in ${label}`, cwd: w.path }
              : { kind: 'compare', base: w.target!, title: `${label}: commits to merge into ${w.target}`, cwd: w.path }
          })
        return (
          <div key={w.id} className="list-item" title={`${w.path}\n${gi.dirty ? 'View its uncommitted changes' : `View what it would merge into ${w.target}`}`} onClick={open}>
            <Icon name="branch" size={13} style={{ color: gi.dirty ? 'var(--warning)' : 'var(--accent)' }} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis">{label}</div>
              <div className="sub ellipsis">
                {[gi.dirty ? `${gi.dirty} uncommitted${gi.staged ? ` (${gi.staged} staged)` : ''}` : '', w.target && gi.ahead ? `${gi.ahead} commit${gi.ahead === 1 ? '' : 's'} to merge into ${w.target}` : ''].filter(Boolean).join(' · ')}
              </div>
            </div>
            <Icon name="chevron-right" size={12} style={{ color: 'var(--muted)' }} />
          </div>
        )
      })}
    </>
  )
}
