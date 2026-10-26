import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PROVIDER_IDS, PROVIDERS, type ProviderId, type ProviderSettings } from '@shared/agent'
import { APP_TOOL_INFO, APP_TOOL_TIERS, appToolTier, RECOMMENDED_ALWAYS_ASK, type AppToolName } from '@shared/agentTools'
import { DEFAULT_SHORTCUTS } from '@shared/defaults'
import { formatDiagEntry, type DiagEntry } from '@shared/diagnostics'
import type { EnvAction, EnvironmentConfig, Insights, PromptTemplate, SessionTemplate, Settings, ThemeDef } from '@shared/types'
import { api } from '../api'
import { commands } from '../commands'
import { eventCombo, normalizeCombo, prettyCombo, shortcutMap } from '../shortcuts'
import { activeSession, attempt, resumeChat, set, signIn, signInWithApiKey, toast, useAuth, useStore } from '../store'
import { allThemes, resolveTheme } from '../theme'
import { Icon } from './Icon'
import { ProviderSeg } from './NewSessionDialog'
import { Modal, Seg, Switch, timeAgo } from './ui'
import { UpdatesSection } from './Updates'
import { providerLists, useProviderLists } from '../providerLists'

const NAV: [string, string, string][] = [
  ['general', 'General', 'settings'],
  ['appearance', 'Appearance', 'palette'],
  ['chat', 'Chat', 'message'],
  ['permissions', 'AI permissions', 'shield'],
  ['shortcuts', 'Keyboard shortcuts', 'keyboard'],
  ['notifications', 'Notifications', 'bell'],
  ['account', 'Account', 'user'],
  ['collaboration', 'Collaboration', 'users'],
  ['worktrees', 'Git & worktrees', 'branch'],
  ['templates', 'Templates', 'layers'],
  ['environment', 'Environments', 'play'],
  ['personalization', 'Personalization', 'note'],
  ['archived', 'Archived chats', 'archive'],
  ['profile', 'Profile & insights', 'activity'],
  ['updates', 'Updates & versions', 'download'],
  ['diagnostics', 'Diagnostics', 'activity'],
  ['about', 'About', 'sparkles']
]

function Row({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="label">
        <span>{label}</span>
        {desc && <span className="desc">{desc}</span>}
      </div>
      <div className="control">{children}</div>
    </div>
  )
}

export function SettingsModal() {
  const open = useStore((s) => s.settingsOpen)
  const settings = useStore((s) => s.settings)
  if (!open) return null
  const section = open.startsWith('env:') ? 'environment' : open
  const envRoot = open.startsWith('env:') ? open.slice(4) : undefined
  const update = (patch: Partial<Settings>): void => {
    void api.updateSettings(patch).then((s) => set({ settings: s }))
  }
  const close = (): void => set({ settingsOpen: false })
  return (
    <Modal wide title="Settings" icon="settings" onClose={close}>
      <div className="settings">
        <div className="settings-nav">
          {NAV.map(([id, label, icon]) => (
            <div key={id} className={`list-item ${section === id ? 'active' : ''}`} onClick={() => set({ settingsOpen: id })}>
              <Icon name={icon} size={15} /> {label}
            </div>
          ))}
        </div>
        <div className="settings-content">
          {section === 'general' && <General s={settings} update={update} />}
          {section === 'appearance' && <Appearance s={settings} update={update} />}
          {section === 'chat' && <ChatSection s={settings} update={update} />}
          {section === 'permissions' && <AiPermissions s={settings} update={update} />}
          {section === 'shortcuts' && <Shortcuts s={settings} update={update} />}
          {section === 'notifications' && <Notifications s={settings} update={update} />}
          {section === 'account' && <Account />}
          {section === 'collaboration' && <Collaboration s={settings} update={update} />}
          {section === 'worktrees' && <Worktrees s={settings} update={update} />}
          {section === 'templates' && <Templates s={settings} update={update} />}
          {section === 'environment' && <EnvironmentEditor initialRoot={envRoot} />}
          {section === 'personalization' && <Personalization />}
          {section === 'archived' && <Archived />}
          {section === 'profile' && <Profile />}
          {section === 'about' && <About />}
          {section === 'updates' && <UpdatesSection s={settings} update={update} />}
          {section === 'diagnostics' && <Diagnostics />}
        </div>
      </div>
    </Modal>
  )
}

type P = { s: Settings; update: (p: Partial<Settings>) => void }

