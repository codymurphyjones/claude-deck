import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { MESH_COLORS } from '@shared/defaults'
import { baseName, claimKey, normalizeKey } from '@shared/paths'
import type {
  BoardItem,
  EditRecord,
  MeshClaim,
  MeshGroupState,
  MeshMessage,
  MeshMessageKind,
  MeshPeer,
  SessionInfo
} from '@shared/types'
import { broadcast, pushTimeline, settings } from '../context'
import { commonDir } from '../git/gitService'
import { runtime } from '../runtime'
import { JsonStore } from '../store'
import { ensureDir, shortId, truncate } from '../util'

const WIN = process.platform === 'win32'
const WAKE_KINDS: MeshMessageKind[] = ['question', 'request', 'handoff', 'reply']
/** Direct messages always deserve prompt delivery; broadcast FYIs can wait for the next turn. */
const wakes = (m: MeshMessage): boolean => m.from === 'user' || m.to !== 'all' || WAKE_KINDS.includes(m.kind)
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

interface GroupData {
  key: string
  label: string
  messages: MeshMessage[]
  claims: MeshClaim[]
  board: BoardItem[]
  notes: Record<string, { value: string; by: string; ts: number }>
  edits: EditRecord[]
}

export interface MeshDeps {
  sessions: () => SessionInfo[]
  get: (id: string) => SessionInfo | undefined
  /** Type a prompt into a session; returns false if it could not be delivered. */
  inject: (id: string, text: string) => boolean
  readTerminal: (id: string, lines: number) => Promise<string>
  shellOf: (id: string) => SessionInfo | undefined
  sessionChanged: (id: string) => void
}

