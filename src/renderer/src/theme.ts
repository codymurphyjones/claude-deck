import { BUILTIN_THEMES } from '@shared/themes'
import type { Settings, ThemeDef } from '@shared/types'

export function allThemes(s: Settings): ThemeDef[] {
  return [...BUILTIN_THEMES, ...s.customThemes]
}

export function resolveTheme(s: Settings, systemDark: boolean): ThemeDef {
  const dark = s.themeMode === 'dark' || (s.themeMode === 'system' && systemDark)
  const id = dark ? s.darkTheme : s.lightTheme
  const base = allThemes(s).find((t) => t.id === id) ?? BUILTIN_THEMES[dark ? 0 : 1]
  const ui = { ...base.ui }
  const terminal = { ...base.terminal }
  if (s.accentOverride) {
    ui.accent = s.accentOverride
    terminal.cursor = s.accentOverride
  }
  if (s.bgOverride) {
    ui.bg = s.bgOverride
    terminal.background = s.bgOverride
  }
  if (s.fgOverride) {
    ui.text = s.fgOverride
    terminal.foreground = s.fgOverride
  }
  if (s.contrast) {
    ui.border = mix(ui.border, base.dark ? '#ffffff' : '#000000', s.contrast * 0.25)
    ui.muted = mix(ui.muted, ui.text, s.contrast * 0.5)
  }
  return { ...base, ui, terminal }
}

function hexToRgb(h: string): [number, number, number] {
  let x = h.replace('#', '')
  if (x.length === 3) x = x.split('').map((c) => c + c).join('')
  const n = parseInt(x.slice(0, 6), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function mix(a: string, b: string, t: number): string {
  if (!a.startsWith('#') || !b.startsWith('#')) return a
  const A = hexToRgb(a)
  const B = hexToRgb(b)
  const k = Math.max(0, Math.min(1, t))
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * k).toString(16).padStart(2, '0')).join('')
}

export function withAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function applyTheme(theme: ThemeDef, s: Settings): void {
  const r = document.documentElement.style
  const u = theme.ui
  r.setProperty('--bg', u.bg)
  r.setProperty('--panel', u.panel)
  r.setProperty('--panel2', u.panel2)
  r.setProperty('--border', u.border)
  r.setProperty('--text', u.text)
  r.setProperty('--muted', u.muted)
  r.setProperty('--accent', u.accent)
  r.setProperty('--accent-soft', withAlpha(u.accent, 0.16))
  r.setProperty('--accent-text', theme.dark ? '#1a1a1a' : '#ffffff')
  r.setProperty('--danger', u.danger)
  r.setProperty('--success', u.success)
  r.setProperty('--warning', u.warning)
  r.setProperty('--hover', withAlpha(u.text, theme.dark ? 0.06 : 0.05))
  r.setProperty('--active', withAlpha(u.text, theme.dark ? 0.1 : 0.08))
  r.setProperty('--shadow', theme.dark ? '0 12px 40px rgba(0,0,0,.55)' : '0 12px 40px rgba(0,0,0,.16)')
  r.setProperty('--sidebar-bg', s.translucentSidebar ? withAlpha(u.panel, 0.72) : u.panel)
  r.setProperty('--titlebar-bg', s.translucentSidebar ? withAlpha(u.panel, 0.6) : u.panel)
  const t = theme.terminal
  for (const [k, v] of Object.entries({ red: t.red, green: t.green, yellow: t.yellow, blue: t.blue, magenta: t.magenta, cyan: t.cyan, gray: t.brightBlack, orange: t.brightYellow }))
    r.setProperty(`--t-${k}`, v)
  r.setProperty('--ui-font', s.uiFont)
  r.setProperty('--code-font', s.codeFont)
  r.setProperty('--ui-size', `${s.uiFontSize}px`)
  r.setProperty('--code-size', `${s.codeFontSize}px`)
  r.setProperty('--cursor', s.pointerCursors ? 'pointer' : 'default')
  document.documentElement.dataset.theme = theme.dark ? 'dark' : 'light'
  document.documentElement.classList.toggle('translucent', s.translucentSidebar)
}
