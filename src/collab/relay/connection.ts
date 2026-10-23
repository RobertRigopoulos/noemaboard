/**
 * One board's connection to a relay: an end-to-end encrypted, append-only log of Yjs updates.
 *
 *  - On connect: HELLO(since = last applied seq) → WELCOME(snapshot?, tail) → decrypt + apply.
 *  - Local edits (transaction.local) are merged and pushed at most once per second; unacked pushes
 *    stay in an outbox and are re-sent after reconnecting.
 *  - Edits that reached us from elsewhere (peer-to-peer, other tabs) are only pushed if the relay
 *    still lacks them after a short grace period, so teammates do not upload each other's edits.
 *  - The first connection of a session "reconciles": anything in the local doc the relay may lack
 *    (changes made while offline or before the relay was configured) is pushed as one diff.
 *  - Pushes larger than the relay's message limit (announced in WELCOME) are split into several
 *    (split.ts). A piece that cannot be split small enough stays queued and the board stays dirty:
 *    it is never reported as synced while the relay lacks it.
 *  - When the log tail grows, a client uploads an encrypted full-state snapshot (COMPACT).
 *  - Presence (awareness) travels as encrypted ephemeral frames, never stored.
 */
import * as Y from 'yjs'
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates, type Awareness } from 'y-protocols/awareness'
import { KIND, SEAL_OVERHEAD, open, seal, type RelayKeys } from './keys'
import {
  CLOSE,
  Decoder,
  ERR,
  MSG,
  ProtocolError,
  Reassembler,
  decodeServerFrame,
  encodeCompact,
  encodeEph,
  encodeHello,
  encodePush,
  splitFrame,
  type ServerFrame,
  type WelcomeFrame,
} from './protocol'
import { RelayCoverage, exceeds } from './coverage'
import { splitUpdate } from './split'
import { freshState, fromBase64, localStateStore, toBase64, type RelayBoardState, type RelayStateStore } from './state'
import { MIXED_CONTENT_MESSAGE, wsUrlFor, type RelayEndpoint } from './url'
import type { BoardRelayStatus, RelayConnectionState } from './status'

export interface RelayTiming {
  /** Minimum time between two pushes of local edits. */
  pushIntervalMs: number
  /** Minimum time between two presence messages (4 Hz). */
  ephIntervalMs: number
  /** Random wait before pushing edits that arrived from elsewhere. */
  foreignDelayMs: [number, number]
  /** Random wait before compacting, so not every client compacts at once. */
  compactDelayMs: [number, number]
  /** Compact when the log tail has more updates than this... */
  compactUpdates: number
  /** ...or more bytes than this. */
  compactBytes: number
  backoffBaseMs: number
  backoffMaxMs: number
  /** Give up on a connection that did not complete the handshake in time. */
  helloTimeoutMs: number
  keepaliveMs: number
  /** Consider the connection dead when nothing arrived for this long. */
  deadAfterMs: number
  persistDelayMs: number
}

export const DEFAULT_TIMING: RelayTiming = {
  pushIntervalMs: 1000,
  ephIntervalMs: 250,
  foreignDelayMs: [4000, 12000],
  compactDelayMs: [3000, 20000],
  compactUpdates: 300,
  compactBytes: 1024 * 1024,
  backoffBaseMs: 1000,
  backoffMaxMs: 60_000,
  helloTimeoutMs: 15_000,
  keepaliveMs: 25_000,
  deadAfterMs: 90_000,
  persistDelayMs: 2000,
}

/** Largest single push or snapshot frame we send, whatever the relay allows. */
const MAX_PUSH_BYTES = 30 * 1024 * 1024
/**
 * Message limit assumed for relays that do not announce theirs in WELCOME (older versions: 16 MB
 * on Cloudflare, 32 MB on Node). Pushes are split to fit, so a low guess only costs extra frames.
 */
const DEFAULT_RELAY_MESSAGE_BYTES = 16 * 1024 * 1024
/** Floor when shrinking the limit after the relay rejected a message as too large. */
const MIN_MESSAGE_BYTES = 64 * 1024
/** PUSH/COMPACT framing plus encryption added on top of a plaintext update. */
const FRAME_OVERHEAD = SEAL_OVERHEAD + 32
/** A snapshot too large to send is not rebuilt (a full-doc encode) before this much time passed. */
const COMPACT_RETRY_MS = 10 * 60_000
/** Largest logical frame we accept from the relay. */
const MAX_INCOMING_BYTES = 256 * 1024 * 1024
const MAX_EPH_BYTES = 60 * 1024
/** Buffered edits from elsewhere beyond this are handled by a state diff instead. */
const MAX_FOREIGN_BYTES = 8 * 1024 * 1024

