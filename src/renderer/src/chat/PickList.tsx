import { useState } from 'react'
import { pickListAnswer } from '@shared/pickList'
import { api } from '../api'
import { toast } from '../store'
import { Icon } from '../components/Icon'
import { Markdown } from './Markdown'

// A pick list in an assistant's reply (shared/pickList.ts): its items as options to select, then
// "Answer" sends the picked ones back, asking the agent to complete them. Like a question card.

const storeKey = (sessionKey: string, id: string): string => `deck.pickList:${sessionKey}:${id}`

/** What a list was answered with (its picked items' positions), kept across reloads. */
function answeredWith(key: string): number[] | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null')
    return Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}

export function PickList({
  sessionId,
  sessionKey,
  id,
  title,
  items,
  complete,
  cwd,
  dark
}: {
  sessionId: string
  /** Stable across restarts (the chat's agent session id), for remembering the answer. */
  sessionKey: string
  /** This list within its message. */
  id: string
  title?: string
  items: string[]
  /** Still streaming in: shown, not answerable yet. */
  complete: boolean
  cwd: string
  dark: boolean
}) {
  const key = storeKey(sessionKey, id)
  const [answered, setAnswered] = useState<number[] | undefined>(() => answeredWith(key))
  const [picked, setPicked] = useState<number[]>([])
  const [note, setNote] = useState('')
  const open = complete && !answered
  const on = (i: number): boolean => (answered ? answered.includes(i) : picked.includes(i))
  const toggle = (i: number): void => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i].sort((a, b) => a - b)))

  const answer = async (): Promise<void> => {
    if (!picked.length) return
    try {
      await api.session.sendPrompt(sessionId, pickListAnswer(picked.map((i) => items[i]), note, title))
      localStorage.setItem(key, JSON.stringify(picked))
      setAnswered(picked)
    } catch (e) {
      toast(`Couldn't send: ${(e as Error).message}`, 'error')
    }
  }

  return (
    <div className={`question-card pick-list ${open ? 'pending' : ''}`} data-testid="pick-list">
      <div className="row" style={{ gap: 8 }}>
        <Icon name="list" size={14} style={{ color: 'var(--accent)' }} />
        <div className="q-text grow" style={{ margin: 0 }}>
          {title ?? 'Pick the items to complete'}
        </div>
        {open && items.length > 1 && (
          <button className="btn sm ghost" onClick={() => setPicked(picked.length === items.length ? [] : items.map((_, i) => i))}>
            {picked.length === items.length ? 'Select none' : 'Select all'}
          </button>
        )}
      </div>
      <div className="pick-items">
        {items.map((it, i) => (
          <button key={i} className={`q-opt pick-item ${on(i) ? 'on' : ''}`} disabled={!open} onClick={() => toggle(i)} aria-pressed={on(i)}>
            <span className="pick-box">{on(i) && <Icon name="check" size={11} />}</span>
            <div className="pick-body">
              <Markdown text={it} cwd={cwd} dark={dark} />
            </div>
          </button>
        ))}
        {!complete && <div className="muted" style={{ fontSize: 12 }}>Receiving the list…</div>}
      </div>
      {open ? (
        <>
          <input className="input" placeholder="Add a note (optional): order, constraints…" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void answer()} />
          <div className="row" style={{ justifyContent: 'flex-end', gap: 6 }}>
            <span className="muted grow" style={{ fontSize: 12 }}>
              {picked.length ? `${picked.length} of ${items.length} selected` : 'Select the items to complete'}
            </span>
            <button className="btn sm primary" disabled={!picked.length} onClick={() => void answer()}>
              Answer
            </button>
          </div>
        </>
      ) : (
        answered && (
          <div className="muted" style={{ fontSize: 12 }}>
            Answered: asked to complete {answered.length} of {items.length}
          </div>
        )
      )}
    </div>
  )
}