function ProviderDefaults({ provider, s, update }: P & { provider: ProviderId }) {
  const desc = PROVIDERS[provider]
  const lists = useProviderLists(provider)
  const cur = s.providers[provider]
  const set = (patch: Partial<ProviderSettings>): void => update({ providers: { ...s.providers, [provider]: { ...cur, ...patch } } })
  return (
    <Row label={`${desc.label} defaults`} desc="Model, effort and permission mode for new sessions.">
      <div className="row">
        <select className="select" value={cur.defaultModel} onChange={(e) => set({ defaultModel: e.target.value })}>
          {lists.models.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select className="select" value={cur.defaultEffort} onChange={(e) => set({ defaultEffort: e.target.value })}>
          {lists.efforts.map((x) => (
            <option key={x} value={x}>
              {x ? `${x} effort` : 'Default effort'}
            </option>
          ))}
        </select>
        <select className="select" value={cur.defaultPermissionMode} onChange={(e) => set({ defaultPermissionMode: e.target.value })}>
          {desc.permissionModes.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
    </Row>
  )
}

function General({ s, update }: P) {
  const [explorer, setExplorer] = useState(false)
  return (
    <>
      <h3>Sessions</h3>
      <Row label="Restore sessions on launch" desc="Reopen the tabs you had open last time (conversations resume where they left off).">
        <Seg value={s.restoreSessions} onChange={(restoreSessions) => update({ restoreSessions })} options={[['ask', 'Ask'], ['always', 'Always'], ['never', 'Never']]} />
      </Row>
      <Row label="Follow-up behavior" desc="When you send a message while Claude is working: steer the current turn, or queue it for when the turn ends.">
        <Seg value={s.followUp} onChange={(followUp) => update({ followUp })} options={[['steer', 'Steer'], ['queue', 'Queue']]} />
      </Row>
      <Row label="Composer: Enter key" desc="In the rich composer (Ctrl+Shift+Enter).">
        <Seg value={s.composerEnter} onChange={(composerEnter) => update({ composerEnter })} options={[['enter', 'Enter sends'], ['ctrlEnter', 'Ctrl+Enter sends']]} />
      </Row>
      <Row label="Default agent" desc="Used for new sessions, jobs and scheduled tasks unless you pick another one.">
        <ProviderSeg value={s.defaultProvider} onChange={(defaultProvider) => update({ defaultProvider })} />
      </Row>
      {PROVIDER_IDS.map((p) => (
        <ProviderDefaults key={p} provider={p} s={s} update={update} />
      ))}
      <Row label="Goal mode limit" desc="Maximum automatic continuation turns before a goal pauses.">
        <input className="input" type="number" min={1} max={200} style={{ width: 90 }} value={s.goalMaxIterations} onChange={(e) => update({ goalMaxIterations: Math.max(1, +e.target.value) })} />
      </Row>
      <Row label="Prevent sleep while Claude is working">
        <Switch on={s.preventSleep} onChange={(preventSleep) => update({ preventSleep })} />
      </Row>
      <Row label="Open generated files automatically" desc="Show files in the Files panel as Claude writes them.">
        <Switch on={s.autoOpenFiles} onChange={(autoOpenFiles) => update({ autoOpenFiles })} />
      </Row>
      <h3>Terminal</h3>
      <Row label="Copy on select">
        <Switch on={s.copyOnSelect} onChange={(copyOnSelect) => update({ copyOnSelect })} />
      </Row>
      <Row label="Scrollback lines">
        <input className="input" type="number" min={1000} max={200000} step={1000} style={{ width: 110 }} value={s.scrollback} onChange={(e) => update({ scrollback: +e.target.value })} />
      </Row>
      <Row label="Integrated terminal shell" desc="Leave empty for PowerShell 7 (pwsh) if installed, otherwise Windows PowerShell.">
        <input className="input mono" placeholder="pwsh.exe" value={s.shell} onChange={(e) => update({ shell: e.target.value })} />
      </Row>
      {PROVIDER_IDS.map((p) => (
        <Row key={p} label={`${PROVIDERS[p].label} executable`} desc={`Leave empty to auto-detect (currently ${useStore.getState().agentPaths[p]}).`}>
          <input className="input mono" placeholder="auto" value={s.providers[p].path} onChange={(e) => update({ providers: { ...s.providers, [p]: { ...s.providers[p], path: e.target.value } } })} />
        </Row>
      ))}
      <h3>Window</h3>
      <Row label="Always on top">
        <Switch on={s.alwaysOnTop} onChange={(alwaysOnTop) => update({ alwaysOnTop })} />
      </Row>
      <Row label="Status buddy" desc="A small floating window showing every session's state while you work in other apps.">
        <Switch on={s.buddy} onChange={(buddy) => update({ buddy })} />
      </Row>
      <Row label="Explorer integration" desc="Add “Open in Claude Deck” to the right-click menu of folders and files.">
        <div className="row">
          <button className="btn sm" onClick={() => attempt(() => api.window.registerExplorerMenu(true), 'Added to Explorer').then(() => setExplorer(true))}>
            {explorer ? 'Re-register' : 'Add'}
          </button>
          <button className="btn sm ghost" onClick={() => attempt(() => api.window.registerExplorerMenu(false), 'Removed from Explorer')}>
            Remove
          </button>
        </div>
      </Row>
    </>
  )
}

function Appearance({ s, update }: P) {
  const systemDark = useStore((st) => st.systemDark)
  const themes = allThemes(s)
  const current = resolveTheme(s, systemDark)
  const swatch = (t: ThemeDef, key: 'darkTheme' | 'lightTheme') => (
    <div key={t.id} className={`theme-swatch ${s[key] === t.id ? 'on' : ''}`} onClick={() => update({ [key]: t.id })} title={t.name}>
      <div style={{ background: t.ui.bg, padding: 8, height: 54, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ height: 6, width: '60%', borderRadius: 3, background: t.ui.accent }} />
        <div style={{ height: 5, width: '80%', borderRadius: 3, background: t.ui.muted, opacity: 0.6 }} />
        <div style={{ height: 5, width: '45%', borderRadius: 3, background: t.terminal.green }} />
      </div>
      <div style={{ padding: '4px 8px', fontSize: 11.5, background: t.ui.panel, color: t.ui.text }}>{t.name}</div>
    </div>
  )
  const importTheme = async (): Promise<void> => {
    const text = await api.clipboard.readText()
    try {
      const t = JSON.parse(text) as ThemeDef
      if (!t.ui || !t.terminal || !t.name) throw new Error('Not a theme')
      const theme = { ...t, id: 'custom-' + Date.now().toString(36), custom: true }
      update({ customThemes: [...s.customThemes, theme], [theme.dark ? 'darkTheme' : 'lightTheme']: theme.id })
      toast(`Imported theme “${t.name}”`, 'success')
    } catch {
      toast('Copy a Claude Deck theme JSON to the clipboard first', 'error')
    }
  }
  return (
    <>
      <h3>Theme</h3>
      <Row label="Mode">
        <Seg value={s.themeMode} onChange={(themeMode) => update({ themeMode })} options={[['light', 'Light'], ['dark', 'Dark'], ['system', 'System']]} />
      </Row>
      <div className="label">Dark theme</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>{themes.filter((t) => t.dark).map((t) => swatch(t, 'darkTheme'))}</div>
      <div className="label">Light theme</div>
      <div className="row" style={{ flexWrap: 'wrap' }}>{themes.filter((t) => !t.dark).map((t) => swatch(t, 'lightTheme'))}</div>
      <Row label="Accent color">
        <div className="row">
          <input type="color" value={s.accentOverride ?? current.ui.accent} onChange={(e) => update({ accentOverride: e.target.value })} />
          <button className="btn sm ghost" onClick={() => update({ accentOverride: undefined })}>
            Reset
          </button>
        </div>
      </Row>
      <Row label="Background">
        <div className="row">
          <input type="color" value={s.bgOverride ?? current.ui.bg} onChange={(e) => update({ bgOverride: e.target.value })} />
          <button className="btn sm ghost" onClick={() => update({ bgOverride: undefined })}>
            Reset
          </button>
        </div>
      </Row>
      <Row label="Foreground">
        <div className="row">
          <input type="color" value={s.fgOverride ?? current.ui.text} onChange={(e) => update({ fgOverride: e.target.value })} />
          <button className="btn sm ghost" onClick={() => update({ fgOverride: undefined })}>
            Reset
          </button>
        </div>
      </Row>
      <Row label="Contrast">
        <input type="range" min={0} max={1} step={0.05} value={s.contrast} onChange={(e) => update({ contrast: +e.target.value })} />
      </Row>
      <Row label="Translucent window (Mica)">
        <Switch on={s.translucentSidebar} onChange={(translucentSidebar) => update({ translucentSidebar })} />
      </Row>
      <Row label="Pointer cursors">
        <Switch on={s.pointerCursors} onChange={(pointerCursors) => update({ pointerCursors })} />
      </Row>
      <Row label="Share themes" desc="Copy the current theme as JSON, or import one from the clipboard.">
        <div className="row">
          <button className="btn sm" onClick={() => api.clipboard.writeText(JSON.stringify({ name: current.name, dark: current.dark, ui: current.ui, terminal: current.terminal }, null, 2)).then(() => toast('Theme copied', 'success'))}>
            <Icon name="copy" size={12} /> Copy
          </button>
          <button className="btn sm" onClick={importTheme}>
            Import
          </button>
        </div>
      </Row>
      {s.customThemes.length > 0 && (
        <Row label="Custom themes">
          <div className="col" style={{ gap: 4 }}>
            {s.customThemes.map((t) => (
              <div key={t.id} className="row">
                <span className="grow">{t.name}</span>
                <button className="icon-btn sm" onClick={() => update({ customThemes: s.customThemes.filter((x) => x.id !== t.id) })}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        </Row>
      )}
      <h3>Fonts</h3>
      <Row label="UI font">
        <input className="input" value={s.uiFont} onChange={(e) => update({ uiFont: e.target.value })} />
      </Row>
      <Row label="UI font size">
        <input className="input" type="number" min={10} max={20} style={{ width: 80 }} value={s.uiFontSize} onChange={(e) => update({ uiFontSize: +e.target.value })} />
      </Row>
      <Row label="Code & terminal font">
        <input className="input mono" value={s.codeFont} onChange={(e) => update({ codeFont: e.target.value })} />
      </Row>
      <Row label="Code & terminal font size" desc="Also Ctrl + / Ctrl − / Ctrl 0.">
        <input className="input" type="number" min={8} max={32} style={{ width: 80 }} value={s.codeFontSize} onChange={(e) => update({ codeFontSize: +e.target.value })} />
      </Row>
    </>
  )
}

const MODE_HELP: Record<string, string> = {
  auto: 'Auto: a classifier approves routine actions without asking and blocks risky ones. You are only asked for rules on the list below.',
  manual: 'Ask for everything: Claude asks before every action that isn’t read-only.',
  acceptEdits: 'Accept edits: file edits go through; commands and other actions ask first.',
  plan: 'Plan: read-only until you approve a plan.',
  bypassPermissions: 'Bypass: nothing asks, not even the list below.',
  dontAsk: 'Don’t ask: anything that would prompt is denied instead.'
}

/** What agents may do without asking: the starting mode, checkpoints that always ask, and the app tools. */
function AiPermissions({ s, update }: P) {
  const ap = s.agentPermissions
  const set2 = (patch: Partial<Settings['agentPermissions']>): void => update({ agentPermissions: { ...ap, ...patch } })
  const prov = s.providers.claude
  const [globalMode, setGlobalMode] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    void api.agent.claudeDefaultMode().then(setGlobalMode, () => setGlobalMode(null))
  }, [])
  const effective = prov.defaultPermissionMode || globalMode || 'manual'
  const [askText, setAskText] = useState(ap.alwaysAsk.join('\n'))
  const saveAsk = (text: string): void => set2({ alwaysAsk: text.split('\n').map((l) => l.trim()).filter(Boolean) })
  const tools = Object.keys(APP_TOOL_TIERS) as AppToolName[]
  return (
    <>
      <h3>How Claude chats start</h3>
      <Row
        label="Permission mode"
        desc={
          <>
            {prov.defaultPermissionMode ? null : (
              <>
                “Default” uses your own Claude setting (<code>~/.claude/settings.json</code>), which is <b>{globalMode === undefined ? '…' : (globalMode ?? 'not set: ask for everything')}</b>.{' '}
              </>
            )}
            {MODE_HELP[effective] ?? ''}
          </>
        }
      >
        <select className="select" value={prov.defaultPermissionMode} onChange={(e) => update({ providers: { ...s.providers, claude: { ...prov, defaultPermissionMode: e.target.value } } })}>
          {PROVIDERS.claude.permissionModes.map(([v, l]) => (
            <option key={v} value={v}>
              {v ? l : `Default (${globalMode ?? 'your Claude setting'})`}
            </option>
          ))}
        </select>
      </Row>
      <Row label="Allow switching to Bypass mid-session" desc="Lets you pick Bypass permissions from a chat’s mode menu while it runs. Off: Bypass is only available for chats started in it. Doesn’t change how Auto behaves.">
        <Switch on={ap.allowBypassSwitch} onChange={(allowBypassSwitch) => set2({ allowBypassSwitch })} />
      </Row>

      <h3>Always ask before</h3>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        Claude stops and asks you before anything matching these rules, in every mode except Bypass, <b>including Auto</b>. One Claude permission rule per line, e.g. <code>Bash(git push *)</code>, <code>Bash(rm -rf *)</code>, <code>Write(src/**)</code>. A <code>Bash(…)</code> rule also covers the same command run through PowerShell (Claude uses either on Windows). Applies to Claude chats.
      </div>
      <textarea className="textarea mono" rows={9} value={askText} onChange={(e) => setAskText(e.target.value)} onBlur={() => saveAsk(askText)} spellCheck={false} />
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn sm"
          onClick={() => {
            const t = RECOMMENDED_ALWAYS_ASK.join('\n')
            setAskText(t)
            saveAsk(t)
          }}
        >
          Reset to recommended
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          {ap.alwaysAsk.length} rule{ap.alwaysAsk.length === 1 ? '' : 's'}
        </span>
      </div>

      <h3>Claude Deck tools</h3>
      <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
        Tools that let an agent act on this app. Everything they do is logged in the Timeline (right panel → Timeline → AI actions).
      </div>
      {tools.map((t) => {
        const tier = appToolTier(t, ap.appTools)
        return (
          <Row
            key={t}
            label={APP_TOOL_INFO[t]}
            desc={
              <>
                <code>{t}</code>
                {APP_TOOL_TIERS[t] === tier ? ' · default' : ''}
              </>
            }
          >
            <Seg
              value={tier}
              onChange={(v) => set2({ appTools: { ...ap.appTools, [t]: v === APP_TOOL_TIERS[t] ? undefined : v } })}
              options={[
                ['auto', 'Without asking'],
                ['confirm', 'Ask each time']
              ]}
            />
          </Row>
        )
      })}
      <div className="muted" style={{ fontSize: 12 }}>
        Changes apply to chats started or restarted from now on.
      </div>
    </>
  )
}

function ChatSection({ s, update }: P) {
  const c = s.chat
  const set2 = (patch: Partial<Settings['chat']>): void => update({ chat: { ...c, ...patch } })
  return (
    <>
      <h3>Claude's awareness of this UI</h3>
      <Row
        label="Tell Claude how its replies are rendered"
        desc="Claude learns it is shown in a rich chat: markdown, highlighted code with file labels, diffs, mermaid diagrams, charts, math, callouts and clickable file:line references. It then formats for this UI instead of a terminal."
      >
        <Switch on={c.uiAwareness} onChange={(uiAwareness) => set2({ uiAwareness })} />
      </Row>
      <label className="field">
        Extra rendering guidance for Claude (optional)
        <textarea
          className="textarea"
          rows={4}
          value={c.renderingGuidance}
          placeholder={'e.g. Start every answer with a one-line TL;DR.\nUse mermaid sequence diagrams when explaining request flows.\nSummarize changes as a table of file → change.'}
          onChange={(e) => set2({ renderingGuidance: e.target.value })}
        />
      </label>
      <div className="muted" style={{ fontSize: 12 }}>
        Applies to sessions started from now on.
      </div>
      <h3>Layout</h3>
      <Row label="Message width">
        <Seg value={c.width} onChange={(width) => set2({ width })} options={[['narrow', 'Narrow'], ['wide', 'Wide'], ['full', 'Full']]} />
      </Row>
      <Row label="Density">
        <Seg value={c.density} onChange={(density) => set2({ density })} options={[['comfortable', 'Comfortable'], ['compact', 'Compact']]} />
      </Row>
      <Row label="Chat font size">
        <input className="input" type="number" min={11} max={22} style={{ width: 80 }} value={c.fontSize} onChange={(e) => set2({ fontSize: +e.target.value })} />
      </Row>
      <h3>Behavior</h3>
      <Row label="Thinking" desc="How Claude's reasoning appears.">
        <Seg value={c.thinking} onChange={(thinking) => set2({ thinking })} options={[['collapsed', 'Collapsed'], ['expanded', 'Expanded'], ['hidden', 'Hidden']]} />
      </Row>
      <Row label="Tool activity" desc="Grouped collapses finished steps into a one-line summary.">
        <Seg value={c.tools} onChange={(tools) => set2({ tools })} options={[['grouped', 'Grouped'], ['expanded', 'Always expanded']]} />
      </Row>
      <Row label="Send with">
        <Seg value={c.sendKey} onChange={(sendKey) => set2({ sendKey })} options={[['enter', 'Enter'], ['ctrlEnter', 'Ctrl+Enter']]} />
      </Row>
    </>
  )
}

function Shortcuts({ s, update }: P) {
  const [q, setQ] = useState('')
  const [recordFor, setRecordFor] = useState<string | null>(null)
  const [keySearch, setKeySearch] = useState<string | null>(null)
  const map = shortcutMap(s)
  useEffect(() => {
    if (!recordFor && keySearch === null) return
    const onKey = (e: KeyboardEvent): void => {
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      const combo = eventCombo(e)
      if (keySearch !== null) {
        setKeySearch(combo)
        return
      }
      if (e.key === 'Escape') return setRecordFor(null)
      update({ shortcuts: { ...s.shortcuts, [recordFor!]: e.key === 'Backspace' ? '' : combo } })
      setRecordFor(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recordFor, keySearch, s.shortcuts])
  const list = commands().filter((c) => !c.id.startsWith('tab'))
  const shown = list.filter((c) => {
    if (keySearch) return normalizeCombo(map[c.id] ?? '') === normalizeCombo(keySearch)
    return !q || c.title.toLowerCase().includes(q.toLowerCase())
  })
  return (
    <>
      <div className="row">
        <input className="input" placeholder="Search commands…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className={`btn ${keySearch !== null ? 'primary' : ''}`} onClick={() => setKeySearch(keySearch === null ? '' : null)}>
          <Icon name="keyboard" size={13} /> {keySearch === null ? 'Search by keystroke' : keySearch ? prettyCombo(keySearch) : 'Press keys…'}
        </button>
        <button className="btn ghost" onClick={() => update({ shortcuts: {} })}>
          Reset all
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12 }}>
        Click a shortcut to change it (Backspace clears, Esc cancels). Shortcuts are handled before the terminal, so avoid keys Claude Code uses (Shift+Tab, Esc, Ctrl+C…).
      </div>
      {shown.map((c) => {
        const combo = map[c.id]
        const custom = s.shortcuts[c.id] !== undefined && s.shortcuts[c.id] !== DEFAULT_SHORTCUTS[c.id]
        return (
          <div key={c.id} className="setting" style={{ padding: '6px 0' }}>
            <div className="label">
              <span>{c.title}</span>
              <span className="desc">{c.group}</span>
            </div>
            <div className="row">
              {custom && (
                <button
                  className="icon-btn sm"
                  title="Reset to default"
                  onClick={() => {
                    const { [c.id]: _x, ...rest } = s.shortcuts
                    update({ shortcuts: rest })
                  }}
                >
                  <Icon name="undo" size={12} />
                </button>
              )}
              <button className={`btn sm ${recordFor === c.id ? 'primary' : ''}`} style={{ minWidth: 130 }} onClick={() => setRecordFor(c.id)}>
                {recordFor === c.id ? 'Press keys…' : combo ? prettyCombo(combo) : <span className="muted">unassigned</span>}
              </button>
            </div>
          </div>
        )
      })}
    </>
  )
}

function Notifications({ s, update }: P) {
  const n = s.notifications
  return (
    <>
      <Row label="Turn complete" desc="Notify when Claude finishes a turn.">
        <Seg value={n.turnComplete} onChange={(turnComplete) => update({ notifications: { ...n, turnComplete } })} options={[['never', 'Never'], ['background', 'In background'], ['always', 'Always']]} />
      </Row>
      <Row label="Permission requests" desc="Claude is waiting for you to approve a tool call.">
        <Switch on={n.permission} onChange={(permission) => update({ notifications: { ...n, permission } })} />
      </Row>
      <Row label="Questions & blocked goals">
        <Switch on={n.question} onChange={(question) => update({ notifications: { ...n, question } })} />
      </Row>
      <Row label="Play sound">
        <Switch on={n.sound} onChange={(sound) => update({ notifications: { ...n, sound } })} />
      </Row>
      <div className="muted" style={{ fontSize: 12 }}>
        Windows may need notifications enabled for Claude Deck in Settings → System → Notifications. The taskbar button also flashes when a background session needs you.
      </div>
    </>
  )
}

function Account() {
  return (
    <>
      {PROVIDER_IDS.map((p) => (
        <ProviderAccount key={p} provider={p} />
      ))}
    </>
  )
}

function ProviderAccount({ provider }: { provider: ProviderId }) {
  const auth = useAuth(provider)
  const label = PROVIDERS[provider].label
  return (
    <>
      <h3>{label}</h3>
      <Row label="Status">
        {auth.loggedIn ? <span className="badge ok">Signed in</span> : <span className="badge warn">{auth.checked ? 'Signed out' : 'Checking…'}</span>}
      </Row>
      {auth.email && <Row label="Account">{auth.email}</Row>}
      {auth.orgName && <Row label="Organization">{auth.orgName}</Row>}
      {(auth.subscriptionType || auth.authMethod) && <Row label="Plan / method">{[auth.subscriptionType, auth.authMethod].filter(Boolean).join(' · ')}</Row>}
      {auth.error && <div className="muted mono" style={{ fontSize: 12 }}>{auth.error}</div>}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={() => (set({ settingsOpen: false }), signIn({}, provider))}>
          <Icon name="login" size={13} /> {auth.loggedIn ? 'Switch account' : `Sign in to ${label}`}
        </button>
        {provider === 'claude' && (
          <>
            <button className="btn" onClick={() => (set({ settingsOpen: false }), signIn({ console: true }, provider))}>
              Use Anthropic Console (API billing)
            </button>
            <button className="btn" onClick={() => (set({ settingsOpen: false }), signIn({ sso: true }, provider))}>
              SSO
            </button>
          </>
        )}
        {provider === 'codex' && (
          <>
            <button className="btn" onClick={() => (set({ settingsOpen: false }), signIn({ device: true }, provider))}>
              Device code
            </button>
            <button className="btn" onClick={() => signInWithApiKey(provider)}>
              API key
            </button>
          </>
        )}
        <button className="btn ghost" onClick={() => api.auth.refresh(provider)}>
          <Icon name="refresh" size={13} /> Refresh
        </button>
        {auth.loggedIn && (
          <button className="btn danger" onClick={() => api.auth.logout(provider)}>
            <Icon name="logout" size={13} /> Sign out
          </button>
        )}
      </div>
    </>
  )
}

function Collaboration({ s, update }: P) {
  const m = s.mesh
  const set2 = (patch: Partial<Settings['mesh']>): void => update({ mesh: { ...m, ...patch } })
  return (
    <>
      <div className="muted" style={{ lineHeight: 1.55 }}>
        Sessions working in the same folder — or in worktrees of the same repository — form a team. Each session is told who else is active and what they're doing, gets a shared task board, notes and messaging tools (the <code>deck-mesh</code> MCP server), and edits are guarded so two sessions don't trample the same file.
      </div>
      <Row label="Enable collaboration">
        <Switch on={m.enabled} onChange={(enabled) => set2({ enabled })} />
      </Row>
      <Row label="Group worktrees with their repository" desc="Sessions in different worktrees of one repo are peers (claims use repo-relative paths).">
        <Switch on={m.repoPeers} onChange={(repoPeers) => set2({ repoPeers })} />
      </Row>
      <Row label="When a file is claimed by a peer" desc="What happens if a session tries to edit a file another session claimed.">
        <Seg value={m.claimMode} onChange={(claimMode) => set2({ claimMode })} options={[['ask', 'Ask me'], ['deny', 'Block'], ['off', 'Allow']]} />
      </Row>
      <Row label="Stale-read guard" desc="Stop an edit if a peer changed the file since this session last read it (Claude re-reads, then retries).">
        <Switch on={m.staleReadGuard} onChange={(staleReadGuard) => set2({ staleReadGuard })} />
      </Row>
      <Row label="Wake idle sessions for messages" desc="Deliver requests/questions to idle sessions immediately by typing them in.">
        <Switch on={m.autoWake} onChange={(autoWake) => set2({ autoWake })} />
      </Row>
      <Row label="…but not if I typed in the session within" desc="Protects anything you're in the middle of typing.">
        <div className="row">
          <input className="input" type="number" min={0} max={300} style={{ width: 80 }} value={Math.round(m.autoWakeIdleMs / 1000)} onChange={(e) => set2({ autoWakeIdleMs: Math.max(0, +e.target.value) * 1000 })} />
          <span className="muted">seconds</span>
        </div>
      </Row>
      <div className="muted" style={{ fontSize: 12 }}>Changes apply to sessions started from now on.</div>
    </>
  )
}

function Worktrees({ s, update }: P) {
  const wts = useStore((st) => st.library.worktrees)
  const w = s.worktrees
  const g = s.git
  return (
    <>
      <h3>Commits</h3>
      <Row
        label="Commit prefix"
        desc={
          <>
            Put in front of every commit message Claude Deck makes, e.g. <code>CJ |</code> gives <code>CJ | Add search</code>. Drafted messages aren't changed; the prefix is added when you commit.
          </>
        }
      >
        <CommitPrefixInput value={g.commitPrefix} onChange={(commitPrefix) => update({ git: { ...g, commitPrefix } })} />
      </Row>
      <h3>Worktrees</h3>
      <Row
        label="Each chat works in its own worktree"
        desc="New chats in a Git repo get their own copy (in Claude Deck's data folder) on a branch of their own, off the branch you pick (by default, the one your folder has checked out). Merge into <branch> brings the work back: your folder updates right away if it's on that branch (or after you confirm, if it has uncommitted changes); a branch your folder isn't on is checked out in Claude Deck's data folder and updated there. Nothing is pushed for you: push the branch when you're ready. Turn off to have chats edit your folder directly; you can also choose per chat in New session."
      >
        <Switch on={w.perChat} onChange={(perChat) => update({ worktrees: { ...w, perChat } })} />
      </Row>
      <Row label="Share installed packages with worktrees" desc="Links the repo's node_modules folders into each new worktree, so scripts and tests run there without reinstalling.">
        <Switch on={w.linkNodeModules} onChange={(linkNodeModules) => update({ worktrees: { ...w, linkNodeModules } })} />
      </Row>
      <Row label="Worktree folder" desc="Where managed worktrees are created. Empty = Claude Deck's data folder.">
        <div className="row">
          <input className="input mono" value={w.root} placeholder="default" onChange={(e) => update({ worktrees: { ...w, root: e.target.value } })} />
          <button className="btn sm" onClick={async () => update({ worktrees: { ...w, root: (await api.dialog.openFolder())[0] ?? w.root } })}>
            Browse
          </button>
        </div>
      </Row>
      <Row label="Automatic cleanup" desc="Delete old managed worktrees (a snapshot is kept so they can be restored). Pinned chats, running sessions and permanent worktrees are never deleted.">
        <Switch on={w.autoDelete} onChange={(autoDelete) => update({ worktrees: { ...w, autoDelete } })} />
      </Row>
      <Row label="Keep the most recent">
        <input className="input" type="number" min={1} max={200} style={{ width: 80 }} value={w.keep} onChange={(e) => update({ worktrees: { ...w, keep: Math.max(1, +e.target.value) } })} />
      </Row>
      <Row label="Clean up merged worktrees" desc="Every 10 minutes, ask GitHub (gh) for merged pull requests. A worktree whose branch was merged is deleted along with its local branch, if it has no uncommitted or unmerged work. Pinned chats, running sessions and permanent worktrees are skipped.">
        <Switch on={w.cleanupMerged} onChange={(cleanupMerged) => update({ worktrees: { ...w, cleanupMerged } })} />
      </Row>
      <Row label="Also delete the remote branch" desc="Only when nobody has pushed to it since the merge.">
        <Switch on={w.deleteRemoteMerged} onChange={(deleteRemoteMerged) => update({ worktrees: { ...w, deleteRemoteMerged } })} />
      </Row>
      <Row label="Branch prefix" desc="Used by “Create branch here” and handoffs.">
        <input className="input mono" style={{ width: 160 }} value={w.branchPrefix} onChange={(e) => update({ worktrees: { ...w, branchPrefix: e.target.value } })} />
      </Row>
      <div className="muted" style={{ fontSize: 12 }}>
        Put a <code>.worktreeinclude</code> file in a repository root (gitignore-style patterns, e.g. <code>.env</code>) to copy ignored files into new worktrees.
      </div>
      <h3>Worktrees ({wts.length})</h3>
      {wts.map((x) => (
        <div key={x.id} className="setting" style={{ padding: '6px 0' }}>
          <div className="label">
            <span className="mono" style={{ fontSize: 12 }}>
              {x.path}
            </span>
            <span className="desc">
              {x.permanent ? 'permanent' : 'managed'} · {x.deleted ? 'deleted (snapshot kept)' : 'active'} · used {timeAgo(x.lastUsed)} {x.branch ? `· ${x.branch}` : ''}
            </span>
          </div>
          <div className="row">
            {x.deleted ? (
              <button className="btn sm" onClick={() => attempt(() => api.worktree.restore(x.id), 'Restored')}>
                Restore
              </button>
            ) : (
              <button className="btn sm danger" onClick={() => attempt(() => api.worktree.delete(x.id), 'Deleted (snapshot kept)')}>
                Delete
              </button>
            )}
            <button className="icon-btn sm" title="Forget" onClick={() => api.worktree.forget(x.id)}>
              <Icon name="x" size={12} />
            </button>
          </div>
        </div>
      ))}
    </>
  )
}

function Templates({ s, update }: P) {
  const setTpl = (i: number, patch: Partial<SessionTemplate>): void => update({ sessionTemplates: s.sessionTemplates.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
  const setPt = (i: number, patch: Partial<PromptTemplate>): void => update({ promptTemplates: s.promptTemplates.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
  return (
    <>
      <h3>Session templates</h3>
      <div className="muted" style={{ fontSize: 12 }}>Reusable launch recipes: pick one when starting a session, or Alt-drop a folder to choose.</div>
      {s.sessionTemplates.map((t, i) => (
        <div key={t.id} className="card col" style={{ boxShadow: 'none', padding: 12, gap: 8 }}>
          <div className="row">
            <input className="input" value={t.name} onChange={(e) => setTpl(i, { name: e.target.value })} />
            <button className="icon-btn" onClick={() => update({ sessionTemplates: s.sessionTemplates.filter((_, j) => j !== i) })}>
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="row">
            <select className="select" value={t.provider ?? ''} onChange={(e) => setTpl(i, { provider: (e.target.value || undefined) as ProviderId | undefined, model: undefined, permissionMode: undefined })}>
              <option value="">Default agent</option>
              {PROVIDER_IDS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDERS[p].label}
                </option>
              ))}
            </select>
            <select className="select" value={t.model ?? ''} onChange={(e) => setTpl(i, { model: e.target.value || undefined })}>
              {providerLists(t.provider ?? s.defaultProvider).models.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select className="select" value={t.permissionMode ?? ''} onChange={(e) => setTpl(i, { permissionMode: e.target.value || undefined })}>
              {PROVIDERS[t.provider ?? s.defaultProvider].permissionModes.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <select className="select" value={t.role ?? 'free'} onChange={(e) => setTpl(i, { role: e.target.value as SessionTemplate['role'] })}>
              {['free', 'lead', 'worker', 'driver', 'reviewer'].map((r) => (
                <option key={r} value={r}>
                  {r === 'free' ? 'no role' : r}
                </option>
              ))}
            </select>
          </div>
          <textarea className="textarea" rows={2} style={{ minHeight: 50 }} placeholder="Extra system prompt (optional)" value={t.appendSystemPrompt ?? ''} onChange={(e) => setTpl(i, { appendSystemPrompt: e.target.value || undefined })} />
          <input className="input" placeholder="First prompt (optional)" value={t.initialPrompt ?? ''} onChange={(e) => setTpl(i, { initialPrompt: e.target.value || undefined })} />
          <div className="row">
            <Switch on={!!t.useWorktree} onChange={(useWorktree) => setTpl(i, { useWorktree })} /> <span>Always use a new worktree</span>
            <Switch on={!!t.remoteControl} onChange={(remoteControl) => setTpl(i, { remoteControl })} /> <span>Remote Control</span>
          </div>
        </div>
      ))}
      <button className="btn" onClick={() => update({ sessionTemplates: [...s.sessionTemplates, { id: 'tpl-' + Date.now().toString(36), name: 'New template' }] })}>
        <Icon name="plus" size={13} /> Add session template
      </button>
      <h3>Prompt templates</h3>
      {s.promptTemplates.map((t, i) => (
        <div key={t.id} className="row" style={{ alignItems: 'flex-start' }}>
          <input className="input" style={{ width: 180 }} value={t.name} onChange={(e) => setPt(i, { name: e.target.value })} />
          <textarea className="textarea" rows={2} style={{ minHeight: 40 }} value={t.text} onChange={(e) => setPt(i, { text: e.target.value })} />
          <button className="icon-btn" onClick={() => update({ promptTemplates: s.promptTemplates.filter((_, j) => j !== i) })}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => update({ promptTemplates: [...s.promptTemplates, { id: 'pt-' + Date.now().toString(36), name: 'New prompt', text: '' }] })}>
        <Icon name="plus" size={13} /> Add prompt template
      </button>
      <h3>Code review instructions</h3>
      <textarea className="textarea" rows={4} placeholder="Criteria applied when Claude reviews pull requests (e.g. focus on security and API compatibility; report as a ranked list)." value={s.reviewInstructions} onChange={(e) => update({ reviewInstructions: e.target.value })} />
    </>
  )
}

const ACTION_ICONS = ['play', 'terminal', 'check', 'refresh', 'zap', 'globe', 'code', 'upload', 'download', 'trash', 'sparkles', 'activity']

function EnvironmentEditor({ initialRoot }: { initialRoot?: string }) {
  const projects = useStore((s) => s.library.projects)
  const [root, setRoot] = useState(initialRoot ?? activeSession()?.root ?? projects[0]?.folders[0] ?? '')
  const [cfg, setCfg] = useState<EnvironmentConfig | null>(null)
  useEffect(() => {
    if (root) void api.env.load(root).then(setCfg)
  }, [root])
  const save = (): Promise<unknown> | undefined => cfg ? attempt(() => api.env.save(root, cfg), 'Saved .claude-deck/environment.json') : undefined
  const setAction = (i: number, patch: Partial<EnvAction>): void => setCfg((c) => c && { ...c, actions: c.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) })
  return (
    <>
      <div className="muted" style={{ lineHeight: 1.5 }}>
        A local environment lives in <code>.claude-deck/environment.json</code> in the project (commit it to share). <b>Setup scripts</b> run in the integrated terminal whenever a new worktree is created; <b>actions</b> appear as buttons in the session header.
      </div>
      <Row label="Project">
        <select className="select" value={root} onChange={(e) => setRoot(e.target.value)}>
          {[...new Set([root, ...projects.flatMap((p) => p.folders)])].filter(Boolean).map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </Row>
      {cfg && (
        <>
          <h3>Setup script</h3>
          {(['default', 'windows', 'macos', 'linux'] as const).map((k) => (
            <label key={k} className="field">
              {k === 'default' ? 'All platforms' : `${k} (overrides)`}
              <textarea className="textarea mono" rows={2} style={{ minHeight: 44 }} placeholder={k === 'default' ? 'npm install' : ''} value={cfg.setup?.[k] ?? ''} onChange={(e) => setCfg({ ...cfg, setup: { ...cfg.setup, [k]: e.target.value } })} />
            </label>
          ))}
          <h3>Actions</h3>
          {cfg.actions.map((a, i) => (
            <div key={a.id} className="card col" style={{ boxShadow: 'none', padding: 10, gap: 6 }}>
              <div className="row">
                <select className="select" style={{ width: 120 }} value={a.icon} onChange={(e) => setAction(i, { icon: e.target.value })}>
                  {ACTION_ICONS.map((ic) => (
                    <option key={ic}>{ic}</option>
                  ))}
                </select>
                <input className="input" value={a.name} placeholder="Dev server" onChange={(e) => setAction(i, { name: e.target.value })} />
                <button className="icon-btn" onClick={() => setCfg({ ...cfg, actions: cfg.actions.filter((_, j) => j !== i) })}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
              <input className="input mono" value={a.command} placeholder="npm run dev" onChange={(e) => setAction(i, { command: e.target.value })} />
              <input className="input mono" value={a.windows ?? ''} placeholder="Windows override (optional)" onChange={(e) => setAction(i, { windows: e.target.value || undefined })} />
            </div>
          ))}
          <div className="row">
            <button className="btn" onClick={() => setCfg({ ...cfg, actions: [...cfg.actions, { id: 'a' + Date.now().toString(36), name: 'New action', icon: 'play', command: '' }] })}>
              <Icon name="plus" size={13} /> Add action
            </button>
            <span className="grow" />
            <button className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </>
      )}
    </>
  )
}

function Personalization() {
  const session = activeSession()
  const [provider, setProvider] = useState<ProviderId>(session?.provider ?? useStore.getState().settings.defaultProvider)
  const fileName = PROVIDERS[provider].instructionsFile
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [file, setFile] = useState('')
  const [content, setContent] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    void api.instructions.read(provider, scope === 'project' ? session?.root : undefined).then((r) => {
      setFile(r.file)
      setContent(r.content)
      setDirty(false)
    })
  }, [scope, provider])
  return (
    <>
      <div className="muted" style={{ lineHeight: 1.5 }}>
        {PROVIDERS[provider].label} reads <code>{fileName}</code> files as standing instructions. Your personal file applies to every project on this machine; a project file applies to everyone working in that repository.
      </div>
      <ProviderSeg value={provider} onChange={setProvider} />
      <Seg value={scope} onChange={setScope} options={[['user', `Personal (${fileName})`], ...(session ? ([['project', `Project (${session.root.split(/[\\/]/).pop()})`]] as ['project', string][]) : [])]} />
      <div className="mono muted" style={{ fontSize: 11.5 }}>
        {file}
      </div>
      <textarea
        className="textarea mono"
        style={{ minHeight: 320, fontSize: 12.5 }}
        value={content}
        onChange={(e) => {
          setContent(e.target.value)
          setDirty(true)
        }}
        placeholder="# Preferences&#10;- Prefer small, focused commits&#10;- Use pnpm"
      />
      <div className="row">
        <span className="grow" />
        <button className="btn primary" disabled={!dirty} onClick={() => attempt(() => api.instructions.write(file, content), 'Saved').then(() => setDirty(false))}>
          Save
        </button>
      </div>
    </>
  )
}

/** The commit prefix field; focused and highlighted when Settings opens to it (the first Draft's offer). */
function CommitPrefixInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const focus = useStore((s) => s.settingsFocus)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (focus !== 'commitPrefix' || !ref.current) return
    set({ settingsFocus: undefined })
    ref.current.scrollIntoView({ block: 'center' })
    ref.current.focus()
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 2400)
    return () => clearTimeout(t)
  }, [focus])
  return <input ref={ref} className={`input mono ${flash ? 'flash' : ''}`} style={{ width: 160 }} value={value} placeholder="e.g. CJ |" onChange={(e) => onChange(e.target.value)} />
}

function Archived() {
  const lib = useStore((s) => s.library)
  const archived = lib.chats.filter((c) => c.archived).sort((a, b) => b.updatedAt - a.updatedAt)
  const byProject = useMemo(() => {
    const m = new Map<string, typeof archived>()
    for (const c of archived) {
      const k = lib.projects.find((p) => p.id === c.projectId)?.name ?? 'No project'
      m.set(k, [...(m.get(k) ?? []), c])
    }
    return [...m.entries()]
  }, [archived, lib.projects])
  if (!archived.length) return <div className="empty-note">No archived chats.</div>
  return (
    <>
      {byProject.map(([name, chats]) => (
        <div key={name}>
          <h3>{name}</h3>
          {chats.map((c) => (
            <div key={c.agentSessionId} className="setting" style={{ padding: '6px 0' }}>
              <div className="label">
                <span>{c.name}</span>
                <span className="desc">
                  {new Date(c.updatedAt).toLocaleString()} · {c.cwd}
                </span>
              </div>
              <div className="row">
                <button className="btn sm" onClick={() => api.library.updateChat(c.agentSessionId, { archived: false })}>
                  Unarchive
                </button>
                <button
                  className="btn sm"
                  onClick={() => {
                    void api.library.updateChat(c.agentSessionId, { archived: false })
                    set({ settingsOpen: false })
                    void resumeChat(c.agentSessionId)
                  }}
                >
                  Open
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    const r = await api.dialog.confirm(`Delete "${c.name}"?`, 'This removes it from Claude Deck and can’t be undone. The conversation file itself stays on disk.', ['Delete', 'Cancel'])
                    if (r === 0) await attempt(() => api.library.removeChat(c.agentSessionId), 'Chat deleted')
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}

const fmt = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))

function Profile() {
  const auth = useAuth()
  const [ins, setIns] = useState<Insights | null>(null)
  useEffect(() => {
    void api.library.insights().then(setIns)
  }, [])
  const max = Math.max(1, ...(ins?.byDay.map((d) => d.tokens) ?? [1]))
  return (
    <>
      <div className="row">
        <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}>
          <Icon name="user" size={20} />
        </span>
        <div>
          <div style={{ fontWeight: 650, fontSize: 15 }}>{auth.email ?? 'Not signed in'}</div>
          <div className="muted">{[auth.subscriptionType, auth.orgName].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      {!ins && <div className="empty-note">Crunching your agent history…</div>}
      {ins && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <div className="stat">
              <div className="v">{fmt(ins.lifetimeTokens)}</div>
              <div className="k">Lifetime tokens (in + out)</div>
            </div>
            <div className="stat">
              <div className="v">{fmt(ins.peakDayTokens)}</div>
              <div className="k">Peak day{ins.peakDay ? ` (${ins.peakDay})` : ''}</div>
            </div>
            <div className="stat">
              <div className="v">{ins.sessions}</div>
              <div className="k">Sessions</div>
            </div>
            <div className="stat">
              <div className="v">{ins.currentStreak}d</div>
              <div className="k">Current streak</div>
            </div>
            <div className="stat">
              <div className="v">{ins.longestStreak}d</div>
              <div className="k">Longest streak</div>
            </div>
            <div className="stat">
              <div className="v">{Math.round(ins.longestSessionMs / 60000)}m</div>
              <div className="k">Longest single task</div>
            </div>
          </div>
          <h3>Token activity</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 120, padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            {ins.byDay.map((d) => (
              <div key={d.day} title={`${d.day}: ${fmt(d.tokens)} tokens`} style={{ flex: 1, minWidth: 2, height: `${Math.max(2, (d.tokens / max) * 100)}%`, background: 'var(--accent)', borderRadius: '2px 2px 0 0', opacity: 0.85 }} />
            ))}
          </div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Last {ins.byDay.length} active days. Computed locally from your Claude Code transcripts.
          </div>
        </>
      )}
    </>
  )
}

function Diagnostics() {
  const [entries, setEntries] = useState<DiagEntry[]>([])
  const [file, setFile] = useState('')
  const refresh = (): void => {
    void attempt(async () => setEntries((await api.diag.recent()).reverse()))
  }
  useEffect(() => {
    refresh()
    void api.diag.logFile().then(setFile, () => undefined)
  }, [])
  const errors = entries.filter((e) => e.level === 'error').length
  return (
    <>
      <Row label="Log file" desc={`Failed actions and uncaught errors, kept across restarts. ${entries.length} recent entries, ${errors} errors.`}>
        <span className="mono" style={{ fontSize: 12 }}>
          {file}
        </span>
      </Row>
      <div className="row">
        <button className="btn" onClick={refresh}>
          Refresh
        </button>
        <button className="btn" onClick={() => attempt(() => api.clipboard.writeText(entries.map(formatDiagEntry).join('\n')), 'Copied')}>
          Copy all
        </button>
        <button className="btn" onClick={() => attempt(() => api.diag.openFolder())}>
          Open log folder
        </button>
      </div>
      {!entries.length && <div className="empty-note">Nothing logged yet.</div>}
      <div data-testid="diag-entries" style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map((e, i) => (
          <div
            key={i}
            data-level={e.level}
            className="mono"
            title={e.stack}
            style={{ fontSize: 12, padding: '4px 8px', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--border)', ...(e.level === 'error' ? { borderColor: 'var(--danger)', color: 'var(--danger)' } : { color: e.level === 'warn' ? 'var(--warning)' : 'var(--muted)' }) }}
          >
            {new Date(e.at).toLocaleString()} [{e.source}] {e.message}
          </div>
        ))}
      </div>
    </>
  )
}

function About() {
  const v = useStore((s) => s.version)
  const paths = useStore((s) => s.agentPaths)
  return (
    <>
      <div className="row">
        <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}>
          <Icon name="sparkles" size={22} />
        </span>
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Claude Deck</div>
          <div className="muted">Version {v}</div>
        </div>
      </div>
      {PROVIDER_IDS.map((p) => (
        <Row key={p} label={`${PROVIDERS[p].label} executable`}>
          <span className="mono" style={{ fontSize: 12 }}>
            {paths[p]}
          </span>
        </Row>
      ))}
      <div className="row">
        <button className="btn" onClick={() => api.shell.openExternal('https://docs.claude.com/en/docs/claude-code/overview')}>
          Claude Code docs
        </button>
        <button className="btn" onClick={() => api.window.devtools()}>
          Developer tools
        </button>
      </div>
    </>
  )
}
