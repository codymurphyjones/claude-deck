import { api, bridge, errMsg } from './api'
import { browserControl } from './browserControl'
import { focusSessionTab, get, set, type AgentNote, type RightPanel } from './store'

// The UI half of the agent's app tools (src/main/appTools.ts): the main process forwards a tool call
// here, and the text returned is what the agent sees.

interface AgentRequest {
  reqId: string
  sessionId: string
  tool: string
  args: Record<string, unknown>
}

const VIEW_LABEL: Record<string, string> = { unstaged: 'Unstaged', staged: 'Staged', lastTurn: 'Last turn', branch: 'Branch' }
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

/**
 * Show the session's tab with a right panel open. Refused while the user is in the Review file
 * editor, which locks tab and panel switches until they close it.
 */
function reveal(sessionId: string, panel: Exclude<RightPanel, null>): string | undefined {
  const s = get()
  if (s.editorFile && s.editorFile.locked) return 'The user is editing a file from the Review pane; the app can\'t switch views until they close the editor. Ask them to, then try again.'
  if (s.tabs.some((t) => t.sessionIds.includes(sessionId))) focusSessionTab(sessionId)
  set({ rightPanel: panel })
  return undefined
}

async function handle({ sessionId, tool, args }: AgentRequest): Promise<string> {
  switch (tool) {
    case 'show_diff': {
      const blocked = reveal(sessionId, 'review')
      if (blocked) return blocked
      const view = args.view as string | undefined
      const path = args.path as string | undefined
      set({ reviewFocus: { sessionId, view, path, at: Date.now() } })
      return `Showing ${path ?? 'the changes'} in the Review pane${view ? ` (${VIEW_LABEL[view]} view)` : ''}.`
    }

    case 'request_review': {
      const blocked = reveal(sessionId, 'review')
      if (blocked) return blocked
      const notes = args.notes as AgentNote[]
      const view = args.view as string
      set((s) => ({
        agentNotes: { ...s.agentNotes, [sessionId]: { notes, summary: args.summary as string | undefined, at: Date.now() } },
        reviewFocus: { sessionId, view, path: notes[0]?.path, at: Date.now() }
      }))
      const files = new Set(notes.map((n) => n.path)).size
      return `Showing your ${notes.length} note(s) on ${files} file(s) next to the diff in the Review pane (${VIEW_LABEL[view] ?? view} view). Notes on lines that aren't part of the diff are listed at the top of the pane.`
    }

    case 'open_browser': {
      const blocked = reveal(sessionId, 'browser')
      if (blocked) return blocked
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
  }
  return `Unknown tool ${tool}`
}
