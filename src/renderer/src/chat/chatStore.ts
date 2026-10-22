import { create } from 'zustand'
import { applyChatOp, type ChatItem, type ChatMeta, type ChatOp } from '@shared/chat'
import { api, bridge } from '../api'

export interface ChatState {
  items: ChatItem[]
  meta: ChatMeta
  ready: boolean
}

const EMPTY_META: ChatMeta = { commands: [], tools: [], busy: false, queued: 0 }

export const useChat = create<Record<string, ChatState>>(() => ({}))

const loading = new Set<string>()

bridge.on('chat:op', (id: string, op: ChatOp) => {
  const st = useChat.getState()[id]
  // Ops that arrive before the snapshot are already contained in it.
  if (!st?.ready) return
  useChat.setState({ [id]: { ...st, items: applyChatOp(st.items, op) } })
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
    useChat.setState({ [id]: { items: snap.items, meta: snap.meta ?? EMPTY_META, ready: true } })
  } finally {
    loading.delete(id)
  }
}

export function dropChat(id: string): void {
  const { [id]: _gone, ...rest } = useChat.getState()
  useChat.setState(rest, true)
}

// ---- composer drafts survive tab switches ----
export const useDrafts = create<Record<string, { text: string; images: { mediaType: string; data: string; name: string }[] }>>(() => ({}))
