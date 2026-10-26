import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import type { ProgressEvent } from '@shared/types'
import { progressFraction } from '@shared/progress'
import { useStore } from '../store'
import { Icon } from './Icon'

// ---------------- context menus ----------------
export interface MenuItem {
  label?: string
  icon?: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onClick?: () => unknown
}

const useMenu = create<{ x: number; y: number; items: MenuItem[] } | null>(() => null)

export function openMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuItem[]): void {
  e.preventDefault?.()
  e.stopPropagation?.()
  useMenu.setState({ x: e.clientX, y: e.clientY, items }, true)
}

export function openMenuAt(el: HTMLElement, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  useMenu.setState({ x: r.left, y: r.bottom + 4, items }, true)
}

export function MenuHost() {
  const m = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  useLayoutEffect(() => {
    if (!m || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.min(m.x, window.innerWidth - r.width - 8), y: Math.min(m.y, window.innerHeight - r.height - 8) })
  }, [m])
  useEffect(() => {
    if (!m) return
    const close = (): void => useMenu.setState(null, true)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [m])
  if (!m) return null
  return (
    <div className="menu" ref={ref} style={{ left: pos.x, top: pos.y }} onMouseDown={(e) => e.stopPropagation()}>
      {m.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <div
            key={i}
            className={`menu-item ${it.danger ? 'danger' : ''}`}
            style={it.disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
            onClick={() => {
              useMenu.setState(null, true)
              void it.onClick?.()
            }}
          >
            {it.icon ? <Icon name={it.icon} size={15} /> : <span style={{ width: 15 }} />}
            <span>{it.label}</span>
            {it.hint && <span className="hint">{it.hint}</span>}
          </div>
        )
      )}
    </div>
  )
}

