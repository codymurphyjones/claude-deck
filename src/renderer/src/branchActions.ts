import type { BranchInfo } from '@shared/repo'
import type { ChatMergeResult, LaunchOptions } from '@shared/types'
import { api, errMsg } from './api'
import { attempt, focusSessionTab, get, openInEditor, openSession, set, toast } from './store'
import { openMenuAt } from './components/ui'

// Branch actions for chats that work in their own worktrees (main: worktrees/branchSync.ts).

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`

/** The live chat working in a worktree, if any. */
function chatIn(worktreeId: string) {
  return Object.values(get().sessions).find((s) => s.kind === 'agent' && s.worktreeId === worktreeId && s.status !== 'exited')
}

/**
 * "Merge into <target>": bring a chat's worktree branch back into the branch it works toward, and
 * handle every outcome: ask the chat to commit or resolve conflicts, hold an update for a folder
 * with uncommitted changes, report pushes.
 */
export async function mergeChat(worktreeId: string, opts: { stashLocal?: boolean } = {}): Promise<ChatMergeResult | undefined> {
  let r: ChatMergeResult
  try {
    r = await api.branches.merge(worktreeId, opts)
  } catch (e) {
    toast(errMsg(e), 'error')
    return undefined
  }
  const chat = chatIn(worktreeId)
  const w = get().library.worktrees.find((x) => x.id === worktreeId)
  set((s) => ({ heldMerges: s.heldMerges.filter((h) => h.worktreeId !== worktreeId) }))
  switch (r.status) {
    case 'merged': {
      const inDeck = !!r.updated && get().library.worktrees.some((x) => x.holdsBranch && x.path.toLowerCase() === r.updated!.toLowerCase())
      toast(`Merged ${plural(r.commits, 'commit')} into ${r.target}. ${inDeck ? `Push it from ${r.target}'s branch options when ready.` : 'Your folder is up to date.'}`, 'success')
      if (r.stashConflict) toast(`Your uncommitted changes conflicted when re-applied on top of ${r.target}; they're kept in git stash.`, 'error')
      break
    }
    case 'nothing':
      toast(`Nothing to merge: this chat has no commits that ${r.target} doesn't have.`, 'info')
      break
    case 'uncommitted': {
      // Committing is the user's step: open the Review pane on the chat, where Commit & merge does both.
      if (!chat) return (void toast(`This worktree has ${plural(r.files.length, 'uncommitted file')}. Commit them in its Review pane first.`, 'error'), r)
      const c = await api.dialog.confirm(
        `${chat.name} has ${plural(r.files.length, 'uncommitted file')}`,
        `Only committed work is merged. Review and commit it in the Review pane ("Commit & merge into ${w?.target ?? 'the branch'}" does both).\n\n${r.files.slice(0, 12).join('\n')}${r.files.length > 12 ? '\n…' : ''}`,
        ['Open Review', 'Cancel']
      )
      if (c === 0) {
        focusSessionTab(chat.id)
        set({ rightPanel: 'review' })
      }
      break
    }
    case 'conflicts': {
      const c = await api.dialog.confirm(
        `Bringing ${r.target} into this chat's branch conflicts`,
        `${r.target} has newer commits that conflict with this chat's work, in:\n${r.files.join('\n')}\n\nThe conflicts are in the chat's own worktree; your folder isn't affected. Resolve them, then merge again.`,
        chat ? [`Ask ${chat.name} to resolve`, 'Resolve myself', 'Cancel'] : ['Resolve myself', 'Cancel']
      )
      const ask = chat && c === 0
      const self = (chat && c === 1) || (!chat && c === 0)
      if (ask)
        await api.session.sendPrompt(
          chat.id,
          `Merging ${r.target} into your branch${w?.branch ? ` ${w.branch}` : ''} left conflicts in: ${r.files.join(', ')}. Resolve each one in this worktree, keeping the intent of both sides (ask me if a conflict needs a decision), then \`git add\` the files and tell me when they're ready. Don't commit: I'll finish the merge commit myself before merging into ${r.target}.`
        )
      if (self && w) openInEditor(`${w.path}/${r.files[0]}`)
      break
    }
    case 'held':
      set((s) => ({ heldMerges: [...s.heldMerges, { worktreeId, target: r.target, checkout: r.checkout, files: r.files, chat: chat?.name ?? w?.branch ?? 'a chat' }] }))
      break
    case 'inactive': {
      // Only merged into a local checkout: offer to check the branch out in Claude Deck first.
      const c = await api.dialog.confirm(
        `${r.target} isn't checked out locally`,
        `Chats merge into a branch's local folder: yours, or a copy in Claude Deck's data folder. Check ${r.target} out in Claude Deck (an active branch on the Chats page) and merge?`,
        [`Check out ${r.target} and merge`, 'Cancel']
      )
      if (c !== 0 || !w) break
      if ((await attempt(() => api.worktree.checkoutBranch(w.repoRoot, r.target), `${r.target} is now active in Claude Deck`)) === undefined) break
      return mergeChat(worktreeId, opts)
    }
    case 'error':
      toast(r.message, 'error')
      break
  }
  return r
}

/**
 * Switch the user's folder to a local branch, first checking it against its copy on the remote
 * (work may have happened on it in Claude Deck's worktrees, or someone may have pushed). Never
 * overwrites either side: when they differ, the user chooses.
 */
