/**
 * Same-device transport: tabs and windows of one profile share IndexedDB but not memory, so
 * loaded docs (Home included) and presence are kept in sync through a BroadcastChannel.
 * Every tab is a "peer"; joins are announced, leaves are announced on pagehide and otherwise
 * detected by missing heartbeats (background tabs can be throttled to one timer per minute).
 */
import type { BlobResult, RoomTransport, TransportHandlers } from './transport'

type Envelope =
  | { t: 'hello'; from: string }
  | { t: 'here'; from: string; to: string }
  | { t: 'ping'; from: string }
  | { t: 'bye'; from: string }
  | { t: 'data'; from: string; to: string[]; data: Uint8Array }

const MAX_PEERS = 64

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(9))
  return 'tab:' + Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('')
}

function parse(raw: unknown): Envelope | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.from !== 'string' || !m.from.startsWith('tab:') || m.from.length > 40) return null
  switch (m.t) {
    case 'hello':
    case 'ping':
    case 'bye':
      return { t: m.t, from: m.from }
    case 'here':
      return typeof m.to === 'string' ? { t: 'here', from: m.from, to: m.to } : null
    case 'data':
      if (!(m.data instanceof Uint8Array) || !Array.isArray(m.to)) return null
      return { t: 'data', from: m.from, to: m.to.filter((x): x is string => typeof x === 'string'), data: m.data }
    default:
      return null
  }
}

export interface BroadcastTransportOptions {
  pingMs?: number
  timeoutMs?: number
}

export class BroadcastChannelTransport implements RoomTransport {
  readonly selfId = randomId()
  private ch: BroadcastChannel | null = null
  private handlers: TransportHandlers | null = null
  /** peer -> last time we heard from it */
  private readonly peers = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly pingMs: number
  private readonly timeoutMs: number
  private readonly onPageHide = () => this.post({ t: 'bye', from: this.selfId })

  constructor(
    private readonly name: string,
    opts: BroadcastTransportOptions = {},
  ) {
    this.pingMs = opts.pingMs ?? 10_000
    this.timeoutMs = opts.timeoutMs ?? 75_000
  }

  static isSupported(): boolean {
    return typeof BroadcastChannel !== 'undefined'
  }

  connect(handlers: TransportHandlers): void {
    if (this.ch || !BroadcastChannelTransport.isSupported()) return
    this.handlers = handlers
    this.ch = new BroadcastChannel(this.name)
    this.ch.onmessage = (e: MessageEvent) => this.receive(e.data)
    this.post({ t: 'hello', from: this.selfId })
    this.timer = setInterval(() => this.tick(), this.pingMs)
    if (typeof addEventListener === 'function') addEventListener('pagehide', this.onPageHide)
  }

  private post(msg: Envelope) {
    try {
      this.ch?.postMessage(msg)
    } catch {
      // channel closed
    }
  }

  private receive(raw: unknown) {
    const m = parse(raw)
    if (!m || m.from === this.selfId || !this.handlers) return
    if (m.t === 'bye') {
      this.drop(m.from)
      return
    }
    if (m.t === 'here' && m.to !== this.selfId) return
    const known = this.peers.has(m.from)
    if (!known && this.peers.size >= MAX_PEERS) return
    this.peers.set(m.from, Date.now())
    if (!known) {
      // Make sure the other side knows us too (it may have timed us out while we were frozen).
      if (m.t !== 'here') this.post({ t: 'here', from: this.selfId, to: m.from })
      this.handlers.onPeerJoin(m.from)
    }
    if (m.t === 'data' && m.to.includes(this.selfId)) this.handlers?.onMessage(m.data, m.from)
  }

  private drop(peer: string) {
    if (!this.peers.delete(peer)) return
    this.handlers?.onPeerLeave(peer)
  }

  private tick() {
    this.post({ t: 'ping', from: this.selfId })
    const cutoff = Date.now() - this.timeoutMs
    for (const [peer, seen] of this.peers) if (seen < cutoff) this.drop(peer)
  }

  send(data: Uint8Array, targets: readonly string[]): void {
    if (!this.ch || !targets.length) return
    this.post({ t: 'data', from: this.selfId, to: [...targets], data })
  }

  async requestBlob(): Promise<BlobResult | null> {
    // Tabs share the IndexedDB blob store; there is nothing to fetch from each other.
    return null
  }

  async leave(): Promise<void> {
    if (!this.ch) return
    this.post({ t: 'bye', from: this.selfId })
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (typeof removeEventListener === 'function') removeEventListener('pagehide', this.onPageHide)
    this.handlers = null
    this.peers.clear()
    this.ch.close()
    this.ch = null
  }
}
