import { create } from 'zustand'
import { applyChatOps, type ChatItem, type ChatMeta, type ChatOp } from '@shared/chat'
import { api, bridge } from '../api'

export interface ChatState {
  items: ChatItem[]
  meta: ChatMeta
  ready: boolean
}

const EMPTY_META: ChatMeta = { commands: [], tools: [], busy: false, queued: 0 }

export const useChat = create<Record<string, ChatState>>(() => ({}))

const loading = new Set<string>()

// Streamed ops are buffered and committed at most once per frame, so a burst (bulk tool output,
// fast token streams) becomes one store update and one render instead of hundreds.
const pendingOps = new Map<string, ChatOp[]>()
let frame = 0
let fallback: ReturnType<typeof setTimeout> | undefined

function flushOps(): void {
  if (frame) cancelAnimationFrame(frame)
  if (fallback) clearTimeout(fallback)
  frame = 0
  fallback = undefined
  if (!pendingOps.size) return
  const all = useChat.getState()
  const next: Record<string, ChatState> = {}
  for (const [id, ops] of pendingOps) {
    const st = all[id]
    if (st?.ready) next[id] = { ...st, items: applyChatOps(st.items, ops) }
  }
  pendingOps.clear()
  if (Object.keys(next).length) useChat.setState(next)
}

bridge.on('chat:op', (id: string, op: ChatOp) => {
  // Ops that arrive before the snapshot are already contained in it.
  if (!useChat.getState()[id]?.ready) return
  const list = pendingOps.get(id)
  if (list) list.push(op)
  else pendingOps.set(id, [op])
  if (!frame) frame = requestAnimationFrame(flushOps)
  // Animation frames pause while the window is hidden; don't let ops pile up.
  fallback ??= setTimeout(flushOps, 250)
})

bridge.on('chat:meta', (id: string, meta: ChatMeta) => {
  const st = useChat.getState()[id]
  useChat.setState({ [id]: { items: st?.items ?? [], ready: st?.ready ?? false, meta } })
})

/** Load a session's conversation once, then follow live ops. */
export async function ensureChat(id: string, force = false): Promise<void> {
  if (!force && (useChat.getState()[id]?.ready || loading.has(id))) return
  loading.add(id)
  try {
    const snap = await api.chat.snapshot(id)
    // Anything buffered so far was received before the snapshot, which already contains it.
    pendingOps.delete(id)
    useChat.setState({ [id]: { items: snap.items, meta: snap.meta ?? EMPTY_META, ready: true } })
  } finally {
    loading.delete(id)
  }
}

export function dropChat(id: string): void {
  pendingOps.delete(id)
  const { [id]: _gone, ...rest } = useChat.getState()
  useChat.setState(rest, true)
}

// ---- composer drafts survive tab switches ----
export const useDrafts = create<Record<string, { text: string; images: { mediaType: string; data: string; name: string }[] }>>(() => ({}))
