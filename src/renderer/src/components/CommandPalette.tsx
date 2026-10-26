import { useEffect, useMemo, useRef, useState } from 'react'
import { providerOf } from '@shared/agent'
import { api } from '../api'
import { commands, SLASH_COMMANDS } from '../commands'
import { prettyCombo, shortcutMap } from '../shortcuts'
import { activeSession, focusSessionTab, openSession, resumeChat, set, useStore } from '../store'
import { Icon } from './Icon'
import { useRoutines } from './Jobs'
import { runRoutine } from './Routines'
import { fuzzyScore, Modal, timeAgo } from './ui'

interface Item {
  key: string
  group: string
  title: string
  sub?: string
  icon: string
  hint?: string
  run: () => unknown
  score: number
}

export function CommandPalette() {
  const mode = useStore((s) => s.palette)
  const sessions = useStore((s) => s.sessions)
  const lib = useStore((s) => s.library)
  const settings = useStore((s) => s.settings)
  const routines = useRoutines(!!mode)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode) {
      setQ('')
      setSel(0)
    }
  }, [mode])

  const items = useMemo<Item[]>(() => {
    if (!mode) return []
    const sc = shortcutMap(settings)
    const query = q.startsWith('>') || q.startsWith('/') ? q.slice(1).trim() : q.trim()
    const onlyCommands = q.startsWith('>')
    const onlySlash = q.startsWith('/')
    const active = activeSession()
    const out: Item[] = []
    const add = (it: Omit<Item, 'score'>, text: string): void => {
      const score = fuzzyScore(query, text)
      if (score > 0) out.push({ ...it, score })
    }
    if (!onlyCommands && !onlySlash) {
      for (const s of Object.values(sessions).filter((x) => x.kind !== 'shell'))
        add({ key: 's' + s.id, group: 'Open sessions', title: s.name, sub: s.cwd, icon: 'terminal', run: () => focusSessionTab(s.id) }, `${s.name} ${s.cwd}`)
    }
    if (!onlySlash)
      for (const c of commands().filter((c) => c.when?.() ?? true))
        add({ key: 'c' + c.id, group: 'Commands', title: c.title, icon: c.icon ?? 'zap', hint: prettyCombo(sc[c.id]), run: c.run }, `${c.title} ${c.group}`)
    // Claude's slash commands, for agents that take them (not Codex).
    if (active?.kind === 'agent' && !onlyCommands && providerOf(active.provider).caps.slashCommands)
      for (const [cmd, desc] of SLASH_COMMANDS)
        add({ key: 'sl' + cmd, group: 'Claude slash commands', title: cmd, sub: desc, icon: 'code', run: () => api.session.sendPrompt(active.id, cmd, 'steer') }, `${cmd} ${desc}`)
    if (!onlyCommands && !onlySlash) {
      if (active?.kind === 'agent')
        for (const t of settings.promptTemplates)
          add({ key: 'pt' + t.id, group: 'Prompt templates', title: t.name, sub: t.text, icon: 'note', run: () => set({ composerFor: active.id, composerPrefill: t.text }) }, `${t.name} ${t.text}`)
      for (const r of routines ?? [])
        add({ key: 'rt' + r.slug, group: 'Routines', title: `Run routine: ${r.name}`, sub: r.description, icon: 'wand', run: () => runRoutine(r.slug) }, `routine ${r.name} ${r.description}`)
      for (const c of lib.chats.filter((x) => !x.archived && !x.hidden).slice(0, 300))
        add(
          { key: 'ch' + c.agentSessionId, group: 'Chats', title: c.name, sub: `${c.cwd.split(/[\\/]/).pop()} · ${timeAgo(c.updatedAt)}${c.branch ? ` · ${c.branch}` : ''}`, icon: 'message', run: () => resumeChat(c.agentSessionId) },
          `${c.name} ${c.branch ?? ''} ${c.lastPrompt ?? ''}`
        )
      for (const p of lib.projects)
        add({ key: 'p' + p.id, group: 'Projects', title: `New chat in ${p.name}`, sub: p.folders[0], icon: 'folder', run: () => openSession('agent', { cwd: p.folders[0] }) }, `${p.name} ${p.folders.join(' ')}`)
    }
    const groupOrder = ['Open sessions', 'Commands', 'Claude slash commands', 'Prompt templates', 'Routines', 'Chats', 'Projects']
    if (query) out.sort((a, b) => b.score - a.score)
    else out.sort((a, b) => groupOrder.indexOf(a.group) - groupOrder.indexOf(b.group))
    return out.slice(0, 120)
  }, [mode, q, sessions, lib, settings, routines])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  if (!mode) return null
  const close = (): void => set({ palette: false })
  const runItem = (it: Item): void => {
    close()
    void it.run()
  }
  let lastGroup = ''
  return (
    <Modal onClose={close} className="palette">
      <input
        className="input palette-input"
        autoFocus
        placeholder="Search sessions, chats, commands…   ( > commands only · / slash commands )"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setSel(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setSel((s) => Math.min(items.length - 1, s + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setSel((s) => Math.max(0, s - 1))
          } else if (e.key === 'Enter' && items[sel]) runItem(items[sel])
        }}
      />
      <div className="palette-list" ref={listRef}>
        {!items.length && <div className="empty-note">No matches.</div>}
        {items.map((it, i) => {
          const header = !q && it.group !== lastGroup ? it.group : null
          lastGroup = it.group
          return (
            <div key={it.key}>
              {header && <div className="palette-group">{header}</div>}
              <div className={`palette-item ${i === sel ? 'sel' : ''}`} onMouseMove={() => i !== sel && setSel(i)} onClick={() => runItem(it)}>
                <Icon name={it.icon} size={15} style={{ color: 'var(--muted)' }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">{it.title}</div>
                  {it.sub && (
                    <div className="ellipsis muted" style={{ fontSize: 11.5 }}>
                      {it.sub}
                    </div>
                  )}
                </div>
                {q && <span className="hint">{it.group}</span>}
                {it.hint && <span className="kbd">{it.hint}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
