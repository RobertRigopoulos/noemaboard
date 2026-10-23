/**
 * WebRTC transport over Trystero. Each room is joined through BOTH the Nostr and the BitTorrent
 * tracker strategies for redundancy; the same peer (same Trystero selfId) may therefore connect
 * twice. Peers are merged by id and every send goes through one live connection per peer.
 *
 * DTLS encrypts data channels end to end; the room password (derived from the board secret)
 * encrypts signaling, so relays only ever see opaque, rotating offers.
 */
import { joinRoom as joinNostr, selfId, getRelaySockets as nostrSockets } from 'trystero'
import { joinRoom as joinTorrent, getRelaySockets as torrentSockets } from '@trystero-p2p/torrent'
import type { DataPayload, JoinError, JoinRoom, MessageAction, RequestAction, Room } from 'trystero'
import { APP_ID } from '../../config'
import { MAX_MESSAGE_BYTES, decodeBlobReply, encodeBlobHeader } from './protocol'
import type { NetConfig } from './network'
import type { BlobResult, RoomTransport, TransportHandlers, TransportOptions } from './transport'

type StrategyName = 'nostr' | 'torrent'

interface Strand {
  name: StrategyName
  room: Room
  y: MessageAction<Uint8Array>
  blob: RequestAction<DataPayload, DataPayload>
}

const STRATEGIES: { name: StrategyName; join: JoinRoom; relays: (c: NetConfig) => string[] }[] = [
  { name: 'nostr', join: joinNostr, relays: (c) => c.nostrRelays },
  { name: 'torrent', join: joinTorrent, relays: (c) => c.trackers },
]

/** Hashes are 64 hex chars; anything bigger is not a blob request. */
const MAX_BLOB_REQUEST_BYTES = 256

export class TrysteroTransport implements RoomTransport {
  readonly selfId = selfId
  private handlers: TransportHandlers | null = null
  private strands: Strand[] = []
  /** peerId -> strategies it is connected through, in connection order (first = route). */
  private readonly routes = new Map<string, StrategyName[]>()
  /** Pending blob requests per peer, so incoming progress keeps them alive. */
  private readonly pending = new Map<string, Set<() => void>>()
  private closed = false

  constructor(
    private readonly opts: TransportOptions,
    private readonly net: NetConfig,
  ) {}

  connect(handlers: TransportHandlers): void {
    if (this.closed || this.handlers) return
    this.handlers = handlers
    for (const s of STRATEGIES) {
      try {
        this.strands.push(this.joinStrand(s.name, s.join, s.relays(this.net)))
      } catch (err) {
        console.warn(`[sync] ${s.name} signaling unavailable`, err)
      }
    }
  }

  private joinStrand(name: StrategyName, join: JoinRoom, relays: string[]): Strand {
    const room = join(
      {
        appId: APP_ID,
        password: this.opts.password,
        relayConfig: { urls: relays, warnOnRelayFailure: false },
        rtcConfig: this.net.rtcConfig,
        maxReceiveBytes: this.net.maxReceiveBytes,
      },
      this.opts.roomId,
      { onJoinError: (e: JoinError) => this.onJoinError(e) },
    )
    const y = room.makeAction<Uint8Array>('y', {
      onReceive: ({ byteLength }) => byteLength <= MAX_MESSAGE_BYTES,
    })
    const blob = room.makeAction<DataPayload, DataPayload>('blob', {
      kind: 'request',
      onReceive: ({ kind, byteLength }) => (kind === 'request' ? byteLength <= MAX_BLOB_REQUEST_BYTES : byteLength <= this.net.maxReceiveBytes),
    })
    const strand: Strand = { name, room, y, blob }
    y.onMessage = (data, { peerId }) => {
      if (this.closed || !this.routes.has(peerId)) return
      const bytes = data instanceof Uint8Array ? data : (data as unknown) instanceof ArrayBuffer ? new Uint8Array(data as ArrayBuffer) : null
      if (bytes) this.handlers?.onMessage(bytes, peerId)
    }
    blob.onRequest = async (data, { peerId }) => {
      if (this.closed || typeof data !== 'string' || !this.handlers) return null
      const reply = await this.handlers.onBlobRequest(data, peerId)
      if (!reply) return null
      // Blob parts are read lazily while chunks are sent, so big files do not sit in memory twice.
      return new Blob([encodeBlobHeader(reply.mime) as Uint8Array<ArrayBuffer>, reply.data as Blob | Uint8Array<ArrayBuffer>])
    }
    blob.onReceiveProgress = (_p, { peerId }) => this.pending.get(peerId)?.forEach((touch) => touch())
    room.onPeerJoin = (peerId) => this.onPeerJoin(name, peerId)
    room.onPeerLeave = (peerId) => this.onPeerLeave(name, peerId)
    return strand
  }

