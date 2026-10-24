import { useCallback, useEffect, useState } from 'react'
import type { ChatBranchStatus } from '@shared/types'
import { api, bridge } from '../api'
import { mergeChat } from '../branchActions'
import { Icon } from './Icon'

// A worktree chat's branch and the branch it merges into, with "Merge into <target>". Shown in the
// Review pane (for the chat being reviewed) and on a project's Overview (for each worktree chat).

export function ChatBranchBar({ worktreeId, compact = false }: { worktreeId: string; compact?: boolean }) {
  const [st, setSt] = useState<ChatBranchStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const load = useCallback(() => {
    void api.branches.status(worktreeId).then(setSt, () => setSt(null))
  }, [worktreeId])
  useEffect(load, [load])
  // Commits and merges change the counts: refresh on file activity and after merges.
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
  if (!st) return null
  const merge = async (): Promise<void> => {
    setBusy(true)
    await mergeChat(worktreeId)
    setBusy(false)
    load()
  }
  const blocked = st.conflicts.length > 0
  return (
    <div className={`chat-branch-bar ${compact ? 'compact' : ''}`}>
      <Icon name="branch" size={12} style={{ color: 'var(--accent)', flex: 'none' }} />
      <span className="mono ellipsis" title={`This chat works on ${st.branch}, in its own worktree`}>
        {st.branch}
      </span>
      <Icon name="arrow" size={11} style={{ color: 'var(--muted)', flex: 'none' }} />
      <b className="mono" title={st.targetCheckout ? `Checked out in ${st.targetCheckout}` : 'Not checked out: updated and pushed from Claude Deck'}>
        {st.target}
      </b>
      <span className="grow ellipsis sub">
        {st.ahead ? `${st.ahead} to merge` : 'nothing to merge'}
        {st.behind ? ` · ${st.target} has ${st.behind} newer` : ''}
        {st.dirty ? ` · ${st.dirty} uncommitted` : ''}
      </span>
      {blocked && (
        <span className="badge err" title={st.conflicts.join('\n')}>
          {st.conflicts.length} conflict{st.conflicts.length === 1 ? '' : 's'}
        </span>
      )}
      <button className="btn sm primary" disabled={busy || (!st.ahead && !blocked && !st.dirty)} onClick={() => void merge()} title={`Bring this chat's commits into ${st.target}`}>
        <Icon name="fork" size={12} /> {busy ? 'Merging…' : `Merge into ${st.target}`}
      </button>
    </div>
  )
}
