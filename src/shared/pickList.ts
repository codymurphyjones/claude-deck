// Pick lists: a list of items in an assistant's reply that the user picks from, then "Answer" asks
// the agent to complete the picked ones. The format (agents are told about it in their brief):
//
//   __________list__________          (optionally a title: __________list: Pick what to fix__________)
//   ----------
//   <item, markdown, any number of lines>
//   ----------
//   <item>
//   ----------
//   __________
//
// Underscore and dash runs are 3 or more characters; item separators sit on their own lines.

export type ReplySegment = { kind: 'text'; text: string } | { kind: 'list'; title?: string; items: string[]; complete: boolean }

const START = /^[ \t]*_{3,}[ \t]*list(?:[ \t]*:[ \t]*(.*?))?[ \t]*_{3,}[ \t]*$/i
const END = /^[ \t]*_{3,}[ \t]*$/
const SEP = /^[ \t]*-{3,}[ \t]*$/

/** Quick check before parsing. */
// (Not `list\b`: "_" is a word character, so `list___` has no word boundary.)
export const hasPickList = (text: string): boolean => /^[ \t]*_{3,}[ \t]*list(?![a-z0-9])/im.test(text)

/**
 * The reply as text and pick-list segments, in order. A list still streaming in (no closing line
 * yet) comes back with `complete: false`. Lines inside fenced code blocks are never list markers.
 */
export function splitPickLists(text: string): ReplySegment[] {
  const out: ReplySegment[] = []
  const lines = text.split('\n')
  let buf: string[] = []
  let list: { title?: string; items: string[]; cur: string[] | null } | null = null
  let fence = false
  const flushText = (): void => {
    const t = buf.join('\n')
    if (t.trim()) out.push({ kind: 'text', text: t })
    buf = []
  }
  const pushItem = (): void => {
    if (list?.cur) {
      const item = list.cur.join('\n').trim()
      if (item) list.items.push(item)
    }
  }
  for (const line of lines) {
    if (!list) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence
      const m = !fence && START.exec(line)
      if (m) {
        flushText()
        list = { title: m[1]?.trim() || undefined, items: [], cur: null }
      } else buf.push(line)
      continue
    }
    if (END.test(line)) {
      pushItem()
      out.push({ kind: 'list', title: list.title, items: list.items, complete: true })
      list = null
      continue
    }
    if (SEP.test(line)) {
      pushItem()
      list.cur = []
      continue
    }
    // Text before the first separator still belongs to an item (a missing leading separator).
    ;(list.cur ??= []).push(line)
  }
  if (list) {
    pushItem()
    out.push({ kind: 'list', title: list.title, items: list.items, complete: false })
  } else flushText()
  return out
}

/** The message "Answer" sends: the picked items, to be completed, plus any note. */
export function pickListAnswer(items: string[], note: string, title?: string): string {
  const head = items.length === 1 ? 'Please complete this item' : `Please complete these ${items.length} items`
  const from = title ? ` from "${title}"` : ' from your list'
  const body = items.map((it, i) => `${i + 1}. ${it.replace(/\n/g, '\n   ')}`).join('\n\n')
  return `${head}${from}:\n\n${body}${note.trim() ? `\n\n${note.trim()}` : ''}`
}
