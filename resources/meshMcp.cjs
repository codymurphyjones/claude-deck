// Claude Deck mesh MCP server (stdio). Gives a Claude session tools to
// coordinate with the other Claude sessions working in the same folder/repo.
// Every tool call is forwarded to the Claude Deck app over its control pipe.
'use strict'
const net = require('net')

const pipe = process.env.CLAUDE_DECK_PIPE
const sid = process.env.CLAUDE_DECK_SID
const token = process.env.CLAUDE_DECK_TOKEN

const str = (description) => ({ type: 'string', description })
const TOOLS = [
  {
    name: 'mesh_peers',
    description:
      'List the other Claude sessions working in the same folder/repo right now: their names, status (working/idle/needs-input), role, what they are currently doing, their file claims and the files they recently edited. Call this before starting substantial work when peers exist.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'mesh_send',
    description:
      'Send a message to one peer session (by name) or to "all". Idle recipients receive direct messages immediately. kind: request (asking them to do something — the default for direct messages), question (you want an answer), handoff (passing work to them), info (FYI). Keep messages short and concrete.',
    inputSchema: {
      type: 'object',
      properties: {
        to: str('Peer session name, or "all"'),
        text: str('Message text'),
        kind: { type: 'string', enum: ['info', 'question', 'request', 'handoff'] }
      },
      required: ['to', 'text']
    }
  },
  {
    name: 'mesh_reply',
    description: 'Reply to a specific message you received (use the message id shown in your inbox).',
    inputSchema: {
      type: 'object',
      properties: { messageId: str('Id of the message being answered'), text: str('Reply text') },
      required: ['messageId', 'text']
    }
  },
  {
    name: 'mesh_ask',
    description:
      'Ask a peer a question and wait for their reply (up to timeoutSeconds, default 120). Use when you cannot proceed without their answer.',
    inputSchema: {
      type: 'object',
      properties: { to: str('Peer session name'), question: str('The question'), timeoutSeconds: { type: 'number' } },
      required: ['to', 'question']
    }
  },
  {
    name: 'mesh_inbox',
    description: 'Read your unread messages from peers (and the user via the Team panel). Marks them read.',
    inputSchema: { type: 'object', properties: { includeRead: { type: 'boolean' } } }
  },
  {
    name: 'mesh_claim',
    description:
      'Claim files you are about to change so peers avoid conflicting edits. Paths may be relative to your working directory. Claims expire after ttlMinutes (default 30).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        intent: str('What you are doing to these files'),
        ttlMinutes: { type: 'number' }
      },
      required: ['paths', 'intent']
    }
  },
  {
    name: 'mesh_release',
    description: 'Release file claims (omit paths to release all of yours).',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'mesh_claims',
    description: 'List all active file claims in this group.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'board_list',
    description: 'List the shared task board for this folder/repo (todo / doing / done / blocked items).',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] } } }
  },
  {
    name: 'board_add',
    description:
      'Add one or more tasks to the shared board. Use this to split work between sessions. Optionally assign to a peer by name.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: str('Short task title'), detail: str('Details / acceptance criteria'), assignee: str('Peer name (optional)') },
            required: ['title']
          }
        }
      },
      required: ['items']
    }
  },
  {
    name: 'board_take',
    description: 'Take a board task (marks it doing and assigns it to you). Omit id to take the next unassigned todo item.',
    inputSchema: { type: 'object', properties: { id: str('Task id') } }
  },
  {
    name: 'board_update',
    description: 'Update a board task status and/or add a progress note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: str('Task id'),
        status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] },
        note: str('Progress note')
      },
      required: ['id']
    }
  },
  {
    name: 'notes_set',
    description: 'Write a shared note (key/value blackboard visible to every peer), e.g. decisions, API contracts, conventions.',
    inputSchema: { type: 'object', properties: { key: str('Note key'), value: str('Note text') }, required: ['key', 'value'] }
  },
  {
    name: 'notes_get',
    description: 'Read shared notes (omit key to list all).',
    inputSchema: { type: 'object', properties: { key: str('Note key') } }
  },
  {
    name: 'mesh_wait',
    description: 'Wait until a peer becomes idle (finishes its current turn), up to timeoutSeconds (default 300).',
    inputSchema: {
      type: 'object',
      properties: { peer: str('Peer session name'), timeoutSeconds: { type: 'number' } },
      required: ['peer']
    }
  },
  {
    name: 'read_terminal',
    description:
      'Read the visible output of a terminal: target "shell" (your integrated shell drawer, e.g. a dev server or test run), a peer session name, or "<peer>:shell".',
    inputSchema: {
      type: 'object',
      properties: { target: str('"shell", a peer name, or "<peer>:shell"'), lines: { type: 'number' } },
      required: ['target']
    }
  },
  {
    name: 'open_file',
    description:
      "Open a file for the user in Claude Deck's built-in editor (it appears over their workspace), optionally at a line. Use it whenever the user asks you to open, show or pull up a file. " +
      'First find the exact file: search with Glob/Grep for what they described. If exactly one file matches, open it. If several plausible files match, ask the user which one they mean (AskUserQuestion, listing the candidates) and open only their choice; never guess between candidates. If nothing matches, tell them instead of opening something else. ' +
      'Pass where: "external" only if they ask for their own editor (VS Code etc.).',
    inputSchema: {
      type: 'object',
      properties: {
        path: str('The file: absolute, or relative to your working directory'),
        line: { type: 'number', description: 'Line to show, if a specific place was asked for or found' },
        where: { type: 'string', enum: ['app', 'external'], description: 'app (default): Claude Deck editor; external: the user’s own editor' }
      },
      required: ['path']
    }
  },
  {
    name: 'show_diff',
    description:
      "Show the user changes in Claude Deck's Review pane (the git diff viewer beside the chat), optionally switching its view and scrolling to one file. Use when they ask to see what changed, e.g. \"show me what you changed in the store\".",
    inputSchema: {
      type: 'object',
      properties: {
        path: str('A changed file to scroll to (absolute or relative to your working directory)'),
        view: { type: 'string', enum: ['unstaged', 'staged', 'lastTurn', 'branch'], description: 'unstaged: uncommitted changes; staged; lastTurn: changes since the start of your latest turn; branch: the branch vs the default branch' }
      }
    }
  },
  {
    name: 'request_review',
    description:
      'Walk the user through changes: pin short notes to specific lines of the diff in the Review pane (shown under those lines, plus a list at the top). Use to point out the risky or important parts of your changes, decisions worth checking, or what to test. Line numbers are in the new version of the file. Calling it again replaces your previous notes.',
    inputSchema: {
      type: 'object',
      properties: {
        notes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: str('File (absolute or relative to your working directory)'), line: { type: 'number', description: 'Line in the new version of the file' }, text: str('The note: what to look at and why') },
            required: ['path', 'line', 'text']
          }
        },
        summary: str('Optional overview shown above the notes'),
        view: { type: 'string', enum: ['unstaged', 'staged', 'lastTurn', 'branch'], description: 'Which diff the notes refer to (default unstaged)' }
      },
      required: ['notes']
    }
  },
  {
    name: 'run_process',
    description:
      "Start (or restart, if it's already running) one of the project's package.json scripts as a Claude Deck background process, e.g. the dev server or tests, the same as the user's Actions panel. Waits a few seconds and returns the status and output so far. Long-running scripts keep running; check them later with read_process.",
    inputSchema: {
      type: 'object',
      properties: {
        script: str('Script name from package.json, e.g. "dev" or "test"'),
        folder: str('Which package, when the project has several (as listed in the error if ambiguous)'),
        waitSeconds: { type: 'number', description: 'How long to wait before reporting (default 8, max 120). Use more for test runs you want to see finish.' }
      },
      required: ['script']
    }
  },
  {
    name: 'read_process',
    description: "Read the output of a script run in Claude Deck (a dev server, test run…). With no script, lists the project's runs and their status.",
    inputSchema: {
      type: 'object',
      properties: { script: str('Script name'), folder: str('Package folder, if several have the script'), lines: { type: 'number', description: 'How many of the last lines (default 80, max 400)' } }
    }
  },
  {
    name: 'open_browser',
    description:
      "Open a URL in Claude Deck's built-in browser pane (beside the chat, so the user sees it too) and read the result: the page's visible text, its console messages, and/or a screenshot file you can then read. Use to check a dev server page loads, look for console errors, or verify a UI change. Omit url to read the page that's already open.",
    inputSchema: {
      type: 'object',
      properties: {
        url: str('e.g. "localhost:5173" or a full URL'),
        read: { type: 'string', enum: ['text', 'console', 'screenshot', 'all', 'none'], description: 'What to return (default text)' },
        waitSeconds: { type: 'number', description: 'Extra wait after loading, for pages that render late (default 2)' }
      }
    }
  },
  {
    name: 'notify',
    description:
      'Send the user a desktop notification (a toast if the app is in front). Use when they ask to be told about something, e.g. "tell me when the tests pass", once it happens. Clicking it opens this chat.',
    inputSchema: { type: 'object', properties: { message: str('What happened'), title: str('Optional title (default: this chat\'s name)') }, required: ['message'] }
  },
  {
    name: 'run_routine',
    description:
      "Open the run dialog for one of the user's Claude Deck routines (saved multi-step jobs), targeting this repository, with optional context filled in. The user reviews and starts it; it does not run until they do. If the name is ambiguous you get the list to ask them from.",
    inputSchema: {
      type: 'object',
      properties: { routine: str('Routine name or slug'), context: str('Optional run-specific instructions to pre-fill') },
      required: ['routine']
    }
  }
]

