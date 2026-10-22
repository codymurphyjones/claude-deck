// Permission modes (shared ids across providers) → Codex approval policy + sandbox.

export interface CodexPolicy {
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  /** thread/start and `codex exec -s` form. */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** turn/start form. */
  sandboxPolicy?: { type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' }
}

export function modePolicy(mode: string | undefined): CodexPolicy {
  switch (mode) {
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
    case 'acceptEdits':
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }
    case 'manual':
      return { approvalPolicy: 'untrusted', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
    default:
      return {}
  }
}