// ---------------- modal ----------------
export function Modal({
  title,
  icon,
  onClose,
  children,
  footer,
  wide,
  className
}: {
  title?: ReactNode
  icon?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''} ${className ?? ''}`} role="dialog">
        {title !== undefined && (
          <div className="modal-head">
            {icon && <Icon name={icon} size={17} style={{ color: 'var(--accent)' }} />}
            <div className="grow">{title}</div>
            <button className="icon-btn" onClick={onClose} title="Close (Esc)">
              <Icon name="x" />
            </button>
          </div>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function Switch({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={title} role="switch" aria-checked={on} />
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, l]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {l}
        </button>
      ))}
    </div>
  )
}

/** How long a finished toast shows its full ring before it turns into a check. */
const FULL_RING_MS = 450

/**
 * An action's toast: a ring filling toward its ETA (learned from earlier runs) while it runs; when
 * done, the ring completes, shows full a moment, then becomes a check while the toast lingers.
 */
function ProgressToast({ p }: { p: ProgressEvent }) {
  const now = useNow(100)
  const elapsed = now - p.startedAt
  const done = p.state === 'done'
  const failed = p.state === 'error'
  const showCheck = done && !!p.doneAt && now - p.doneAt > FULL_RING_MS
  const f = done ? 1 : progressFraction(elapsed, p.expectedMs)
  const left = Math.ceil((p.expectedMs - elapsed) / 1000)
  const R = 9
  const C = 2 * Math.PI * R
  return (
    <div className={`toast progress-toast ${failed ? 'error' : done ? 'success' : ''}`} data-testid="progress-toast" data-state={p.state}>
      {failed ? (
        <Icon name="x" size={16} style={{ color: 'var(--danger)', flex: 'none' }} />
      ) : showCheck ? (
        <span className="progress-check">
          <Icon name="check" size={16} style={{ color: 'var(--success)' }} />
        </span>
      ) : (
        <svg width="24" height="24" viewBox="0 0 24 24" className="progress-ring" aria-label={`${Math.round(f * 100)}%`}>
          <circle cx="12" cy="12" r={R} className="track" />
          <circle cx="12" cy="12" r={R} className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - f)} transform="rotate(-90 12 12)" />
        </svg>
      )}
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">{p.label}</div>
        {(done || failed ? p.detail : true) && (
          <div className="sub ellipsis">{done || failed ? p.detail : `${p.detail ? `${p.detail} · ` : ''}${left > 0 ? `about ${left}s left` : 'taking longer than usual…'}`}</div>
        )}
      </div>
    </div>
  )
}

/** Transient toasts; `children` (sticky alerts) stack above them. */
export function Toasts({ children }: { children?: ReactNode }) {
  const toasts = useStore((s) => s.toasts)
  const progress = useStore((s) => s.progress)
  return (
    <div className="toasts">
      {children}
      {progress.map((p) => (
        <ProgressToast key={p.id} p={p} />
      ))}
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'x' : t.kind === 'success' ? 'check' : 'bell'} size={15} style={{ marginTop: 1, color: t.kind === 'error' ? 'var(--danger)' : t.kind === 'success' ? 'var(--success)' : 'var(--accent)' }} />
          <div className="grow">{t.text}</div>
          <button className="icon-btn sm" onClick={() => useStore.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) }))}>
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function PromptDialog() {
  const p = useStore((s) => s.prompt)
  const [v, setV] = useState('')
  useEffect(() => setV(p?.value ?? ''), [p])
  if (!p) return null
  const done = (val: string | null): void => {
    useStore.setState({ prompt: undefined })
    p.resolve(val)
  }
  return (
    <Modal
      title={p.title}
      onClose={() => done(null)}
      footer={
        <>
          <button className="btn" onClick={() => done(null)}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => done(v)}>
            OK
          </button>
        </>
      }
    >
      <div className="modal-body">
        {p.multiline ? (
          <textarea className="textarea" autoFocus value={v} placeholder={p.placeholder} onChange={(e) => setV(e.target.value)} rows={6} onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && done(v)} />
        ) : (
          <input
            className="input"
            autoFocus
            type={p.secret ? 'password' : 'text'}
            autoComplete={p.secret ? 'off' : undefined}
            spellCheck={p.secret ? false : undefined}
            value={v}
            placeholder={p.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && done(v)} />
        )}
      </div>
    </Modal>
  )
}

export const timeAgo = (ts?: number): string => {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`
  return new Date(ts).toLocaleDateString()
}

export const STATUS_LABEL: Record<string, string> = {
  starting: 'Starting',
  'waiting-auth': 'Waiting for sign-in',
  working: 'Working',
  'needs-input': 'Needs input',
  idle: 'Ready',
  blocked: 'Blocked',
  exited: 'Exited'
}

export function useNow(ms = 30_000): number {
  const [n, setN] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setN(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return n
}

/**
 * Run one async action at a time: calls made while one is running are dropped (a ref, so a
 * fast double-click can't get in before the re-render). `pending` is for disabling buttons.
 */
export function useExclusive(): [pending: boolean, run: (fn: () => Promise<unknown>) => Promise<void>] {
  const running = useRef(false)
  const [pending, setPending] = useState(false)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    if (running.current) return
    running.current = true
    setPending(true)
    try {
      await fn()
    } finally {
      running.current = false
      setPending(false)
    }
  }
  return [pending, run]
}

export function shortPath(p: string, home: string): string {
  if (home && p.toLowerCase().startsWith(home.toLowerCase())) return '~' + p.slice(home.length)
  return p
}

export function fuzzyScore(q: string, text: string): number {
  if (!q) return 1
  const t = text.toLowerCase()
  const qq = q.toLowerCase()
  const idx = t.indexOf(qq)
  if (idx >= 0) return 1000 - idx - t.length * 0.01
  let ti = 0
  let score = 0
  for (const ch of qq) {
    const f = t.indexOf(ch, ti)
    if (f < 0) return 0
    score += f === ti ? 3 : 1
    ti = f + 1
  }
  return score
}
