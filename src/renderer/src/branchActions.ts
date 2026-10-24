import type { ChatMergeResult } from '@shared/types'
import { api, errMsg } from './api'
import { get, openInEditor, set, toast } from './store'

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
      const where = r.updated ? ' Your folder is up to date.' : r.pushed ? ' and pushed it.' : ''
      toast(`Merged ${plural(r.commits, 'commit')} into ${r.target}.${where}`, 'success')
      if (r.pushError) toast(`Merged into ${r.target}, but pushing it failed: ${r.pushError.split('\n')[0]}`, 'error')
      if (r.stashConflict) toast(`Your uncommitted changes conflicted when re-applied on top of ${r.target}; they're kept in git stash.`, 'error')
      break
    }
    case 'nothing':
      toast(`Nothing to merge: this chat has no commits that ${r.target} doesn't have.`, 'info')
      break
    case 'uncommitted': {
      if (!chat) return (void toast(`This worktree has ${plural(r.files.length, 'uncommitted file')}. Commit them first.`, 'error'), r)
      const c = await api.dialog.confirm(
        `${chat.name} has ${plural(r.files.length, 'uncommitted file')}`,
        `Only committed work is merged. Ask ${chat.name} to commit it?\n\n${r.files.slice(0, 12).join('\n')}${r.files.length > 12 ? '\n…' : ''}`,
        ['Ask to commit', 'Cancel']
      )
      if (c === 0)
        await api.session.sendPrompt(
          chat.id,
          `Please commit your current work on this branch${w?.branch ? ` (${w.branch})` : ''} with a clear commit message, so it can be merged into ${w?.target ?? 'its target branch'}. Uncommitted files: ${r.files.join(', ')}.`
        )
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
          `Merging ${r.target} into your branch${w?.branch ? ` ${w.branch}` : ''} left conflicts in: ${r.files.join(', ')}. Resolve each one in this worktree, keeping the intent of both sides (ask me if a conflict needs a decision), then \`git add\` the files and \`git commit --no-edit\` to finish the merge, and tell me when it's done so I can merge into ${r.target}.`
        )
      if (self && w) openInEditor(`${w.path}/${r.files[0]}`)
      break
    }
    case 'held':
      set((s) => ({ heldMerges: [...s.heldMerges, { worktreeId, target: r.target, checkout: r.checkout, files: r.files, chat: chat?.name ?? w?.branch ?? 'a chat' }] }))
      break
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
