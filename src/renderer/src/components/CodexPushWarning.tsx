import type { ProviderId } from '@shared/agent'
import { useStore } from '../store'
import { Icon } from './Icon'

/**
 * Under a model choice when the agent is Codex. The worktree push block (git/pushGuard.ts) is a set of
 * GIT_CONFIG_* variables; Codex filters its shells' environment (shell_environment_policy, which can drop
 * names containing "KEY"), so the app also sets them through that policy's `set` (agents/codex). Unlike
 * Claude there's no deny rule behind it; the branch's own pushRemote marker still refuses a plain push.
 */
export function CodexPushWarning({ provider }: { provider?: ProviderId }) {
  const fallback = useStore((s) => s.settings.defaultProvider)
  if ((provider ?? fallback) !== 'codex') return null
  return (
    <div className="banner warn codex-push-warning" data-testid="codex-push-warning">
      <Icon name="shield" size={13} />
      <span>
        <b>Codex and worktree pushes:</b> Codex has no equivalent of Claude's built-in deny rules for <code>git push</code>. In a chat's worktree, Claude Deck blocks pushes through git settings it hands
        to Codex's shells (<code>shell_environment_policy.set</code>). A plain <code>git push</code> is refused regardless, but if your Codex version or config doesn't apply those settings, a push that
        names its remote and branch explicitly could get through.
      </span>
    </div>
  )
}