  private onPeerJoin(name: StrategyName, peerId: string) {
    if (this.closed || typeof peerId !== 'string') return
    const via = this.routes.get(peerId)
    if (via) {
      if (!via.includes(name)) via.push(name)
      return
    }
    this.routes.set(peerId, [name])
    this.handlers?.onPeerJoin(peerId)
  }

  private onPeerLeave(name: StrategyName, peerId: string) {
    if (this.closed) return
    const via = this.routes.get(peerId)
    if (!via) return
    const i = via.indexOf(name)
    if (i >= 0) via.splice(i, 1)
    if (via.length) return
    this.routes.delete(peerId)
    this.handlers?.onPeerLeave(peerId)
  }

  private onJoinError(e: JoinError) {
    if (this.closed || !e || typeof e.error !== 'string') return
    // "could not connect to peer … after exchanging SDP": NAT traversal failed, TURN would help.
    if (/could not connect/i.test(e.error) && typeof e.peerId === 'string') this.handlers?.onConnectFailure?.(e.peerId)
  }

  private route(peerId: string): Strand | undefined {
    const name = this.routes.get(peerId)?.[0]
    return name ? this.strands.find((s) => s.name === name) : undefined
  }

  send(data: Uint8Array, targets: readonly string[]): void {
    if (this.closed || !targets.length) return
    const groups = new Map<Strand, string[]>()
    for (const t of targets) {
      const s = this.route(t)
      if (!s) continue
      const list = groups.get(s)
      if (list) list.push(t)
      else groups.set(s, [t])
    }
    for (const [s, ids] of groups) {
      // Lost messages are repaired by anti-entropy; nothing to do on failure.
      s.y.send(data, { target: ids }).catch(() => {})
    }
  }

  async requestBlob(hash: string, peerId: string, opts: { idleTimeoutMs: number }): Promise<BlobResult | null> {
    const s = this.route(peerId)
    if (this.closed || !s) return null
    const ctrl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    const touch = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(), opts.idleTimeoutMs)
    }
    let set = this.pending.get(peerId)
    if (!set) this.pending.set(peerId, (set = new Set()))
    set.add(touch)
    touch()
    try {
      const res = await s.blob.request(hash, { target: peerId, signal: ctrl.signal })
      return res instanceof Uint8Array ? decodeBlobReply(res) : null
    } finally {
      if (timer) clearTimeout(timer)
      set.delete(touch)
      if (!set.size) this.pending.delete(peerId)
    }
  }

  async leave(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.handlers = null
    this.routes.clear()
    const strands = this.strands
    this.strands = []
    // Handlers go first: a stale onPeerJoin was observed firing after leave() in testing.
    for (const s of strands) {
      s.room.onPeerJoin = null
      s.room.onPeerLeave = null
      s.y.onMessage = null
      s.blob.onRequest = null
      s.blob.onReceiveProgress = null
    }
    await Promise.allSettled(strands.map((s) => s.room.leave()))
  }
}

export function createTrysteroTransport(opts: TransportOptions, net: NetConfig): TrysteroTransport {
  return new TrysteroTransport(opts, net)
}

/**
 * Whether any signaling relay socket is open. null before any room was joined (no sockets yet).
 */
export function signalingConnected(): boolean | null {
  const sockets: unknown[] = []
  for (const get of [nostrSockets, torrentSockets]) {
    try {
      sockets.push(...Object.values((get() ?? {}) as Record<string, unknown>))
    } catch {
      // strategy not initialised
    }
  }
  if (!sockets.length) return null
  return sockets.some((s) => !!s && (s as WebSocket).readyState === 1)
}