export interface RelayConnectionOptions {
  boardId: string
  endpoint: RelayEndpoint
  keys: RelayKeys
  doc: Y.Doc
  store?: RelayStateStore
  timing?: Partial<RelayTiming>
  WebSocketImpl?: typeof WebSocket
  onStatus?: (status: BoardRelayStatus) => void
  /** Called after every successful handshake (e.g. to upload missing files). */
  onWelcome?: () => void
}

interface OutboxEntry {
  plain: Uint8Array
  /** Socket the entry was sent on; anything not sent on the current socket is re-sent. */
  sock: WebSocket | null
}

const rand = ([a, b]: [number, number]) => a + Math.random() * Math.max(0, b - a)

const merge = (updates: Uint8Array[]): Uint8Array => (updates.length === 1 ? updates[0] : Y.mergeUpdates(updates))

/** y-indexeddb replays stored updates with itself as origin: those are not new edits. */
function isPersistenceOrigin(origin: unknown): boolean {
  return typeof origin === 'object' && origin !== null && '_storeUpdate' in origin && 'whenSynced' in origin
}

/** Client ids contained in an awareness update, or null if malformed. */
export function awarenessClientIds(update: Uint8Array): number[] | null {
  try {
    const d = new Decoder(update)
    const n = d.varUint()
    if (n > 1000) return null
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      ids.push(d.varUint())
      d.varUint()
      d.string(MAX_EPH_BYTES)
    }
    return ids
  } catch {
    return null
  }
}

export class RelayConnection {
  readonly boardId: string
  /** Transaction origin of updates applied from the relay. */
  readonly origin: { relay: string }

  private readonly endpoint: RelayEndpoint
  private readonly keys: RelayKeys
  private readonly doc: Y.Doc
  private readonly store: RelayStateStore
  private readonly timing: RelayTiming
  private readonly WS: typeof WebSocket
  private readonly opts: RelayConnectionOptions

  private state: RelayBoardState
  private started = false
  private stopped = false
  private ws: WebSocket | null = null
  private welcomed = false
  private reconciled = false
  private attempt = 0
  private openedAt = 0
  private lastRecvAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private queue: Promise<void> = Promise.resolve()
  private parts = new Reassembler(MAX_INCOMING_BYTES)
  private transferSeq = 0
  /** Message limit announced by the relay (null: not announced). */
  private relayMessageLimit: number | null = null
  /** Lowered after the relay closed the connection because a message was too large. */
  private limitCap = Infinity
  /** Largest logical frame sent on the current socket. */
  private largestSent = 0

  private pending: Uint8Array[] = []
  private outbox = new Map<number, OutboxEntry>()
  private nextMsgId = 1
  private lastPushAt = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private quotaBlocked = false

  private foreign: Uint8Array[] = []
  private foreignBytes = 0
  private foreignOverflow = false
  private foreignTimer: ReturnType<typeof setTimeout> | null = null
  private coverage = new RelayCoverage()

  private logBytes = 0
  private compactTimer: ReturnType<typeof setTimeout> | null = null
  private compacting: { upto: number; snapshot: Uint8Array } | null = null
  private compactBlockedUntil = 0

  private awareness: Awareness | null = null
  private relayClients = new Set<number>()
  private ephTimer: ReturnType<typeof setTimeout> | null = null
  private lastEphAt = 0

  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private status: { state: RelayConnectionState; message?: string } = { state: 'connecting' }
  private peers = 0
  private lastSyncAt = 0

  constructor(opts: RelayConnectionOptions) {
    this.opts = opts
    this.boardId = opts.boardId
    this.endpoint = opts.endpoint
    this.keys = opts.keys
    this.doc = opts.doc
    this.store = opts.store ?? localStateStore
    this.timing = { ...DEFAULT_TIMING, ...opts.timing }
    this.WS = opts.WebSocketImpl ?? WebSocket
    this.origin = { relay: opts.endpoint.display }
    this.state = this.store.load(this.boardId, this.endpoint.wsBase)
  }

  // -------------------------------------------------------------------------
  // Public API

