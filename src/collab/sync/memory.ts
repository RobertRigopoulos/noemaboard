/**
 * In-memory network for tests: rooms of transports that deliver asynchronously (like a real
 * network), with switches to take a peer offline and bring it back.
 */
import { decodeBlobReply, encodeBlobHeader } from './protocol'
import type { BlobResult, RoomTransport, TransportHandlers } from './transport'

export class MemoryHub {
  private readonly rooms = new Map<string, Map<string, MemoryTransport>>()
  private readonly offline = new Set<string>()
  /** Pairs currently "connected" (both online, both in the room), as `roomId\npeerA\npeerB` sorted. */
  private readonly links = new Set<string>()
  /** Every delivered message, for assertions: [roomId, from, to, bytes]. */
  readonly log: [string, string, string, Uint8Array][] = []
  /** Return true to drop a message (simulates loss). */
  drop: ((roomId: string, from: string, to: string, data: Uint8Array) => boolean) | null = null

  transport(roomId: string, peerId: string): MemoryTransport {
    return new MemoryTransport(this, roomId, peerId)
  }

  isOffline(peerId: string) {
    return this.offline.has(peerId)
  }

  /** Simulates losing (or regaining) the network for one peer in every room. */
  setOffline(peerId: string, off: boolean) {
    if (off === this.offline.has(peerId)) return
    if (off) {
      this.offline.add(peerId)
      for (const [roomId, members] of this.rooms) {
        if (!members.has(peerId)) continue
        for (const other of members.keys()) if (other !== peerId) this.unlink(roomId, peerId, other)
      }
    } else {
      this.offline.delete(peerId)
      for (const [roomId, members] of this.rooms) {
        if (!members.has(peerId)) continue
        for (const other of members.keys()) if (other !== peerId) this.link(roomId, peerId, other)
      }
    }
  }

  private readonly blocked = new Set<string>()

  /** Two peers that can never connect directly (NAT), in every room: a partial mesh. */
  block(a: string, b: string) {
    this.blocked.add(a < b ? `${a}\n${b}` : `${b}\n${a}`)
    for (const [roomId, members] of this.rooms) if (members.has(a) && members.has(b)) this.unlink(roomId, a, b)
  }

  peersIn(roomId: string): string[] {
    return [...(this.rooms.get(roomId)?.keys() ?? [])]
  }

  /** @internal */
  join(t: MemoryTransport) {
    let members = this.rooms.get(t.roomId)
    if (!members) this.rooms.set(t.roomId, (members = new Map()))
    members.set(t.selfId, t)
    for (const other of members.keys()) if (other !== t.selfId) this.link(t.roomId, t.selfId, other)
  }

  /** @internal */
  leave(t: MemoryTransport) {
    const members = this.rooms.get(t.roomId)
    if (members?.get(t.selfId) !== t) return
    for (const other of members.keys()) if (other !== t.selfId) this.unlink(t.roomId, t.selfId, other)
    members.delete(t.selfId)
  }

  /** @internal */
  deliver(from: MemoryTransport, to: string, data: Uint8Array) {
    if (!this.links.has(this.key(from.roomId, from.selfId, to))) return
    if (this.drop?.(from.roomId, from.selfId, to, data)) return
    const copy = data.slice()
    setTimeout(() => {
      if (!this.links.has(this.key(from.roomId, from.selfId, to))) return
      const target = this.rooms.get(from.roomId)?.get(to)
      if (!target) return
      this.log.push([from.roomId, from.selfId, to, copy])
      target.handlers?.onMessage(copy, from.selfId)
    }, 0)
  }

  /** @internal */
  async request(from: MemoryTransport, to: string, hash: string): Promise<BlobResult | null> {
    await new Promise((r) => setTimeout(r, 0))
    if (!this.links.has(this.key(from.roomId, from.selfId, to))) throw new Error('disconnected')
    const target = this.rooms.get(from.roomId)?.get(to)
    const reply = await target?.handlers?.onBlobRequest(hash, from.selfId)
    if (!reply) return null
    // Same envelope as over WebRTC.
    const body = reply.data instanceof Uint8Array ? reply.data : new Uint8Array(await reply.data.arrayBuffer())
    const header = encodeBlobHeader(reply.mime)
    const wire = new Uint8Array(header.length + body.length)
    wire.set(header)
    wire.set(body, header.length)
    return decodeBlobReply(wire)
  }

  private key(roomId: string, a: string, b: string) {
    return a < b ? `${roomId}\n${a}\n${b}` : `${roomId}\n${b}\n${a}`
  }

  private link(roomId: string, a: string, b: string) {
    if (this.offline.has(a) || this.offline.has(b)) return
    if (this.blocked.has(a < b ? `${a}\n${b}` : `${b}\n${a}`)) return
    const k = this.key(roomId, a, b)
    if (this.links.has(k)) return
    this.links.add(k)
    const members = this.rooms.get(roomId)
    setTimeout(() => {
      if (!this.links.has(k)) return
      members?.get(a)?.handlers?.onPeerJoin(b)
      members?.get(b)?.handlers?.onPeerJoin(a)
    }, 0)
  }

  private unlink(roomId: string, a: string, b: string) {
    const k = this.key(roomId, a, b)
    if (!this.links.delete(k)) return
    const members = this.rooms.get(roomId)
    members?.get(a)?.handlers?.onPeerLeave(b)
    members?.get(b)?.handlers?.onPeerLeave(a)
  }
}

export class MemoryTransport implements RoomTransport {
  handlers: TransportHandlers | null = null
  private left = false

  constructor(
    private readonly hub: MemoryHub,
    readonly roomId: string,
    readonly selfId: string,
  ) {}

  connect(handlers: TransportHandlers): void {
    if (this.left) return
    this.handlers = handlers
    this.hub.join(this)
  }

  send(data: Uint8Array, targets: readonly string[]): void {
    if (this.left) return
    for (const t of targets) this.hub.deliver(this, t, data)
  }

  requestBlob(hash: string, peerId: string): Promise<BlobResult | null> {
    return this.hub.request(this, peerId, hash)
  }

  async leave(): Promise<void> {
    if (this.left) return
    this.hub.leave(this)
    this.left = true
    this.handlers = null
  }
}
