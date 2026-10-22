import { DEFAULT_SHORTCUTS } from '@shared/defaults'
import type { Settings } from '@shared/types'

/** Canonical string for a keyboard event, e.g. "Ctrl+Shift+K". */
export function eventCombo(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  let key = e.key
  if (e.code === 'Backquote') key = '`'
  else if (e.code === 'Comma') key = ','
  else if (e.code === 'Equal') key = '='
  else if (e.code === 'Minus') key = '-'
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (e.code.startsWith('Key')) key = e.code.slice(3)
  else if (key === ' ') key = 'Space'
  else if (key.startsWith('Arrow')) key = key.slice(5)
  else if (key.length === 1) key = key.toUpperCase()
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return parts.join('+')
  parts.push(key)
  return parts.join('+')
}

export function normalizeCombo(c: string): string {
  const parts = c.split('+').map((p) => p.trim())
  const key = parts.pop() ?? ''
  const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase() || (m === 'Ctrl' && /^(control|cmdorctrl)$/i.test(p))))
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+')
}

export function shortcutMap(s: Settings): Record<string, string> {
  return { ...DEFAULT_SHORTCUTS, ...s.shortcuts }
}

/** combo → command id */
export function comboIndex(s: Settings): Map<string, string> {
  const m = new Map<string, string>()
  for (const [cmd, combo] of Object.entries(shortcutMap(s))) if (combo) m.set(normalizeCombo(combo), cmd)
  for (let i = 1; i <= 9; i++) m.set(`Ctrl+${i}`, `tab${i}`)
  return m
}

export const prettyCombo = (c?: string): string => (c ? c.replace(/\+/g, ' + ') : '')
