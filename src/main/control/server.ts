import * as fs from 'fs'
import * as net from 'net'
import { runtime } from '../runtime'

export interface ControlRequest {
  id: number
  token: string
  sid: string
  method: string
  params: unknown
}

export type ControlHandler = (sid: string, params: unknown) => Promise<unknown> | unknown

/**
 * Local IPC endpoint (named pipe on Windows) that hook relays and the mesh MCP
 * server connect to. Newline-delimited JSON request/response.
 */
export class ControlServer {
  private server: net.Server | undefined
  private handlers = new Map<string, ControlHandler>()

  on(method: string, handler: ControlHandler): void {
    this.handlers.set(method, handler)
  }

  start(): Promise<void> {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(runtime.pipe)
      } catch {
        /* no stale socket */
      }
    }
    this.server = net.createServer((sock) => this.onConnection(sock))
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(runtime.pipe, () => resolve())
    })
  }

  stop(): void {
    this.server?.close()
  }

  private onConnection(sock: net.Socket): void {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) void this.dispatch(sock, line)
      }
    })
    sock.on('error', () => {})
  }

  private async dispatch(sock: net.Socket, line: string): Promise<void> {
    let req: ControlRequest
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    const reply = (body: object): void => {
      if (!sock.destroyed) sock.write(JSON.stringify({ id: req.id, ...body }) + '\n')
    }
    if (req.token !== runtime.token) return reply({ error: 'unauthorized' })
    const handler = this.handlers.get(req.method)
    if (!handler) return reply({ error: `unknown method ${req.method}` })
    try {
      reply({ result: (await handler(req.sid, req.params)) ?? null })
    } catch (err) {
      reply({ error: err instanceof Error ? err.message : String(err) })
    }
  }
}
