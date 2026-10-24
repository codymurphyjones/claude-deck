import { isAgentDiffView, type AgentDiffView, type AppToolName } from '@shared/agentTools'
import { api, bridge, errMsg } from './api'
import { browserControl } from './browserControl'
import { focusSessionTab, get, set, toast, type AgentNote, type RightPanel } from './store'

// The UI half of the agent's app tools (src/main/appTools.ts): the main process forwards a tool call
// here, and the text returned is what the agent sees.

interface AgentRequest {
  reqId: string
  sessionId: string
  tool: AppToolName
  args: Record<string, unknown>
}

const VIEW_LABEL: Record<AgentDiffView, string> = { unstaged: 'Unstaged', staged: 'Staged', lastTurn: 'Last turn', branch: 'Branch' }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function initAgentRequests(): void {
  bridge.on('agent:request', async (r: AgentRequest) => {
    let out: string
    try {
      out = await handle(r)
    } catch (e) {
      out = `Failed: ${errMsg(e)}`
    }
    void api.agent.reply(r.reqId, out)
  })
}

type Reveal = { blocked: string } | { shown: boolean }

/**
 * Show the session's tab with a right panel open. Refused while the user is in the Review file
 * editor, which locks tab and panel switches until they close it. An agent in a background tab
 * doesn't pull the user away from the tab they're working in (unless `force`, for tools that can't
 * work otherwise): `shown: false`, and the result waits for them in that chat.
 */
function reveal(sessionId: string, panel: Exclude<RightPanel, null>, force = false): Reveal {
  const s = get()
  const tab = s.tabs.find((t) => t.sessionIds.includes(sessionId))
  const inActiveTab = !!tab && tab.id === s.activeTabId
  if (!inActiveTab && !force && document.hasFocus()) return { shown: false }
  if (tab && !inActiveTab) focusSessionTab(sessionId)
  set({ rightPanel: panel })
  return { shown: true }
}

const sessionName = (id: string): string => get().sessions[id]?.name ?? 'A chat'
const LATER = " The user is working in another tab, so it's waiting for them in this chat's Review pane."
const diffView = (v: unknown, def?: AgentDiffView): AgentDiffView | undefined => (typeof v === 'string' && isAgentDiffView(v) ? v : def)

async function handle({ sessionId, tool, args }: AgentRequest): Promise<string> {
  switch (tool) {
    case 'show_diff': {
      const r = reveal(sessionId, 'review')
      if ('blocked' in r) return r.blocked
      const view = diffView(args.view)
      const path = args.path as string | undefined
      set({ reviewFocus: { sessionId, view, path, at: Date.now() } })
      if (!r.shown) toast(`${sessionName(sessionId)} wants to show you ${path ?? 'its changes'}; open its tab to see them`)
      return `${r.shown ? 'Showing' : 'Queued'} ${path ?? 'the changes'} in the Review pane${view ? ` (${VIEW_LABEL[view]} view)` : ''}.${r.shown ? '' : LATER}`
    }

    case 'request_review': {
      const r = reveal(sessionId, 'review')
      if ('blocked' in r) return r.blocked
      const notes = args.notes as AgentNote[]
      const view = diffView(args.view, 'unstaged')!
      set((s) => ({
        agentNotes: { ...s.agentNotes, [sessionId]: { notes, summary: args.summary as string | undefined, at: Date.now() } },
        reviewFocus: { sessionId, view, path: notes[0]?.path, at: Date.now() }
      }))
      const files = new Set(notes.map((n) => n.path)).size
      if (!r.shown) toast(`${sessionName(sessionId)} left ${notes.length} review note(s); open its tab to see them`)
      return `${r.shown ? 'Showing' : 'Saved'} your ${notes.length} note(s) on ${files} file(s) next to the diff in the Review pane (${VIEW_LABEL[view]} view). Notes on lines that aren't part of the diff are listed at the top of the pane.${r.shown ? '' : LATER}`
    }

    case 'open_browser': {
      // The pane has to be visible to load and read a page.
      const r = reveal(sessionId, 'browser', true)
      if ('blocked' in r) return r.blocked
      // The pane mounts on the next render; wait for its handle.
      let ctl = browserControl()
      for (let i = 0; !ctl && i < 50; i++) {
        await sleep(100)
        ctl = browserControl()
      }
      if (!ctl) return 'The browser pane did not open.'
      if (args.url) await ctl.navigate(String(args.url))
      await sleep(Number(args.waitSeconds ?? 0) * 1000)
      const read = String(args.read ?? 'text')
      const parts = [`Browser pane showing ${ctl.url()}.`]
      if (read === 'text' || read === 'all') parts.push(`--- page text ---\n${(await ctl.text()).slice(0, 20_000)}`)
      if (read === 'console' || read === 'all') {
        const log = ctl.console()
        parts.push(`--- console (${log.length} message(s)) ---\n${log.join('\n') || '(empty)'}`)
      }
      if (read === 'screenshot' || read === 'all') parts.push(`Screenshot saved to ${await ctl.screenshot()} (read the image file to see it).`)
      return parts.join('\n\n')
    }

    case 'run_routine': {
      if (get().routineRunFor) return 'The routine run dialog is already open; let the user finish with it first.'
      set({ routineRunFor: { slug: String(args.slug), cwd: String(args.cwd), context: args.context as string | undefined } })
      return `Opened the run dialog for routine "${String(args.name)}" on ${String(args.cwd)}${args.context ? ', with your context filled in' : ''}. The user reviews the options and starts it; it doesn't run until they do.`
    }

    // Handled in the main process; never forwarded here.
    case 'open_file':
    case 'read_process':
    case 'run_process':
    case 'notify':
      break
  }
  return `Unknown tool ${tool}`
}