const ago = (ts: number): string => {
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

/**
 * Coordinates Claude sessions that share a folder (or git repo). Sessions get
 * awareness through hook-injected context and act through the deck-mesh MCP tools.
 */
export class MeshService {
  private stores = new Map<string, JsonStore<GroupData>>()
  private lastSeen = new Map<string, number>()
  private lastRead = new Map<string, Map<string, number>>()
  private staleWarned = new Map<string, Set<string>>()
  private replyWaiters = new Map<string, (m: MeshMessage) => void>()
  private idleWaiters = new Map<string, (() => void)[]>()
  private wakeLog = new Map<string, number[]>()

  constructor(private deps: MeshDeps) {}

  // ---------- grouping ----------
  async groupFor(cwd: string, root: string): Promise<{ key: string; label: string }> {
    if (settings().mesh.repoPeers) {
      const cd = await commonDir(root)
      if (cd) {
        const repo = path.basename(cd) === '.git' ? path.dirname(cd) : cd
        return { key: 'repo:' + normalizeKey(repo, WIN), label: baseName(repo) }
      }
    }
    return { key: 'dir:' + normalizeKey(root || cwd, WIN), label: baseName(root || cwd) }
  }

  private store(key: string, label = key): JsonStore<GroupData> {
    let st = this.stores.get(key)
    if (!st) {
      const file = path.join(ensureDir(path.join(runtime.userData, 'mesh')), createHash('sha1').update(key).digest('hex').slice(0, 16) + '.json')
      st = new JsonStore<GroupData>(file, { key, label, messages: [], claims: [], board: [], notes: {}, edits: [] })
      if (!st.data.label || st.data.label === key) st.data.label = label
      this.stores.set(key, st)
    }
    return st
  }

  ensureGroup(key: string, label: string): void {
    this.store(key, label)
  }

  private group(s: SessionInfo): GroupData | undefined {
    if (!s.meshGroup) return undefined
    return this.store(s.meshGroup).data
  }

  private changed(key: string): void {
    this.store(key).scheduleSave()
    broadcast('mesh:changed', this.groupState(key))
  }

  members(key: string): SessionInfo[] {
    return this.deps.sessions().filter((s) => s.kind === 'claude' && s.meshGroup === key && s.status !== 'exited')
  }

  peersOf(s: SessionInfo): SessionInfo[] {
    return s.meshGroup ? this.members(s.meshGroup).filter((p) => p.id !== s.id) : []
  }

  colorFor(key: string): string {
    const keys = [...new Set(this.deps.sessions().map((s) => s.meshGroup).filter(Boolean))] as string[]
    const i = Math.max(0, keys.indexOf(key))
    return MESH_COLORS[i % MESH_COLORS.length]
  }

  private activeClaims(g: GroupData): MeshClaim[] {
    const now = Date.now()
    const live = g.claims.filter((c) => c.expires > now && this.deps.get(c.sessionId)?.status !== 'exited')
    if (live.length !== g.claims.length) g.claims = live
    return live
  }

  groupState(key: string): MeshGroupState {
    const g = this.store(key).data
    const peers: MeshPeer[] = this.members(key).map((s) => ({
      sessionId: s.id,
      name: s.name,
      status: s.status,
      role: s.role,
      lastPrompt: s.lastPrompt,
      branch: s.branch,
      cwd: s.cwd
    }))
    return {
      key,
      label: g.label,
      messages: g.messages.slice(-300),
      claims: this.activeClaims(g),
      board: g.board,
      notes: g.notes,
      edits: g.edits.slice(-100),
      peers
    }
  }

  allGroups(): MeshGroupState[] {
    const keys = new Set(this.deps.sessions().map((s) => s.meshGroup).filter(Boolean) as string[])
    return [...keys].map((k) => this.groupState(k))
  }

  unreadFor(s: SessionInfo): MeshMessage[] {
    const g = this.group(s)
    if (!g) return []
    return g.messages.filter((m) => m.from !== s.id && (m.to === s.id || m.to === 'all') && !m.readBy.includes(s.id))
  }

  private markRead(s: SessionInfo, msgs: MeshMessage[]): void {
    if (!msgs.length || !s.meshGroup) return
    for (const m of msgs) if (!m.readBy.includes(s.id)) m.readBy.push(s.id)
    s.pendingMessages = this.unreadFor(s).length
    this.deps.sessionChanged(s.id)
    this.changed(s.meshGroup)
  }

  private formatMessages(msgs: MeshMessage[]): string {
    return msgs
      .map((m) => `• (id ${m.id}) from "${m.fromName}" [${m.kind}${m.replyTo ? ` re ${m.replyTo}` : ''}]: ${m.text}`)
      .join('\n')
  }

  // ---------- hook integrations ----------
  /** Context injected at session start and on each user prompt. */
  contextForPrompt(s: SessionInfo, isStart: boolean): string | undefined {
    if (!settings().mesh.enabled) return undefined
    const g = this.group(s)
    if (!g) return undefined
    const peers = this.peersOf(s)
    const parts: string[] = []
    const claims = this.activeClaims(g).filter((c) => c.sessionId !== s.id)
    const openBoard = g.board.filter((b) => b.status !== 'done')
    if (peers.length) {
      parts.push(
        `[Claude Deck mesh] You are session "${s.name}"${s.role !== 'free' ? ` (role: ${s.role})` : ''}. ${peers.length} other Claude session${peers.length > 1 ? 's are' : ' is'} working in this same ${s.meshGroup?.startsWith('repo:') ? 'repository' : 'folder'} right now:`
      )
      for (const p of peers) {
        const recent = g.edits.filter((e) => e.sessionId === p.id).slice(-3).map((e) => e.key)
        parts.push(
          `• "${p.name}" — ${p.status}${p.role !== 'free' ? ` — role: ${p.role}` : ''}${p.lastPrompt ? ` — task: "${truncate(p.lastPrompt.replace(/\s+/g, ' '), 140)}"` : ''}${recent.length ? ` — recently edited: ${[...new Set(recent)].join(', ')}` : ''}${p.cwd !== s.cwd ? ` — cwd: ${p.cwd}` : ''}`
        )
      }
    } else if (!openBoard.length && !this.unreadFor(s).length) {
      return undefined
    } else if (isStart) {
      parts.push(`[Claude Deck mesh] You are session "${s.name}". No other sessions are active in this folder right now.`)
    }
    if (claims.length) parts.push(`Files claimed by peers (avoid editing; message the owner instead): ${claims.map((c) => `${c.key} (${c.sessionName}: ${c.intent})`).join('; ')}`)
    const since = this.lastSeen.get(s.id) ?? s.createdAt
    const peerEdits = g.edits.filter((e) => e.sessionId !== s.id && e.ts > since)
    if (peerEdits.length && !isStart) {
      const byFile = new Map<string, EditRecord>()
      for (const e of peerEdits) byFile.set(e.key, e)
      parts.push(
        `Files changed by peers since your last turn (re-read before editing them): ${[...byFile.values()].map((e) => `${e.key} (${e.sessionName}, ${ago(e.ts)})`).join(', ')}`
      )
    }
    if (openBoard.length) {
      const mine = openBoard.filter((b) => b.owner === s.id)
      parts.push(
        `Shared board: ${openBoard.filter((b) => b.status === 'todo').length} todo, ${openBoard.filter((b) => b.status === 'doing').length} doing, ${openBoard.filter((b) => b.status === 'blocked').length} blocked${mine.length ? `; assigned to you: ${mine.map((b) => `[${b.id}] ${b.title} (${b.status})`).join(', ')}` : ''} (board_list for details).`
      )
    }
    const noteKeys = Object.keys(g.notes)
    if (noteKeys.length && isStart) parts.push(`Shared notes available: ${noteKeys.join(', ')} (notes_get).`)
    const unread = this.unreadFor(s)
    if (unread.length) {
      parts.push(`New messages for you:\n${this.formatMessages(unread)}\nReply with mesh_reply (by message id) or mesh_send.`)
      this.markRead(s, unread)
    }
    if (peers.length) parts.push('Coordinate through the deck-mesh tools: claim files before editing them, steer clear of files claimed by others, and message peers about changes that affect them.')
    this.lastSeen.set(s.id, Date.now())
    return parts.join('\n')
  }

  /** Context injected after tool calls: only new messages, so turns stay lean. */
  contextForTool(s: SessionInfo): string | undefined {
    if (!settings().mesh.enabled) return undefined
    const unread = this.unreadFor(s)
    if (!unread.length) return undefined
    this.markRead(s, unread)
    return `[Claude Deck mesh] New messages from peers:\n${this.formatMessages(unread)}\nIf relevant to what you are doing, adapt; reply with mesh_reply or mesh_send when an answer is expected.`
  }

  /** Gate an edit: claimed by a peer, or changed by a peer since this session read it. */
  checkEdit(s: SessionInfo, tool: string, filePath: string | undefined): { decision: 'ask' | 'deny'; reason: string } | undefined {
    const cfg = settings().mesh
    if (!cfg.enabled || !filePath || !EDIT_TOOLS.has(tool)) return undefined
    const g = this.group(s)
    if (!g) return undefined
    const abs = path.resolve(s.cwd, filePath)
    const key = claimKey(abs, s.root, WIN)
    if (cfg.claimMode !== 'off') {
      const claim = this.activeClaims(g).find((c) => c.key === key && c.sessionId !== s.id && !c.soft)
      const soft = this.activeClaims(g).find((c) => c.key === key && c.sessionId !== s.id && c.soft)
      const c = claim ?? soft
      if (c) {
        const owner = this.deps.get(c.sessionId)
        const busy = owner && (owner.status === 'working' || owner.status === 'needs-input')
        if (claim || busy) {
          return {
            decision: cfg.claimMode === 'deny' ? 'deny' : 'ask',
            reason: `Claude Deck mesh: ${key} is claimed by peer session "${c.sessionName}" (${c.intent}). Coordinate with mesh_send/mesh_ask before editing, or wait for them to release it.`
          }
        }
      }
    }
    if (cfg.staleReadGuard) {
      const read = this.lastRead.get(s.id)?.get(key)
      const latest = [...g.edits].reverse().find((e) => e.key === key)
      const warned = this.staleWarned.get(s.id) ?? new Set<string>()
      if (read !== undefined && latest && latest.sessionId !== s.id && latest.ts > read && !warned.has(key)) {
        warned.add(key)
        this.staleWarned.set(s.id, warned)
        return {
          decision: 'deny',
          reason: `Claude Deck mesh: peer session "${latest.sessionName}" modified ${key} ${ago(latest.ts)}, after you last read it. Read the file again before editing so you don't overwrite their work.`
        }
      }
    }
    return undefined
  }

  recordRead(s: SessionInfo, filePath: string | undefined): void {
    if (!filePath) return
    const key = claimKey(path.resolve(s.cwd, filePath), s.root, WIN)
    let m = this.lastRead.get(s.id)
    if (!m) this.lastRead.set(s.id, (m = new Map()))
    m.set(key, Date.now())
    this.staleWarned.get(s.id)?.delete(key)
  }

  recordEdit(s: SessionInfo, tool: string, filePath: string | undefined): void {
    if (!filePath || !s.meshGroup) return
    const g = this.group(s)!
    const abs = path.resolve(s.cwd, filePath)
    const key = claimKey(abs, s.root, WIN)
    g.edits.push({ key, path: abs, sessionId: s.id, sessionName: s.name, tool, ts: Date.now() })
    if (g.edits.length > 400) g.edits.splice(0, g.edits.length - 400)
    this.recordRead(s, filePath)
    // Soft claim: renewed while this session keeps editing the file.
    const existing = g.claims.find((c) => c.key === key && c.sessionId === s.id)
    if (existing) existing.expires = Math.max(existing.expires, Date.now() + 10 * 60_000)
    else if (!g.claims.some((c) => c.key === key && c.expires > Date.now()))
      g.claims.push({ key, path: abs, sessionId: s.id, sessionName: s.name, intent: 'editing', expires: Date.now() + 10 * 60_000, soft: true })
    if (this.peersOf(s).length) pushTimeline({ sessionId: s.id, sessionName: s.name, type: 'edit', text: `${tool} ${key}`, group: s.meshGroup })
    this.changed(s.meshGroup)
  }

  /** On Stop: if peers asked this session for something, keep it going. */
  stopReason(s: SessionInfo): string | undefined {
    if (!settings().mesh.enabled) return undefined
    const urgent = this.unreadFor(s).filter(wakes)
    if (!urgent.length) return undefined
    this.markRead(s, urgent)
    return `[Claude Deck mesh] Before stopping, handle these messages from your peers:\n${this.formatMessages(urgent)}\nAnswer questions with mesh_reply, act on requests if appropriate (or explain why not), then finish.`
  }

  onStatus(s: SessionInfo): void {
    if (s.status === 'idle' || s.status === 'exited') {
      const ws = this.idleWaiters.get(s.id)
      if (ws) {
        this.idleWaiters.delete(s.id)
        ws.forEach((w) => w())
      }
    }
    if (s.status === 'idle') setTimeout(() => this.tryWake(s.id), 400)
    if (s.status === 'exited' && s.meshGroup) {
      const g = this.group(s)!
      g.claims = g.claims.filter((c) => c.sessionId !== s.id)
      this.changed(s.meshGroup)
    } else if (s.meshGroup) broadcast('mesh:changed', this.groupState(s.meshGroup))
  }

  /** Deliver pending messages to an idle session by typing them in, if the user isn't busy there. */
  tryWake(id: string, force = false): boolean {
    const s = this.deps.get(id)
    const cfg = settings().mesh
    if (!s || s.status !== 'idle' || !cfg.enabled) return false
    if (!force && (!cfg.autoWake || Date.now() - s.lastUserInput < cfg.autoWakeIdleMs)) return false
    const msgs = this.unreadFor(s).filter((m) => force || wakes(m))
    if (!msgs.length) return false
    // Guard against two sessions ping-ponging each other forever.
    const recent = (this.wakeLog.get(s.id) ?? []).filter((t) => Date.now() - t < 10 * 60_000)
    if (!force && recent.length >= 8) return false
    this.wakeLog.set(s.id, [...recent, Date.now()])
    const text = `[Claude Deck mesh] New message${msgs.length > 1 ? 's' : ''} from your peers:\n${this.formatMessages(msgs)}\nHandle ${msgs.length > 1 ? 'them' : 'it'} (reply with mesh_reply / mesh_send), then stop.`
    if (!this.deps.inject(s.id, text)) return false
    this.markRead(s, msgs)
    return true
  }

  private addMessage(key: string, m: Omit<MeshMessage, 'id' | 'ts' | 'readBy'>): MeshMessage {
    const g = this.store(key).data
    const msg: MeshMessage = { ...m, id: 'm' + shortId().slice(0, 5), ts: Date.now(), readBy: [] }
    g.messages.push(msg)
    if (g.messages.length > 600) g.messages.splice(0, g.messages.length - 600)
    pushTimeline({ sessionId: m.from, sessionName: m.fromName, type: 'mesh', text: `→ ${m.toName ?? m.to}: ${truncate(m.text, 200)}`, group: key })
    if (msg.replyTo) this.replyWaiters.get(msg.replyTo)?.(msg)
    const recipients = m.to === 'all' ? this.members(key).filter((p) => p.id !== m.from) : [this.deps.get(m.to)].filter(Boolean)
    for (const r of recipients as SessionInfo[]) {
      r.pendingMessages = this.unreadFor(r).length
      this.deps.sessionChanged(r.id)
      if (r.status === 'idle') setTimeout(() => this.tryWake(r.id), 300)
    }
    this.changed(key)
    return msg
  }

  private findPeer(s: SessionInfo, name: string): SessionInfo | undefined {
    const n = name.trim().toLowerCase().replace(/^"|"$/g, '')
    const peers = this.peersOf(s)
    return peers.find((p) => p.name.toLowerCase() === n) ?? peers.find((p) => p.id.startsWith(n)) ?? peers.find((p) => p.name.toLowerCase().includes(n))
  }

  // ---------- user actions from the Team panel ----------
  userSend(key: string, to: string, text: string, kind: MeshMessageKind = 'request'): void {
    const target = to === 'all' ? undefined : this.deps.get(to)
    this.addMessage(key, { from: 'user', fromName: 'the user (via Team panel)', to, toName: target?.name ?? 'all', kind, text })
  }

  userBoard(key: string, op: 'add' | 'update' | 'delete', item: Partial<BoardItem> & { id?: string }): void {
    const g = this.store(key).data
    if (op === 'add') {
      g.board.push({
        id: 't' + shortId().slice(0, 4),
        title: item.title ?? 'Untitled',
        detail: item.detail,
        status: item.status ?? 'todo',
        owner: item.owner,
        ownerName: item.owner ? this.deps.get(item.owner)?.name : undefined,
        createdBy: 'user',
        createdByName: 'user',
        notes: [],
        ts: Date.now(),
        updated: Date.now()
      })
    } else if (op === 'update') {
      const b = g.board.find((x) => x.id === item.id)
      if (b) {
        Object.assign(b, item, { updated: Date.now() })
        if (item.owner !== undefined) b.ownerName = item.owner ? this.deps.get(item.owner)?.name : undefined
      }
    } else g.board = g.board.filter((x) => x.id !== item.id)
    this.changed(key)
  }

  userReleaseClaim(key: string, claimKeyStr: string): void {
    const g = this.store(key).data
    g.claims = g.claims.filter((c) => c.key !== claimKeyStr)
    this.changed(key)
  }

  userSetNote(key: string, noteKey: string, value: string | null): void {
    const g = this.store(key).data
    if (value === null) delete g.notes[noteKey]
    else g.notes[noteKey] = { value, by: 'user', ts: Date.now() }
    this.changed(key)
  }

  clearHistory(key: string): void {
    const g = this.store(key).data
    g.messages = []
    g.edits = []
    this.changed(key)
  }

  // ---------- MCP tool calls ----------
  async callTool(s: SessionInfo, tool: string, a: Record<string, unknown>): Promise<string> {
    if (!s.meshGroup) return 'This session is not part of a mesh group.'
    const key = s.meshGroup
    const g = this.store(key).data
    const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v))
    switch (tool) {
      case 'mesh_peers': {
        const peers = this.peersOf(s)
        if (!peers.length) return `No other Claude sessions are active in ${g.label} right now. You are "${s.name}".`
        const claims = this.activeClaims(g)
        return [
          `You are "${s.name}". Peers in ${g.label}:`,
          ...peers.map((p) => {
            const pc = claims.filter((c) => c.sessionId === p.id).map((c) => `${c.key} (${c.intent})`)
            const recent = [...new Set(g.edits.filter((e) => e.sessionId === p.id).slice(-6).map((e) => e.key))]
            return `- "${p.name}" | status: ${p.status} | role: ${p.role}${p.branch ? ` | branch: ${p.branch}` : ''}\n  task: ${p.lastPrompt ? truncate(p.lastPrompt.replace(/\s+/g, ' '), 300) : '(none yet)'}\n  claims: ${pc.join(', ') || 'none'}\n  recent edits: ${recent.join(', ') || 'none'}${p.cwd !== s.cwd ? `\n  cwd: ${p.cwd}` : ''}`
          })
        ].join('\n')
      }
      case 'mesh_send': {
        const to = str(a.to)
        const kind = (str(a.kind) || (to.toLowerCase() === 'all' ? 'info' : 'request')) as MeshMessageKind
        if (!str(a.text)) return 'text is required'
        if (to.toLowerCase() === 'all') {
          const m = this.addMessage(key, { from: s.id, fromName: s.name, to: 'all', toName: 'all', kind, text: str(a.text) })
          return `Sent to all peers (message id ${m.id}).`
        }
        const peer = this.findPeer(s, to)
        if (!peer) return `No peer named "${to}". Peers: ${this.peersOf(s).map((p) => p.name).join(', ') || 'none'}`
        const m = this.addMessage(key, { from: s.id, fromName: s.name, to: peer.id, toName: peer.name, kind, text: str(a.text) })
        return `Sent to "${peer.name}" (message id ${m.id}). They are currently ${peer.status}.`
      }
      case 'mesh_reply': {
        const orig = g.messages.find((m) => m.id === str(a.messageId))
        if (!orig) return `No message with id ${str(a.messageId)}`
        const toUser = orig.from === 'user'
        const m = this.addMessage(key, {
          from: s.id,
          fromName: s.name,
          to: toUser ? 'user' : orig.from,
          toName: orig.fromName,
          kind: 'reply',
          text: str(a.text),
          replyTo: orig.id
        })
        return `Replied to ${orig.fromName} (message id ${m.id}).`
      }
      case 'mesh_ask': {
        const peer = this.findPeer(s, str(a.to))
        if (!peer) return `No peer named "${str(a.to)}".`
        const timeout = Math.min(600, Math.max(5, Number(a.timeoutSeconds) || 120)) * 1000
        const q = this.addMessage(key, { from: s.id, fromName: s.name, to: peer.id, toName: peer.name, kind: 'question', text: str(a.question) })
        const reply = await new Promise<MeshMessage | undefined>((resolve) => {
          const t = setTimeout(() => {
            this.replyWaiters.delete(q.id)
            resolve(undefined)
          }, timeout)
          this.replyWaiters.set(q.id, (m) => {
            clearTimeout(t)
            this.replyWaiters.delete(q.id)
            resolve(m)
          })
        })
        if (!reply) return `No reply from "${peer.name}" within ${timeout / 1000}s (they are ${peer.status}). Their answer will appear in your inbox later.`
        this.markRead(s, [reply])
        return `"${reply.fromName}" replied: ${reply.text}`
      }
      case 'mesh_inbox': {
        const unread = this.unreadFor(s)
        const list = a.includeRead
          ? g.messages.filter((m) => m.to === s.id || m.to === 'all' || m.from === s.id).slice(-30)
          : unread
        this.markRead(s, unread)
        return list.length ? this.formatMessages(list) : 'No new messages.'
      }
      case 'mesh_claim': {
        const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).map(str).filter(Boolean) : []
        const ttl = Math.min(240, Math.max(1, Number(a.ttlMinutes) || 30)) * 60_000
        const claims = this.activeClaims(g)
        const got: string[] = []
        const held: string[] = []
        for (const p of paths) {
          const abs = path.resolve(s.cwd, p)
          const k = claimKey(abs, s.root, WIN)
          const other = claims.find((c) => c.key === k && c.sessionId !== s.id && !c.soft)
          if (other) {
            held.push(`${k} (held by "${other.sessionName}": ${other.intent})`)
            continue
          }
          g.claims = g.claims.filter((c) => !(c.key === k && (c.sessionId === s.id || c.soft)))
          g.claims.push({ key: k, path: abs, sessionId: s.id, sessionName: s.name, intent: str(a.intent) || 'editing', expires: Date.now() + ttl, soft: false })
          got.push(k)
        }
        this.changed(key)
        return `${got.length ? `Claimed: ${got.join(', ')}.` : ''}${held.length ? ` Already claimed by others: ${held.join('; ')}. Coordinate with them first.` : ''}`.trim() || 'No paths given.'
      }
      case 'mesh_release': {
        const paths = Array.isArray(a.paths) ? (a.paths as unknown[]).map(str) : undefined
        const keys = paths?.map((p) => claimKey(path.resolve(s.cwd, p), s.root, WIN))
        const before = g.claims.length
        g.claims = g.claims.filter((c) => c.sessionId !== s.id || (keys && !keys.includes(c.key)))
        this.changed(key)
        return `Released ${before - g.claims.length} claim(s).`
      }
      case 'mesh_claims': {
        const c = this.activeClaims(g)
        return c.length
          ? c.map((x) => `${x.key} — "${x.sessionName}"${x.sessionId === s.id ? ' (you)' : ''}: ${x.intent}${x.soft ? ' (auto, while editing)' : ''}, expires in ${Math.round((x.expires - Date.now()) / 60000)}m`).join('\n')
          : 'No active claims.'
      }
      case 'board_list': {
        const items = g.board.filter((b) => !a.status || b.status === a.status)
        if (!items.length) return 'The board is empty.'
        return items
          .map(
            (b) =>
              `[${b.id}] (${b.status}) ${b.title}${b.ownerName ? ` — owner: ${b.ownerName}` : ' — unassigned'}${b.detail ? `\n    ${b.detail}` : ''}${b.notes.length ? `\n    notes: ${b.notes.slice(-3).map((n) => `${n.by}: ${n.text}`).join(' | ')}` : ''}`
          )
          .join('\n')
      }
      case 'board_add': {
        const items = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : []
        const added: string[] = []
        for (const it of items) {
          const assignee = it.assignee ? this.findPeer(s, str(it.assignee)) ?? (str(it.assignee).toLowerCase() === s.name.toLowerCase() ? s : undefined) : undefined
          const b: BoardItem = {
            id: 't' + shortId().slice(0, 4),
            title: str(it.title) || 'Untitled',
            detail: str(it.detail) || undefined,
            status: 'todo',
            owner: assignee?.id,
            ownerName: assignee?.name,
            createdBy: s.id,
            createdByName: s.name,
            notes: [],
            ts: Date.now(),
            updated: Date.now()
          }
          g.board.push(b)
          added.push(`[${b.id}] ${b.title}${assignee ? ` → ${assignee.name}` : ''}`)
          if (assignee && assignee.id !== s.id)
            this.addMessage(key, { from: s.id, fromName: s.name, to: assignee.id, toName: assignee.name, kind: 'request', text: `I assigned you board task [${b.id}] "${b.title}"${b.detail ? `: ${b.detail}` : ''}. Take it with board_take and mark it done with board_update when finished.` })
        }
        this.changed(key)
        return `Added ${added.length} task(s):\n${added.join('\n')}`
      }
      case 'board_take': {
        const b = a.id ? g.board.find((x) => x.id === str(a.id)) : g.board.find((x) => x.status === 'todo' && (!x.owner || x.owner === s.id))
        if (!b) return a.id ? `No task ${str(a.id)}.` : 'No unassigned todo tasks.'
        if (b.owner && b.owner !== s.id && b.status === 'doing') return `Task [${b.id}] is already being done by ${b.ownerName}.`
        b.owner = s.id
        b.ownerName = s.name
        b.status = 'doing'
        b.updated = Date.now()
        this.changed(key)
        return `You took [${b.id}] ${b.title}${b.detail ? `\nDetails: ${b.detail}` : ''}`
      }
      case 'board_update': {
        const b = g.board.find((x) => x.id === str(a.id))
        if (!b) return `No task ${str(a.id)}.`
        if (a.status) b.status = str(a.status) as BoardItem['status']
        if (a.note) b.notes.push({ by: s.name, text: str(a.note), ts: Date.now() })
        b.updated = Date.now()
        if (b.status === 'done' && b.createdBy !== s.id && b.createdBy !== 'user' && this.deps.get(b.createdBy))
          this.addMessage(key, { from: s.id, fromName: s.name, to: b.createdBy, toName: b.createdByName, kind: 'info', text: `Finished board task [${b.id}] "${b.title}".${a.note ? ` ${str(a.note)}` : ''}` })
        this.changed(key)
        return `Updated [${b.id}] → ${b.status}.`
      }
      case 'notes_set': {
        g.notes[str(a.key)] = { value: str(a.value), by: s.name, ts: Date.now() }
        this.changed(key)
        return `Saved note "${str(a.key)}".`
      }
      case 'notes_get': {
        if (a.key) {
          const n = g.notes[str(a.key)]
          return n ? `${str(a.key)} (by ${n.by}, ${ago(n.ts)}):\n${n.value}` : `No note "${str(a.key)}". Keys: ${Object.keys(g.notes).join(', ') || 'none'}`
        }
        const entries = Object.entries(g.notes)
        return entries.length ? entries.map(([k, n]) => `## ${k} (by ${n.by}, ${ago(n.ts)})\n${n.value}`).join('\n\n') : 'No shared notes yet.'
      }
      case 'mesh_wait': {
        const peer = this.findPeer(s, str(a.peer))
        if (!peer) return `No peer named "${str(a.peer)}".`
        if (peer.status === 'idle' || peer.status === 'exited') return `"${peer.name}" is ${peer.status}.`
        const timeout = Math.min(1800, Math.max(5, Number(a.timeoutSeconds) || 300)) * 1000
        const ok = await new Promise<boolean>((resolve) => {
          const t = setTimeout(() => resolve(false), timeout)
          const list = this.idleWaiters.get(peer.id) ?? []
          list.push(() => {
            clearTimeout(t)
            resolve(true)
          })
          this.idleWaiters.set(peer.id, list)
        })
        const now = this.deps.get(peer.id)
        return ok
          ? `"${peer.name}" is now ${now?.status ?? 'gone'}.${now?.lastAssistant ? ` Their last message: ${truncate(now.lastAssistant, 600)}` : ''}`
          : `Timed out; "${peer.name}" is still ${now?.status}.`
      }
      case 'read_terminal': {
        const target = str(a.target) || 'shell'
        const lines = Math.min(400, Math.max(5, Number(a.lines) || 80))
        let id: string | undefined
        if (target === 'shell') id = this.deps.shellOf(s.id)?.id
        else {
          const [peerName, sub] = target.split(':')
          const peer = this.findPeer(s, peerName)
          if (!peer) return `No peer or terminal "${target}".`
          id = sub === 'shell' ? this.deps.shellOf(peer.id)?.id : peer.id
        }
        if (!id) return `No terminal found for "${target}". (Open the shell drawer with Ctrl+\` first.)`
        return (await this.deps.readTerminal(id, lines)) || '(terminal is empty)'
      }
    }
    return `Unknown tool ${tool}`
  }
}