  start() {
    if (this.started || this.stopped) return
    this.started = true
    // An empty local copy (e.g. site data cleared) cannot hold anything from the relay: refetch all.
    if (this.state.lastSeq > 0 && this.doc.store.clients.size === 0) this.state = freshState(this.endpoint.wsBase)
    if (this.state.sv) {
      try {
        this.coverage.addStateVector(Y.decodeStateVector(fromBase64(this.state.sv)))
      } catch {
        this.state.sv = ''
      }
    }
    this.doc.on('update', this.onDocUpdate)
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline)
    this.connect()
  }

  /** Disconnects for good. `forget` also drops local bookkeeping (relay removed from the board). */
  stop(opts: { forget?: boolean } = {}) {
    if (this.stopped) return
    this.stopped = true
    this.doc.off('update', this.onDocUpdate)
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline)
    const farewell = this.welcomed && this.awareness ? this.farewell(this.awareness) : null
    this.detachAwareness(false)
    for (const t of [this.retryTimer, this.flushTimer, this.foreignTimer, this.compactTimer, this.ephTimer, this.persistTimer]) {
      if (t) clearTimeout(t)
    }
    this.retryTimer = this.flushTimer = this.foreignTimer = this.compactTimer = this.ephTimer = this.persistTimer = null
    this.stopKeepalive()
    const ws = this.ws
    this.ws = null
    this.welcomed = false
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      const close = () => {
        try {
          ws.close(CLOSE.NORMAL, 'bye')
        } catch {
          // already closed
        }
      }
      if (farewell) {
        farewell
          .then((frame) => {
            if (ws.readyState === ws.OPEN) ws.send(frame as Uint8Array<ArrayBuffer>)
          })
          .catch(() => {})
          .finally(close)
      } else {
        close()
      }
    }
    if (opts.forget) this.store.clear(this.boardId)
    else this.persistNow()
  }

  /** Forwards presence for this board through the relay (only while the board is open). */
  attachAwareness(a: Awareness) {
    if (this.awareness === a || this.stopped) return
    this.detachAwareness()
    this.awareness = a
    a.on('update', this.onAwarenessUpdate)
    if (this.welcomed) this.sendAwarenessSoon()
  }

  detachAwareness(sayGoodbye = true) {
    const a = this.awareness
    if (!a) return
    a.off('update', this.onAwarenessUpdate)
    if (sayGoodbye && this.welcomed) {
      const ws = this.ws
      void this.farewell(a).then((frame) => {
        if (this.ws === ws && this.welcomed) this.sendFrame(frame)
      })
    }
    this.awareness = null
    this.relayClients.clear()
    if (this.ephTimer) clearTimeout(this.ephTimer)
    this.ephTimer = null
  }

  /** EPH frame telling others we left: a null state with our current clock replaces ours at receivers. */
  private async farewell(a: Awareness): Promise<Uint8Array> {
    const update = encodeAwarenessUpdate(a, [a.clientID], new Map())
    return encodeEph(await seal(this.keys, KIND.AWARENESS, update))
  }

  get connected(): boolean {
    return this.welcomed
  }

  /** True when every local change is known to be on the relay. */
  get clean(): boolean {
    return !this.state.dirty && this.outbox.size === 0 && this.pending.length === 0 && this.foreign.length === 0
  }

  get lastSeq(): number {
    return this.state.lastSeq
  }

  get snapSeq(): number {
    return this.state.snapSeq
  }

  get relayKeys(): RelayKeys {
    return this.keys
  }

  get relayEndpoint(): RelayEndpoint {
    return this.endpoint
  }

  /** Largest logical frame (push or snapshot) we send to this relay. */
  get messageLimit(): number {
    return Math.min(this.relayMessageLimit ?? DEFAULT_RELAY_MESSAGE_BYTES, MAX_PUSH_BYTES, this.limitCap)
  }

  /** Largest plaintext update that fits in one push. */
  private get pushLimit(): number {
    return Math.max(1024, this.messageLimit - FRAME_OVERHEAD)
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle

  private connect() {
    if (this.stopped || this.ws) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.setState('offline', 'No network connection.')
      return
    }
    if (this.status.state !== 'error') this.setState('connecting')
    let ws: WebSocket
    try {
      ws = new this.WS(wsUrlFor(this.endpoint, this.keys.roomId))
    } catch (e) {
      // Both are permanent for this page: retrying cannot help.
      const blocked = (e as { name?: unknown } | null)?.name === 'SecurityError'
      this.setState('error', blocked ? MIXED_CONTENT_MESSAGE : 'The relay address is not valid.')
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.openedAt = 0
    this.largestSent = 0
    const helloTimer = setTimeout(() => {
      if (this.ws === ws && !this.welcomed) this.drop(4000, 'handshake timeout')
    }, this.timing.helloTimeoutMs)
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.openedAt = this.lastRecvAt = Date.now()
      this.sendFrame(
        encodeHello({
          roomId: this.keys.roomId,
          token: this.keys.writeToken,
          accessKey: this.endpoint.accessKey,
          since: this.state.lastSeq,
        }),
      )
      this.startKeepalive()
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (this.ws !== ws) return
      this.lastRecvAt = Date.now()
      const data: unknown = ev.data
      if (typeof data === 'string') return
      this.enqueue(async () => {
        const buf = data instanceof ArrayBuffer ? data : data instanceof Blob ? await data.arrayBuffer() : null
        if (buf) await this.onWireFrame(new Uint8Array(buf), ws)
      })
    }
    ws.onclose = (ev: CloseEvent) => {
      clearTimeout(helloTimer)
      if (this.ws === ws) this.onClosed(ev.code, ev.reason)
    }
    ws.onerror = () => {
      // A close event always follows.
    }
  }

  /** Abandons the current socket immediately (dead or out of sync) and reconnects. */
  private drop(code: number, reason: string) {
    const ws = this.ws
    if (!ws) return
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
    try {
      ws.close(code, reason)
    } catch {
      // ignore
    }
    this.onClosed(code, reason)
  }

  private onClosed(code: number, reason: string) {
    this.ws = null
    this.welcomed = false
    this.parts.reset()
    this.stopKeepalive()
    this.compacting = null
    if (this.compactTimer) clearTimeout(this.compactTimer)
    this.compactTimer = null
    for (const e of this.outbox.values()) e.sock = null
    const a = this.awareness
    if (a && this.relayClients.size) {
      removeAwarenessStates(a, Array.from(this.relayClients).filter((id) => id !== a.clientID), 'relay')
    }
    this.relayClients.clear()
    this.peers = 0
    if (this.stopped) return
    if (this.openedAt && Date.now() - this.openedAt > 30_000) this.attempt = 0
    const backoff = Math.min(this.timing.backoffMaxMs, this.timing.backoffBaseMs * 2 ** this.attempt) * (0.7 + Math.random() * 0.6)
    this.attempt = Math.min(this.attempt + 1, 20)
    const MIN = 60_000
    // Older relays report an oversized message as a generic protocol error.
    if (code === CLOSE.TOO_LARGE || (code === CLOSE.BAD_REQUEST && /too large/i.test(reason))) {
      // Next time, send everything in pieces of at most half of what was refused.
      const refused = Math.min(this.messageLimit, this.largestSent || this.messageLimit)
      this.limitCap = Math.max(MIN_MESSAGE_BYTES, Math.floor(refused / 2))
      this.setState('error', 'The relay refused a change as too large. Sending it in smaller pieces…')
      return this.retryIn(Math.max(backoff, 2000))
    }
    switch (code) {
      case CLOSE.UNAUTHORIZED:
        this.setState('error', 'The relay refused this board (its key does not match). The relay room may belong to an older copy of the board.')
        return this.retryIn(Math.max(backoff, 5 * MIN))
      case CLOSE.FORBIDDEN:
        this.setState('error', 'This relay needs a valid access key. Add ?key=… to the relay address.')
        return this.retryIn(Math.max(backoff, 5 * MIN))
      case CLOSE.VERSION:
        this.setState('error', 'This relay runs an incompatible version. Update the app or the relay.')
        return this.retryIn(30 * MIN)
      case CLOSE.SERVER_FULL:
        this.setState('error', 'The relay has reached its limit of boards.')
        return this.retryIn(Math.max(backoff, 10 * MIN))
      case CLOSE.BAD_REQUEST:
        this.setState('error', `The relay rejected data from this app${reason ? ` (${reason})` : ''}.`)
        return this.retryIn(Math.max(backoff, 30_000))
      case CLOSE.RATE_LIMITED:
        this.setState('offline', 'The relay is rate limiting this network. Retrying soon…')
        return this.retryIn(Math.max(backoff, 10_000))
      case CLOSE.GOING_AWAY:
        this.setState('connecting', 'The relay restarted. Reconnecting…')
        return this.retryIn(backoff)
      default:
        this.setState('offline', "Can't reach the relay. Retrying…")
        return this.retryIn(backoff)
    }
  }

  private retryIn(ms: number) {
    if (this.stopped) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, ms)
  }

  private onOnline = () => {
    if (this.stopped || this.ws) return
    this.attempt = 0
    this.connect()
  }

  private startKeepalive() {
    this.stopKeepalive()
    this.keepaliveTimer = setInterval(() => {
      const ws = this.ws
      if (!ws) return
      if (Date.now() - this.lastRecvAt > this.timing.deadAfterMs) {
        this.drop(4000, 'keepalive timeout')
        return
      }
      if (ws.readyState === ws.OPEN) ws.send('ping')
    }, this.timing.keepaliveMs)
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer)
    this.keepaliveTimer = null
  }

  private sendFrame(frame: Uint8Array): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== ws.OPEN) return false
    if (frame.length > this.largestSent) this.largestSent = frame.length
    for (const f of splitFrame(frame, ++this.transferSeq)) ws.send(f as Uint8Array<ArrayBuffer>)
    return true
  }

  /** Frames are handled strictly in order even though decryption is asynchronous. */
  private enqueue(fn: () => Promise<void>) {
    this.queue = this.queue.then(fn).catch((e: unknown) => {
      if (e instanceof ProtocolError) this.drop(CLOSE.BAD_REQUEST, 'protocol error')
      else console.warn('[relay] failed to handle a message', e)
    })
  }

  // -------------------------------------------------------------------------
  // Incoming frames

  private async onWireFrame(bytes: Uint8Array, ws: WebSocket) {
    if (this.ws !== ws) return
    let frame: Uint8Array | null = bytes
    if (bytes[0] === MSG.PART) frame = this.parts.push(bytes)
    if (!frame) return
    const f: ServerFrame = decodeServerFrame(frame)
    if (!this.welcomed && f.type !== MSG.WELCOME && f.type !== MSG.ERR) throw new ProtocolError('expected welcome')
    switch (f.type) {
      case MSG.WELCOME:
        return this.onWelcome(f, ws)
      case MSG.UPD: {
        if (f.seq <= this.state.lastSeq) return
        if (f.seq !== this.state.lastSeq + 1) return this.drop(4000, 'resync')
        const plain = await open(this.keys, KIND.UPDATE, f.data).catch(() => null)
        if (this.ws !== ws) return
        if (plain) {
          this.applyRemote([plain])
          this.coverage.add(plain)
        }
        this.state.lastSeq = f.seq
        this.logBytes += f.data.length
        this.touchSync()
        this.persistSoon()
        this.maybeCompact()
        return
      }
      case MSG.ACK: {
        const e = this.outbox.get(f.id)
        if (e) {
          this.outbox.delete(f.id)
          this.coverage.add(e.plain)
          this.logBytes += e.plain.length + SEAL_OVERHEAD
        }
        if (f.seq > this.state.lastSeq) {
          if (f.seq !== this.state.lastSeq + 1) return this.drop(4000, 'resync')
          this.state.lastSeq = f.seq
        }
        this.touchSync()
        this.persistSoon()
        this.checkClean()
        this.maybeCompact()
        return
      }
      case MSG.EPH:
        return this.onEphemeral(f.data, ws)
      case MSG.COMPACTED: {
        if (this.compacting && f.snapSeq >= this.compacting.upto) this.coverage.add(this.compacting.snapshot)
        this.compacting = null
        this.state.snapSeq = Math.min(f.snapSeq, this.state.lastSeq)
        this.logBytes = f.logBytes
        this.persistSoon()
        if (this.quotaBlocked) {
          this.quotaBlocked = false
          this.setState('connected')
          this.resendOutbox()
        }
        return
      }
      case MSG.ERR:
        return this.onError(f.code, f.ref, f.message)
      case MSG.PEERS:
        this.peers = f.peers
        this.emitStatus()
        return
    }
  }

  private async onWelcome(f: WelcomeFrame, ws: WebSocket) {
    if (this.welcomed) throw new ProtocolError('duplicate welcome')
    // Decrypt everything first, then apply synchronously so a dropped socket never leaves us half done.
    const plains: Uint8Array[] = []
    let failed = 0
    if (f.snapshot) {
      const p = await open(this.keys, KIND.SNAPSHOT, f.snapshot).catch(() => null)
      if (p) plains.push(p)
      else failed++
    }
    for (const u of f.updates) {
      const p = await open(this.keys, KIND.UPDATE, u.data).catch(() => null)
      if (p) plains.push(p)
      else failed++
    }
    if (this.ws !== ws) return
    if (failed) console.warn(`[relay] skipped ${failed} undecryptable message(s) for board ${this.boardId}`)

    if (f.head < this.state.lastSeq) {
      // The relay lost data or is a different server: it sent everything; push everything back.
      this.state = { ...freshState(this.endpoint.wsBase), dirty: true }
      this.coverage.clear()
      this.reconciled = false
    }
    this.applyRemote(plains)
    for (const p of plains) this.coverage.add(p)
    if (f.maxMessage !== this.relayMessageLimit) {
      // A different limit may make a snapshot that did not fit possible again.
      this.relayMessageLimit = f.maxMessage
      this.compactBlockedUntil = 0
    }
    this.state.lastSeq = f.head
    this.state.snapSeq = Math.min(f.snapSeq, f.head)
    this.logBytes = f.logBytes
    this.peers = f.peers
    this.welcomed = true
    this.quotaBlocked = false
    this.lastSyncAt = Date.now()
    this.setState('connected')
    this.persistSoon()

    if (!this.reconciled) this.reconcile()
    this.resendOutbox()
    if (this.foreign.length || this.foreignOverflow) this.scheduleForeignCheck()
    this.sendAwarenessSoon()
    this.maybeCompact()
    this.checkClean()
    try {
      this.opts.onWelcome?.()
    } catch (e) {
      console.warn('[relay] onWelcome failed', e)
    }
  }

  private applyRemote(plains: Uint8Array[]) {
    if (!plains.length) return
    try {
      Y.applyUpdate(this.doc, merge(plains), this.origin)
    } catch {
      // One bad update (e.g. written by a buggy client) must not block the others.
      for (const p of plains) {
        try {
          Y.applyUpdate(this.doc, p, this.origin)
        } catch (e) {
          console.warn('[relay] skipped a malformed update', e)
        }
      }
    }
  }

  private async onEphemeral(data: Uint8Array, ws: WebSocket) {
    if (!this.awareness || data.length > MAX_EPH_BYTES + 64) return
    const plain = await open(this.keys, KIND.AWARENESS, data).catch(() => null)
    const a = this.awareness
    if (!plain || !a || this.ws !== ws) return
    const ids = awarenessClientIds(plain)
    if (!ids) return
    const states = a.getStates()
    const isNew = ids.some((id) => id !== a.clientID && !states.has(id))
    try {
      applyAwarenessUpdate(a, plain, 'relay')
    } catch {
      return
    }
    for (const id of ids) if (id !== a.clientID) this.relayClients.add(id)
    // Someone new: answer with our state right away instead of waiting for the 15 s renewal.
    if (isNew) this.sendAwarenessSoon()
  }

  private onError(code: number, ref: number, message: string) {
    if (code === ERR.QUOTA) {
      this.quotaBlocked = true
      const e = this.outbox.get(ref)
      if (e) e.sock = null
      this.setState('error', 'This board is over its storage quota on the relay. Ask the relay admin to raise MAX_ROOM_MB.')
      // Compaction replaces the log with a (usually much smaller) snapshot and may free space.
      this.maybeCompact(true)
      return
    }
    console.warn(`[relay] error ${code}: ${message}`)
  }

  // -------------------------------------------------------------------------
  // Outgoing document updates

  private onDocUpdate = (update: Uint8Array, origin: unknown, _doc: Y.Doc, tr: Y.Transaction) => {
    if (origin === this.origin || this.stopped || isPersistenceOrigin(origin)) return
    if (tr.local) {
      this.pending.push(update)
      if (this.pending.length > 200) this.pending = [Y.mergeUpdates(this.pending)]
      this.markDirty()
      this.scheduleFlush()
      return
    }
    // Edits from elsewhere: their authors normally push them; we check later (see checkForeign).
    if (this.foreignOverflow) return
    this.foreignBytes += update.length
    if (this.foreignBytes > MAX_FOREIGN_BYTES) {
      this.foreignOverflow = true
      this.foreign = []
      this.foreignBytes = 0
      this.markDirty()
    } else {
      this.foreign.push(update)
    }
    this.scheduleForeignCheck()
  }

  private markDirty() {
    if (this.state.dirty) return
    this.state.dirty = true
    // Persist right away: if the app closes before the push is confirmed, the next session re-sends.
    this.persistNow()
    this.emitStatus()
  }

  private scheduleFlush() {
    if (this.flushTimer) return
    const wait = Math.max(30, this.lastPushAt + this.timing.pushIntervalMs - Date.now())
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.flush()
    }, wait)
  }

  private flush() {
    if (!this.welcomed || this.quotaBlocked || !this.pending.length) return
    const update = merge(this.pending)
    this.pending = []
    this.sendPush(update)
  }

  /**
   * Queues `plain` for the relay, cut into pieces that fit its message limit. A piece that cannot
   * be cut small enough (one enormous struct) stays in the outbox unsent, so the board stays
   * dirty (never marked clean) and it is tried again whenever the connection or limit changes.
   */
  private sendPush(plain: Uint8Array) {
    const limit = this.pushLimit
    let pieces: Uint8Array[]
    try {
      pieces = splitUpdate(plain, limit)
    } catch (e) {
      console.warn('[relay] could not split a large update', e)
      pieces = [plain]
    }
    let held = 0
    for (const piece of pieces) {
      const fits = piece.length <= limit
      if (!fits) held++
      this.queuePush(piece, fits)
    }
    this.lastPushAt = Date.now()
    if (held) {
      this.markDirty()
      const mb = Math.max(1, Math.floor(this.messageLimit / (1024 * 1024)))
      this.setState('error', `A change is too large for this relay (over ${mb} MB). It stays on this device; the relay admin can raise MAX_MESSAGE_MB.`)
    }
    this.emitStatus()
  }

  private queuePush(plain: Uint8Array, sendable: boolean) {
    const id = this.nextMsgId++
    const entry: OutboxEntry = { plain, sock: null }
    this.outbox.set(id, entry)
    if (!sendable || !this.welcomed || this.quotaBlocked) return
    const ws = this.ws
    entry.sock = ws
    void seal(this.keys, KIND.UPDATE, plain).then(
      (ct) => {
        if (this.outbox.get(id) !== entry) return
        if (this.ws !== ws || !this.welcomed || !this.sendFrame(encodePush(id, ct))) entry.sock = null
      },
      (e: unknown) => {
        entry.sock = null
        console.warn('[relay] encryption failed', e)
      },
    )
  }

  /** Re-sends (merged) everything not sent on the current socket, plus queued edits. */
  private resendOutbox() {
    if (!this.welcomed || this.quotaBlocked) return
    const stale: Uint8Array[] = []
    for (const [id, e] of this.outbox) {
      if (e.sock !== this.ws) {
        stale.push(e.plain)
        this.outbox.delete(id)
      }
    }
    stale.push(...this.pending)
    this.pending = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (stale.length) this.sendPush(merge(stale))
  }

  /**
   * Pushes whatever the local doc has that the relay may lack: changes from earlier sessions that
   * were never confirmed, or the whole board when the relay was just configured.
   */
  private reconcile() {
    this.reconciled = true
    const docSV = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    const base = this.coverage.stateVector()
    if (!this.state.dirty && !exceeds(docSV, base)) return
    const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(base))
    // The diff includes every queued change, so the queues can go.
    this.pending = []
    this.outbox.clear()
    this.foreign = []
    this.foreignBytes = 0
    this.foreignOverflow = false
    this.sendPush(diff)
  }

  private scheduleForeignCheck() {
    if (this.foreignTimer || this.stopped) return
    this.foreignTimer = setTimeout(() => {
      this.foreignTimer = null
      this.checkForeign()
    }, rand(this.timing.foreignDelayMs))
  }

  private checkForeign() {
    if (!this.welcomed || this.quotaBlocked) return
    let uncovered: Uint8Array[]
    if (this.foreignOverflow) {
      // Too much to track individually: diff the doc against what the relay is known to have.
      const diff = Y.encodeStateAsUpdate(this.doc, Y.encodeStateVector(this.coverage.stateVector()))
      uncovered = this.coverage.covers(diff) ? [] : [diff]
    } else {
      uncovered = this.foreign.filter((u) => !this.coverage.covers(u))
    }
    this.foreign = []
    this.foreignBytes = 0
    this.foreignOverflow = false
    if (uncovered.length) this.sendPush(merge(uncovered))
    this.checkClean()
  }

  /** When nothing is in flight, the relay holds everything the local doc has: remember that. */
  private checkClean() {
    if (!this.welcomed || !this.reconciled) return
    if (this.outbox.size || this.pending.length || this.foreign.length || this.foreignOverflow) return
    const sv = toBase64(Y.encodeStateVector(this.doc))
    if (!this.state.dirty && sv === this.state.sv) return
    this.state.dirty = false
    this.state.sv = sv
    this.persistSoon()
    this.emitStatus()
  }

  // -------------------------------------------------------------------------
  // Compaction

  private maybeCompact(force = false) {
    if (!this.welcomed || this.compactTimer || this.compacting) return
    if (Date.now() < this.compactBlockedUntil) return
    if (!force && !this.needsCompaction()) return
    if (this.state.lastSeq <= this.state.snapSeq) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = null
      void this.compact(force)
    }, rand(this.timing.compactDelayMs))
  }

  private needsCompaction(): boolean {
    return this.state.lastSeq - this.state.snapSeq > this.timing.compactUpdates || this.logBytes > this.timing.compactBytes
  }

  private async compact(force: boolean) {
    const ws = this.ws
    if (!ws || !this.welcomed || this.compacting) return
    // Another client may have compacted while we waited.
    if (!force && !this.needsCompaction()) return
    const upto = this.state.lastSeq
    if (upto <= this.state.snapSeq) return
    // Every update <= upto has been applied to the doc, so its full state supersedes them.
    const snapshot = Y.encodeStateAsUpdate(this.doc)
    if (snapshot.length + FRAME_OVERHEAD > this.messageLimit) {
      // A snapshot is one message and cannot be split: keep the log, and do not rebuild the
      // snapshot on every update meanwhile.
      this.compactBlockedUntil = Date.now() + COMPACT_RETRY_MS
      return
    }
    const sealed = await seal(this.keys, KIND.SNAPSHOT, snapshot)
    if (this.ws !== ws || !this.welcomed || upto <= this.state.snapSeq) return
    this.compacting = { upto, snapshot }
    this.sendFrame(encodeCompact(upto, sealed))
  }

  // -------------------------------------------------------------------------
  // Presence

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const a = this.awareness
    if (!a || origin === 'relay') return
    const id = a.clientID
    if (added.includes(id) || updated.includes(id) || removed.includes(id)) this.sendAwarenessSoon()
  }

  private sendAwarenessSoon() {
    if (this.ephTimer || !this.awareness || !this.welcomed) return
    const wait = Math.max(0, this.lastEphAt + this.timing.ephIntervalMs - Date.now())
    this.ephTimer = setTimeout(() => {
      this.ephTimer = null
      void this.sendAwareness()
    }, wait)
  }

  private async sendAwareness() {
    const a = this.awareness
    const ws = this.ws
    if (!a || !ws || !this.welcomed) return
    this.lastEphAt = Date.now()
    const update = encodeAwarenessUpdate(a, [a.clientID])
    if (update.length > MAX_EPH_BYTES) return
    const ct = await seal(this.keys, KIND.AWARENESS, update)
    if (this.ws === ws && this.welcomed) this.sendFrame(encodeEph(ct))
  }

  // -------------------------------------------------------------------------
  // Persistence + status

  private persistSoon() {
    if (this.persistTimer || this.stopped) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, this.timing.persistDelayMs)
  }

  private persistNow() {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.store.save(this.boardId, this.state)
  }

  private touchSync() {
    const now = Date.now()
    // Status consumers only need coarse freshness; avoid re-rendering on every update.
    if (now - this.lastSyncAt > 5000) {
      this.lastSyncAt = now
      this.emitStatus()
    } else {
      this.lastSyncAt = now
    }
  }

  private setState(state: RelayConnectionState, message?: string) {
    this.status = { state, message }
    this.emitStatus()
  }

  private emitStatus() {
    if (!this.opts.onStatus || this.stopped) return
    this.opts.onStatus({
      url: this.endpoint.display,
      state: this.status.state,
      message: this.status.message,
      peers: this.peers,
      lastSyncAt: this.lastSyncAt || undefined,
      pending: this.outbox.size + (this.pending.length ? 1 : 0),
    })
  }
}
