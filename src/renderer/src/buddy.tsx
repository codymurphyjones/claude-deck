import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { api, bridge, type LiveSession } from './api'
import { Icon } from './components/Icon'
import { STATUS_LABEL } from './components/ui'
import { applyTheme, resolveTheme } from './theme'
import type { Settings } from '@shared/types'

function Buddy() {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  useEffect(() => {
    void api.init().then((d) => {
      setSessions(d.sessions)
      applyTheme(resolveTheme(d.settings, matchMedia('(prefers-color-scheme: dark)').matches), { ...d.settings, translucentSidebar: false })
    })
    const off1 = bridge.on('buddy:update', (list: LiveSession[]) => setSessions(list))
    const off2 = bridge.on('settings:changed', (s: Settings) => applyTheme(resolveTheme(s, matchMedia('(prefers-color-scheme: dark)').matches), { ...s, translucentSidebar: false }))
    return () => {
      off1()
      off2()
    }
  }, [])
  const list = sessions.filter((s) => s.kind === 'agent')
  const order = ['needs-input', 'waiting-auth', 'blocked', 'working', 'starting', 'idle', 'exited']
  list.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))
  const label = (s: LiveSession): string => (s.status === 'idle' ? (s.unread ? 'Ready for review' : 'Ready') : s.goal?.status === 'blocked' ? 'Blocked' : STATUS_LABEL[s.status])
  return (
    <div className="buddy">
      <div className="buddy-head">
        <span className="brand-mark">
          <Icon name="sparkles" size={12} stroke={2.4} />
        </span>
        <span className="grow">Claude Deck</span>
        <button className="icon-btn sm" title="Show Claude Deck" onClick={() => api.window.focusMain()}>
          <Icon name="external" size={13} />
        </button>
        <button className="icon-btn sm" title="Hide buddy" onClick={() => api.updateSettings({ buddy: false })}>
          <Icon name="x" size={13} />
        </button>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '0 6px 8px' }}>
        {!list.length && <div className="empty-note">No sessions running.</div>}
        {list.map((s) => (
          <div key={s.id} className="list-item" onClick={() => api.focusSession(s.id)} title={s.lastPrompt}>
            <span className={`dot ${s.status}`} />
            <div className="grow">
              <div className="ellipsis" style={{ fontWeight: s.unread || s.status === 'needs-input' ? 650 : 500 }}>
                {s.name}
              </div>
              <div className="sub ellipsis">{s.status === 'needs-input' && s.attention ? s.attention : label(s)}</div>
            </div>
            {s.pendingMessages > 0 && <span className="badge accent">{s.pendingMessages}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Buddy />)