export async function switchBranchSafely(root: string, branch: string, doSwitch: () => Promise<unknown>): Promise<boolean> {
  let vs
  try {
    vs = await api.branches.vsRemote(root, branch)
  } catch {
    vs = undefined
  }
  let pullAfter = false
  if (vs && !vs.missing && (vs.ahead || vs.behind)) {
    const remote = vs.remote ?? 'origin'
    const stale = vs.offline ? ` (couldn't reach ${remote}; compared with the last fetch)` : ''
    if (vs.ahead && vs.behind) {
      const c = await api.dialog.confirm(
        `${branch} has diverged from ${remote}`,
        `${plural(vs.ahead, 'commit')} here aren't on ${remote}, and ${remote} has ${plural(vs.behind, 'commit')} that aren't here${stale}. Nothing will be overwritten; merge or rebase them after switching (or ask a chat to).`,
        ['Switch', 'Cancel']
      )
      if (c !== 0) return false
    } else if (vs.ahead) {
      const c = await api.dialog.confirm(`${branch} has ${plural(vs.ahead, 'commit')} not on ${remote}`, `They were made here (for example by a chat in Claude Deck) and haven't been pushed${stale}.`, [
        'Push, then switch',
        'Switch',
        'Cancel'
      ])
      if (c === 2 || c < 0) return false
      if (c === 0) {
        try {
          await api.branches.push(root, branch)
        } catch (e) {
          toast(`Push failed: ${errMsg(e)}`, 'error')
        }
      }
    } else {
      const c = await api.dialog.confirm(`${remote} has ${plural(vs.behind, 'newer commit')} on ${branch}`, `Your copy of ${branch} is behind ${remote}${stale}.`, ['Switch and pull', 'Switch', 'Cancel'])
      if (c === 2 || c < 0) return false
      pullAfter = c === 0
    }
  }
  try {
    await doSwitch()
  } catch (e) {
    toast(errMsg(e), 'error')
    return false
  }
  if (pullAfter) {
    try {
      await api.repo.pull(root)
    } catch (e) {
      toast(`Pull failed: ${errMsg(e)}`, 'error')
    }
  }
  toast(`Switched to ${branch}`, 'success')
  return true
}

/**
 * Start a chat on `branch`. The folder's checked-out branch (or none given) starts the usual way;
 * any other branch gets a worktree working toward it, so two branches can be worked on at once.
 * A remote-only branch ("origin/x") gets a local branch tracking it.
 */
export function newChatOnBranch(root: string, branch?: string, current?: string, extra: Partial<LaunchOptions> = {}): Promise<unknown> {
  if (!branch || branch === current) return openSession('agent', { cwd: root, ...extra })
  return openSession('agent', { cwd: root, ...extra, worktree: { target: branch } })
}

/**
 * A chat on `branch` in its own worktree, always (even for the folder's checked-out branch): it works
 * on a sub-branch and merges back. The branch is checked out in Claude Deck first if it's nowhere.
 */
export function newChatInWorktree(root: string, branch: string): Promise<unknown> {
  return openSession('agent', { cwd: root, worktree: { target: branch } })
}

/**
 * The repo's branches for starting work: the folder's checked-out one, the ones held in Claude Deck's
 * data folder (active branches), other local ones by recent use, and remote ones with no local branch.
 * Chats' own sub-branches aren't listed: they're reached through their chats.
 */
export async function startableBranches(root: string): Promise<{ current?: string; held: string[]; local: string[]; remote: string[] }> {
  const all = await api.repo.branches(root).catch(() => [] as BranchInfo[])
  const wts = get().library.worktrees.filter((w) => !w.deleted)
  const chatBranches = new Set(wts.filter((w) => w.target).map((w) => w.branch))
  const local = all.filter((b) => !b.remote && !chatBranches.has(b.name))
  const tracked = new Set(local.map((b) => b.upstream).filter(Boolean))
  const names = new Set(local.map((b) => b.name))
  const current = all.find((b) => !b.remote && b.current)?.name
  const heldSet = new Set(wts.filter((w) => w.holdsBranch && w.branch).map((w) => w.branch!))
  return {
    current,
    held: local.filter((b) => heldSet.has(b.name)).map((b) => b.name),
    local: local.map((b) => b.name).filter((b) => b !== current && !heldSet.has(b)),
    remote: all.filter((b) => b.remote && !tracked.has(b.name) && !names.has(b.name.slice(b.name.indexOf('/') + 1))).map((b) => b.name)
  }
}

/** "New chat" with a branch choice: the checked-out branch first (the default), then the active ones, then the rest. */
export async function newChatMenu(el: HTMLElement, root: string): Promise<void> {
  const { current, held, local, remote } = await startableBranches(root)
  openMenuAt(el, [
    { label: current ? `On ${current} (checked out)` : 'New chat', icon: 'plus', onClick: () => newChatOnBranch(root) },
    ...held.map((b) => ({ label: `On ${b}`, icon: 'branch', hint: 'active', onClick: () => newChatOnBranch(root, b, current) })),
    ...(local.length || remote.length ? [{ separator: true }] : []),
    ...local.slice(0, 10).map((b) => ({ label: b, icon: 'branch', onClick: () => newChatOnBranch(root, b, current) })),
    ...remote.slice(0, 6).map((b) => ({ label: b, icon: 'globe', hint: 'remote', onClick: () => newChatOnBranch(root, b, current) })),
    { separator: true },
    { label: 'More options…', icon: 'more', onClick: () => set({ newSession: { cwd: root } }) }
  ])
}