// ---- control pipe client ----
let sock = null
let nextId = 1
const pending = new Map()
let buf = ''

function connect() {
  return new Promise((resolve, reject) => {
    if (sock && !sock.destroyed) return resolve(sock)
    const s = net.connect(pipe)
    s.setEncoding('utf8')
    s.on('connect', () => {
      sock = s
      resolve(s)
    })
    s.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        try {
          const msg = JSON.parse(line)
          const p = pending.get(msg.id)
          if (p) {
            pending.delete(msg.id)
            msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result)
          }
        } catch {
          /* ignore */
        }
      }
    })
    s.on('error', (e) => {
      sock = null
      for (const p of pending.values()) p.reject(e)
      pending.clear()
      reject(e)
    })
    s.on('close', () => {
      sock = null
    })
  })
}

async function call(method, params) {
  const s = await connect()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    s.write(JSON.stringify({ id, token, sid, method, params }) + '\n')
  })
}

// ---- MCP stdio protocol ----
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

async function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined || id === null) return // notification
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'deck-mesh', version: '1.0.0' },
          instructions:
            'Claude Deck mesh: coordinate with other Claude sessions working in the same folder. Use mesh_peers to see who is around, claim files before editing, use the shared board to split work, and message peers when you hand off or need something. ' +
            'You are running inside the Claude Deck app, and some tools act on it: open_file (show a file; find it first and ask which one if several match), show_diff and request_review (show or walk the user through changes in the Review pane), run_process / read_process (the project\'s scripts, e.g. a dev server or tests), open_browser (the built-in browser pane), notify (a desktop notification), run_routine (opens a routine\'s run dialog for the user to start).'
        }
      })
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} })
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
    if (method === 'tools/call') {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      let text
      let isError = false
      try {
        const r = await call('mesh', { tool: name, args })
        text = typeof r === 'string' ? r : JSON.stringify(r, null, 2)
      } catch (e) {
        isError = true
        text = 'Claude Deck is not reachable: ' + (e && e.message)
      }
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } })
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } })
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message) } })
  }
}

let inBuf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  inBuf += d
  let i
  while ((i = inBuf.indexOf('\n')) >= 0) {
    const line = inBuf.slice(0, i).trim()
    inBuf = inBuf.slice(i + 1)
    if (!line) continue
    try {
      void handle(JSON.parse(line))
    } catch {
      /* ignore malformed */
    }
  }
})
process.stdin.on('end', () => process.exit(0))
