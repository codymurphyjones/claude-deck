import * as fs from 'fs'
import type { ChatItem } from '@shared/chat'

type Json = Record<string, unknown>

const isNoise = (t: string): boolean =>
  !t.trim() ||
  t.startsWith('<') ||
  t.startsWith('[Request interrupted') ||
  t.startsWith('Caveat:') ||
  t.includes('<command-name>') ||
  t.includes('<local-command-stdout>')

/** Rebuild chat items from a Claude Code transcript (best-effort; the format is internal). */
export function loadConversation(file: string | undefined, maxItems = 1500): ChatItem[] {
  if (!file) return []
  let data: string
  try {
    data = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const items: ChatItem[] = []
  const tools = new Map<string, Extract<ChatItem, { kind: 'tool' }>>()
  let n = 0
  for (const line of data.split('\n')) {
    if (!line || line.startsWith('{"type":"api-request')) continue
    let j: Json
    try {
      j = JSON.parse(line)
    } catch {
      continue
    }
    if (j.isSidechain) continue
    const ts = typeof j.timestamp === 'string' ? Date.parse(j.timestamp) : Date.now()
    const msg = j.message as Json | undefined
    if (j.type === 'user' && msg) {
      const content = msg.content
      if (typeof content === 'string') {
        if (!j.isMeta && !isNoise(content)) items.push({ kind: 'user', id: `h${n++}`, ts, text: content })
        continue
      }
      if (!Array.isArray(content)) continue
      const texts: string[] = []
      const images: string[] = []
      for (const c of content as Json[]) {
        if (c.type === 'text' && typeof c.text === 'string' && !isNoise(c.text)) texts.push(c.text)
        else if (c.type === 'image') {
          const src = c.source as Json
          if (src?.data) images.push(`data:${src.media_type};base64,${src.data}`)
        } else if (c.type === 'tool_result') {
          const t = tools.get(c.tool_use_id as string)
          if (!t) continue
          let text = ''
          if (typeof c.content === 'string') text = c.content
          else if (Array.isArray(c.content)) text = (c.content as Json[]).filter((p) => p.type === 'text').map((p) => p.text as string).join('\n')
          t.result = text.slice(0, 20_000)
          t.status = c.is_error ? (/denied|haven't granted|rejected/i.test(text) ? 'denied' : 'error') : 'done'
          t.endedAt = ts
        }
      }
      if ((texts.length || images.length) && !j.isMeta) items.push({ kind: 'user', id: `h${n++}`, ts, text: texts.join('\n'), images: images.length ? images : undefined })
    } else if (j.type === 'assistant' && msg) {
      for (const c of (msg.content as Json[]) ?? []) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) items.push({ kind: 'text', id: `h${n++}`, ts, text: c.text, streaming: false })
        else if (c.type === 'thinking' && typeof c.thinking === 'string' && c.thinking.trim()) items.push({ kind: 'thinking', id: `h${n++}`, ts, text: c.thinking, streaming: false })
        else if (c.type === 'tool_use') {
          const t: Extract<ChatItem, { kind: 'tool' }> = { kind: 'tool', id: c.id as string, ts, name: c.name as string, input: (c.input as Json) ?? {}, status: 'done' }
          tools.set(t.id, t)
          items.push(t)
        }
      }
    } else if (j.type === 'system' && j.subtype === 'turn_duration') {
      items.push({ kind: 'turn', id: `h${n++}`, ts, durationMs: Number(j.durationMs) || undefined })
    } else if (j.type === 'system' && j.subtype === 'compact_boundary') {
      items.push({ kind: 'notice', id: `h${n++}`, ts, text: 'Conversation compacted.', level: 'info' })
    }
  }
  return items.slice(-maxItems)
}
