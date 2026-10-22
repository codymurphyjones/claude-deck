import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatMeta } from '@shared/chat'
import { api, type LiveSession } from '../api'
import { SLASH_COMMANDS } from '../commands'
import { Icon } from '../components/Icon'
import { MODELS, MODES } from '../components/NewSessionDialog'
import { openMenuAt, fuzzyScore } from '../components/ui'
import { set, toast, useStore } from '../store'
import { useChat, useDrafts } from './chatStore'

const MODE_LABEL: Record<string, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
  auto: 'Auto',
  manual: 'Ask for everything',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions'
}

type Popup = { kind: 'slash' | 'file'; start: number; q: string } | null

async function fileToImage(f: File): Promise<{ mediaType: string; data: string; name: string } | undefined> {
  if (!f.type.startsWith('image/')) return undefined
  const url = await new Promise<string>((r) => {
    const fr = new FileReader()
    fr.onload = () => r(String(fr.result))
    fr.readAsDataURL(f)
  })
  const m = /^data:([^;]+);base64,(.*)$/.exec(url)
  return m ? { mediaType: m[1], data: m[2], name: f.name || 'image' } : undefined
}

export function ChatComposer({ session: s, meta }: { session: LiveSession; meta?: ChatMeta }) {
  const draft = useDrafts((d) => d[s.id]) ?? { text: '', images: [] }
  const settings = useStore((st) => st.settings)
  const composerFor = useStore((st) => st.composerFor)
  const prefill = useStore((st) => st.composerPrefill)
  const ta = useRef<HTMLTextAreaElement>(null)
  const [popup, setPopup] = useState<Popup>(null)
  const [sel, setSel] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const histIdx = useRef(-1)
  const busy = !!meta?.busy
  const setDraft = (patch: Partial<typeof draft>): void => useDrafts.setState({ [s.id]: { ...draft, ...patch } })

  // Commands like "Composer" or prompt templates focus/prefill this composer.
  useEffect(() => {
    if (composerFor !== s.id) return
    if (prefill) setDraft({ text: prefill })
    set({ composerFor: undefined, composerPrefill: undefined })
    requestAnimationFrame(() => ta.current?.focus())
  }, [composerFor])

  // Dropped files / images from the window drop overlay.
  useEffect(() => {
    const onInsert = async (e: Event): Promise<void> => {
      const { id, paths } = (e as CustomEvent<{ id: string; paths: string[] }>).detail
      if (id !== s.id) return
      const imgs: { mediaType: string; data: string; name: string }[] = []
      const others: string[] = []
      for (const p of paths) {
        if (/\.(png|jpe?g|gif|webp)$/i.test(p)) {
          const url = await window.deckBridge.call('image.fromPath', p).catch(() => '')
          const m = /^data:([^;]+);base64,(.*)$/.exec(String(url))
          if (m) imgs.push({ mediaType: m[1], data: m[2], name: p.split(/[\\/]/).pop() ?? 'image' })
        } else others.push(/\s/.test(p) ? `"${p}"` : p)
      }
      const cur = useDrafts.getState()[s.id] ?? { text: '', images: [] }
      useDrafts.setState({ [s.id]: { text: [cur.text, others.map((o) => `@${o}`).join(' ')].filter(Boolean).join(' '), images: [...cur.images, ...imgs] } })
      ta.current?.focus()
    }
    window.addEventListener('deck:insert', onInsert)
    return () => window.removeEventListener('deck:insert', onInsert)
  }, [s.id])

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(320, el.scrollHeight) + 'px'
  }, [draft.text])

  const slashItems = useMemo(() => {
    if (popup?.kind !== 'slash') return []
    const fromCli = meta?.commands?.length ? meta.commands.map((c) => [`/${c.name}`, c.description] as [string, string]) : SLASH_COMMANDS
    return fromCli
      .map(([n, d]) => ({ n, d, score: fuzzyScore(popup.q, n.slice(1)) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
  }, [popup, meta?.commands])

  const fileItems = useMemo(() => {
    if (popup?.kind !== 'file') return []
    return files
      .map((f) => ({ f, score: fuzzyScore(popup.q, f) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.f.length - b.f.length)
      .slice(0, 10)
  }, [popup, files])

  const count = popup?.kind === 'slash' ? slashItems.length : fileItems.length

  const onChange = (v: string, caret: number): void => {
    setDraft({ text: v })
    histIdx.current = -1
    void api.chat.typing(s.id)
    const before = v.slice(0, caret)
    const slash = /^\/([\w:-]*)$/.exec(before)
    const at = /(^|\s)@([^\s@]*)$/.exec(before)
    if (slash) setPopup({ kind: 'slash', start: 0, q: slash[1] })
    else if (at) {
      if (!files.length) void api.fs.listFiles(s.root).then(setFiles)
      setPopup({ kind: 'file', start: caret - at[2].length - 1, q: at[2] })
    } else setPopup(null)
    setSel(0)
  }

  const pick = (i: number): void => {
    if (!popup) return
    if (popup.kind === 'slash') {
      const it = slashItems[i]
      if (it) setDraft({ text: it.n + ' ' })
    } else {
      const it = fileItems[i]
      if (!it) return
      const t = draft.text
      const after = t.slice(popup.start + 1 + popup.q.length)
      setDraft({ text: `${t.slice(0, popup.start)}@${it.f} ${after.replace(/^\s/, '')}` })
    }
    setPopup(null)
    requestAnimationFrame(() => ta.current?.focus())
  }

  const send = (): void => {
    const text = draft.text.trim()
    if (!text && !draft.images.length) return
    if (s.status === 'exited') return toast('Resume the session first', 'error')
    void api.chat.send(s.id, text || 'See the attached image.', draft.images.length ? draft.images.map(({ mediaType, data }) => ({ mediaType, data })) : undefined)
    useDrafts.setState({ [s.id]: { text: '', images: [] } })
    setPopup(null)
  }

  const history = (): string[] =>
    (useChat.getState()[s.id]?.items ?? []).flatMap((i) => (i.kind === 'user' && !i.injected && i.text ? [i.text] : []))

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popup && count) {
      if (e.key === 'ArrowDown') return void (e.preventDefault(), setSel((x) => (x + 1) % count))
      if (e.key === 'ArrowUp') return void (e.preventDefault(), setSel((x) => (x - 1 + count) % count))
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) return void (e.preventDefault(), pick(sel))
      if (e.key === 'Escape') return void (e.preventDefault(), setPopup(null))
    }
    if (e.key === 'Escape' && busy) {
      e.preventDefault()
      void api.chat.interrupt(s.id)
      return
    }
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      void api.session.cycleMode(s.id)
      return
    }
    const sendKey = settings.chat.sendKey === 'enter' ? e.key === 'Enter' && !e.shiftKey && !e.ctrlKey : e.key === 'Enter' && (e.ctrlKey || e.metaKey)
    if (sendKey) {
      e.preventDefault()
      send()
      return
    }
    if (e.key === 'ArrowUp' && !draft.text) {
      const h = history()
      if (h.length) {
        e.preventDefault()
        histIdx.current = Math.min(h.length - 1, histIdx.current + 1)
        setDraft({ text: h[h.length - 1 - histIdx.current] })
      }
    }
  }

  const onPaste = async (e: React.ClipboardEvent): Promise<void> => {
    const fileItemsCb = [...e.clipboardData.items].filter((i) => i.type.startsWith('image/'))
    if (!fileItemsCb.length) return
    e.preventDefault()
    const imgs = (await Promise.all(fileItemsCb.map((i) => i.getAsFile()).filter(Boolean).map((f) => fileToImage(f!)))).filter(Boolean) as { mediaType: string; data: string; name: string }[]
    setDraft({ images: [...draft.images, ...imgs] })
  }

  const mode = s.permissionMode || settings.defaultPermissionMode || 'default'
  const model = (s.launch.model || meta?.model || settings.defaultModel || 'default').replace(/^claude-/, '')

  return (
    <div className="composer-wrap">
      <div className={`composer ${busy ? 'busy' : ''}`} onDragOver={(e) => e.preventDefault()}>
        {draft.images.length > 0 && (
          <div className="composer-attachments">
            {draft.images.map((im, i) => (
              <div key={i} className="attach">
                <img src={`data:${im.mediaType};base64,${im.data}`} />
                <button className="icon-btn sm" onClick={() => setDraft({ images: draft.images.filter((_, j) => j !== i) })}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ta}
          rows={1}
          className="composer-input"
          placeholder={busy ? 'Steer Claude, or queue a follow-up…' : `Message Claude in ${s.cwd.split(/[\\/]/).pop()} — @ to mention files, / for commands`}
          value={draft.text}
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => void onPaste(e)}
        />
        {popup && count > 0 && (
          <div className="composer-popup">
            {popup.kind === 'slash'
              ? slashItems.map((it, i) => (
                  <div key={it.n} className={`cp-item ${i === sel ? 'sel' : ''}`} onMouseDown={(e) => (e.preventDefault(), pick(i))} onMouseMove={() => setSel(i)}>
                    <span className="mono">{it.n}</span>
                    <span className="muted ellipsis">{it.d}</span>
                  </div>
                ))
              : fileItems.map((it, i) => (
                  <div key={it.f} className={`cp-item ${i === sel ? 'sel' : ''}`} onMouseDown={(e) => (e.preventDefault(), pick(i))} onMouseMove={() => setSel(i)}>
                    <Icon name="file" size={13} />
                    <span className="mono ellipsis">{it.f}</span>
                  </div>
                ))}
          </div>
        )}
        <div className="composer-bar">
          <button
            className="icon-btn sm"
            title="Attach image"
            onClick={async () => {
              const f = await api.dialog.openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }])
              if (!f) return
              window.dispatchEvent(new CustomEvent('deck:insert', { detail: { id: s.id, paths: [f] } }))
            }}
          >
            <Icon name="image" size={15} />
          </button>
          <button
            className={`chip ${mode === 'plan' ? 'plan' : mode === 'bypassPermissions' ? 'danger' : mode === 'acceptEdits' || mode === 'auto' ? 'accent' : ''}`}
            title="Permission mode (Shift+Tab to cycle)"
            onClick={(e) =>
              openMenuAt(
                e.currentTarget,
                MODES.filter(([v]) => v).map(([v, l]) => ({ label: l, icon: v === mode ? 'check' : undefined, onClick: () => api.chat.setMode(s.id, v) })).concat([{ label: 'Default', icon: mode === 'default' ? 'check' : undefined, onClick: () => api.chat.setMode(s.id, 'default') }])
              )
            }
          >
            <Icon name="shield" size={12} /> {MODE_LABEL[mode] ?? mode}
          </button>
          <button
            className="chip"
            title="Model"
            onClick={(e) => openMenuAt(e.currentTarget, MODELS.map(([v, l]) => ({ label: l, icon: (s.launch.model ?? '') === v ? 'check' : undefined, onClick: () => api.chat.setModel(s.id, v) })))}
          >
            <Icon name="sparkles" size={12} /> {model}
          </button>
          <button className="chip" title="Set a goal — Claude keeps going until it's done" onClick={() => set({ goalFor: s.id })}>
            <Icon name="target" size={12} /> Goal
          </button>
          {s.contextTokens ? (
            <span className="chip ghost" title="Context in use">
              <ContextRing tokens={s.contextTokens} /> {Math.round(s.contextTokens / 1000)}k
            </span>
          ) : null}
          <span className="grow" />
          {meta?.queued ? <span className="muted" style={{ fontSize: 11.5 }}>{meta.queued} queued</span> : null}
          {busy && (
            <button className="send-btn stop" title="Stop (Esc)" onClick={() => api.chat.interrupt(s.id)}>
              <Icon name="stop" size={13} />
            </button>
          )}
          <button className="send-btn" title={busy ? 'Send (queues after the current step)' : 'Send'} disabled={!draft.text.trim() && !draft.images.length} onClick={send}>
            <Icon name="arrow" size={15} style={{ transform: 'rotate(-90deg)' }} />
          </button>
        </div>
      </div>
    </div>
  )
}

function ContextRing({ tokens }: { tokens: number }) {
  const frac = Math.min(1, tokens / 200_000)
  const r = 6
  const c = 2 * Math.PI * r
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ transform: 'rotate(-90deg)' }}>
      <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
      <circle cx="8" cy="8" r={r} fill="none" stroke={frac > 0.8 ? 'var(--warning)' : 'var(--accent)'} strokeWidth="2.5" strokeDasharray={`${c * frac} ${c}`} strokeLinecap="round" />
    </svg>
  )
}
