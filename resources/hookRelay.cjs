// Claude Deck hook relay. Claude Code runs this for each configured hook event.
// It forwards the hook payload to the running Claude Deck app and prints the
// app's response. If the app is unreachable it exits quietly so Claude is never blocked.
'use strict'
const net = require('net')

const pipe = process.env.CLAUDE_DECK_PIPE
const sid = process.env.CLAUDE_DECK_SID
const token = process.env.CLAUDE_DECK_TOKEN

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', relay)
setTimeout(relay, 4000)

let started = false
function relay() {
  if (started) return
  started = true
  if (!pipe || !sid || !token) process.exit(0)
  let payload = {}
  try {
    payload = JSON.parse(input || '{}')
  } catch {
    process.exit(0)
  }
  const sock = net.connect(pipe)
  const bail = setTimeout(() => process.exit(0), 25000)
  let buf = ''
  sock.setEncoding('utf8')
  sock.on('connect', () => {
    sock.write(JSON.stringify({ id: 1, token, sid, method: 'hook', params: payload }) + '\n')
  })
  sock.on('data', (d) => {
    buf += d
    const i = buf.indexOf('\n')
    if (i < 0) return
    clearTimeout(bail)
    let res = {}
    try {
      res = JSON.parse(buf.slice(0, i))
    } catch {
      /* ignore */
    }
    const r = (res && res.result) || {}
    if (r.stdout) process.stdout.write(typeof r.stdout === 'string' ? r.stdout : JSON.stringify(r.stdout))
    if (r.stderr) process.stderr.write(r.stderr)
    sock.end()
    process.exitCode = r.exitCode || 0
    setImmediate(() => process.exit(process.exitCode))
  })
  sock.on('error', () => process.exit(0))
}
