import type { EventEmitter } from 'events'
import type { AgentEvent, ProviderDescriptor, ProviderId, TokenUsage } from '@shared/agent'
import type { UsageRecord } from '@shared/pricing'
import type { ChatItem, ChatMeta } from '@shared/chat'
import type { AuthStatus, SessionInfo, TranscriptSummary } from '@shared/types'

export interface PermissionDecision {
  allow: boolean
  /** Remember the decision for this session so the same request isn't asked again. */
  always?: boolean
  message?: string
  updatedInput?: Record<string, unknown>
}

/** What the app wants done in response to a lifecycle event (hook output, for Claude). */
export interface LifecycleResult {
  /** Extra context the agent should see with the prompt / after the tool. */
  context?: string
  /** Block a pending edit. */
  deny?: { decision: 'deny' | 'ask'; reason: string }
  /** Don't stop: keep working with this instruction. */
  continueWith?: string
}

export type LifecycleHandler = (ev: AgentEvent) => Promise<LifecycleResult>

/**
 * One live agent conversation, normalized into ChatItems.
 *
 * Events: 'op' (ChatOp), 'status' ('working' | 'needs-input' | 'idle', permission?), 'session' (id),
 * 'meta' (ChatMeta), 'turn' (), 'exit' (code, stderr), 'compacted' (), 'cost' (cumulative USD, when the CLI reports it).
 */
export interface AgentChat extends EventEmitter {
  items: ChatItem[]
  meta: ChatMeta
  readonly alive: boolean
  /** Lifecycle sink for agents without native hooks (set before start). */
  lifecycle?: LifecycleHandler
  start(): void
  kill(): void
  send(text: string, opts?: { images?: { mediaType: string; data: string }[]; injected?: boolean }): boolean
  interrupt(): void
  /** Ask the agent to summarize its conversation in place ('compacted' fires when it has). */
  compact(): boolean
  setPermissionMode(mode: string): Promise<unknown>
  setModel(model: string): Promise<unknown>
  respondPermission(requestId: string, d: PermissionDecision): void
  hasPendingPermission(): boolean
  notice(text: string, level?: Extract<ChatItem, { kind: 'notice' }>['level']): void
}

export interface HeadlessOptions {
  prompt: string
  cwd: string
  resumeId?: string
  model?: string
  effort?: string
  permissionMode?: string
  extraArgs?: string[]
  onSession?: (id: string) => void
}

export interface HeadlessResult {
  code: number
  /** Final result text (falls back to the last assistant text). */
  text: string
  isError: boolean
  /** Whether the run reported completion. */
  finished: boolean
  sessionId?: string
  costUsd?: number
}

/** A transcript summary plus the aggregates insights() needs. */
export interface TranscriptDigest extends TranscriptSummary {
  longestTurnMs: number
  byDay: Record<string, number>
}

export interface TranscriptFile {
  file: string
  mtimeMs: number
  size: number
}

export interface AgentHistory {
  /** Every transcript file on disk. */
  files(): TranscriptFile[]
  /** Session id for a transcript file. */
  idOf(file: string): string
  summarize(file: string): TranscriptDigest
  /** First matching prompt/reply snippet in a transcript's raw text (already known to contain q). */
  snippet(data: string, q: string): string | undefined
  find(sessionId: string): string | undefined
  load(sessionId: string): ChatItem[]
  /** Context usage from the newest usage record. */
  usage(transcriptPath: string | undefined): TokenUsage | undefined
  /** API requests recorded since `offset` (undefined: start at the current end of the file). */
  usageSince(transcriptPath: string, offset: number | undefined): { records: UsageRecord[]; offset: number } | undefined
  /** Make a session resumable from another folder (worktree handoff). */
  prepareResume(sessionId: string, cwd: string): void
}

export interface AgentAuth {
  status(): Promise<Omit<AuthStatus, 'provider'>>
  loginArgs(opts?: LoginOptions): string[]
  logout(): Promise<void>
  /** Sign in with an API key (passed on stdin, never on a command line), when the CLI supports it. */
  loginWithApiKey?(key: string): Promise<void>
}

/** How to sign in: console / SSO / email (Claude), device code (Codex). */
export interface LoginOptions {
  console?: boolean
  sso?: boolean
  email?: string
  device?: boolean
}

export interface AgentAdapter {
  id: ProviderId
  descriptor: ProviderDescriptor
  /** Path of the CLI executable. */
  locate(): string
  createChat(s: SessionInfo): AgentChat
  headless(opts: HeadlessOptions): { done: Promise<HeadlessResult>; kill: () => void }
  /** The models and efforts the CLI offers right now (Codex: model/list); undefined to use the descriptor's. */
  listModels?(): Promise<{ models: [string, string][]; efforts: string[] } | undefined>
  /** One-shot, tool-less completion (commit messages). */
  complete(prompt: string, opts: { cwd: string; input?: string; model?: string }): Promise<string>
  history: AgentHistory
  auth: AgentAuth
  /** Global (no root) or project instructions file. */
  instructionsPath(root?: string): string
}
