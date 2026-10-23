/**
 * Relay wire protocol, client side. Binary frames: `[u8 type][fields...]` with lib0-style varUints,
 * length-prefixed strings and byte arrays. Payloads are AES-GCM ciphertext (see keys.ts), so the
 * relay only ever sees opaque bytes.
 *
 * Keep in sync with relay/src/protocol.js (Node server) and relay/cloudflare/src/protocol.ts.
 */

export const PROTOCOL_VERSION = 1

export const MSG = {
  HELLO: 1,
  WELCOME: 2,
  PUSH: 3,
  ACK: 4,
  UPD: 5,
  EPH: 6,
  COMPACT: 7,
  COMPACTED: 8,
  ERR: 9,
  PART: 10,
  PEERS: 11,
} as const

export const HELLO_PROBE = 1

export const ERR = {
  BAD_REQUEST: 1,
  UNAUTHORIZED: 2,
  FORBIDDEN: 3,
  TOO_LARGE: 4,
  QUOTA: 5,
  RATE_LIMITED: 6,
  VERSION: 7,
  INTERNAL: 8,
  ROOM_LIMIT: 9,
  STALE: 10,
} as const

export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  BAD_REQUEST: 4400,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  HELLO_TIMEOUT: 4408,
  TOO_LARGE: 4413,
  VERSION: 4426,
  RATE_LIMITED: 4429,
  INTERNAL: 4500,
  SERVER_FULL: 4503,
} as const

export const MAX_WIRE_FRAME = 1024 * 1024
export const PART_CHUNK = 512 * 1024
export const MAX_PARTS = 4096

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export class ProtocolError extends Error {}

export class Encoder {
  private buf: Uint8Array
  private pos = 0

  constructor(initial = 64) {
    this.buf = new Uint8Array(initial)
  }

  private ensure(n: number) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  u8(b: number): this {
    this.ensure(1)
    this.buf[this.pos++] = b & 0xff
    return this
  }

  varUint(n: number): this {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('varUint out of range')
    this.ensure(8)
    while (n > 0x7f) {
      this.buf[this.pos++] = 0x80 | (n % 0x80)
      n = Math.floor(n / 0x80)
    }
    this.buf[this.pos++] = n
    return this
  }

  bytes(b: Uint8Array): this {
    this.varUint(b.length)
    this.ensure(b.length)
    this.buf.set(b, this.pos)
    this.pos += b.length
    return this
  }

  string(s: string): this {
    return this.bytes(textEncoder.encode(s))
  }

  done(): Uint8Array {
    return this.buf.subarray(0, this.pos)
  }
}

export class Decoder {
  pos = 0
  constructor(readonly buf: Uint8Array) {}

  u8(): number {
    if (this.pos >= this.buf.length) throw new ProtocolError('unexpected end of frame')
    return this.buf[this.pos++]
  }

  varUint(): number {
    let n = 0
    let mult = 1
    for (let i = 0; i < 8; i++) {
      const b = this.u8()
      n += (b & 0x7f) * mult
      if (b < 0x80) {
        if (!Number.isSafeInteger(n)) throw new ProtocolError('varUint too large')
        return n
      }
      mult *= 0x80
    }
    throw new ProtocolError('varUint too long')
  }

  bytes(max = Infinity): Uint8Array {
    const len = this.varUint()
    if (len > max) throw new ProtocolError('field too large')
    if (this.pos + len > this.buf.length) throw new ProtocolError('unexpected end of frame')
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  string(max = 1024): string {
    const b = this.bytes(max)
    try {
      return textDecoder.decode(b)
    } catch {
      throw new ProtocolError('invalid utf-8')
    }
  }
}

// ---------------------------------------------------------------------------
// Client → server

export interface Hello {
  roomId: string
  token: string
  accessKey?: string
  since?: number
  flags?: number
}

export const encodeHello = (h: Hello): Uint8Array =>
  new Encoder(160)
    .u8(MSG.HELLO)
    .varUint(PROTOCOL_VERSION)
    .varUint(h.flags ?? 0)
    .string(h.roomId)
    .string(h.token)
    .string(h.accessKey ?? '')
    .varUint(h.since ?? 0)
    .done()

export const encodePush = (id: number, data: Uint8Array): Uint8Array =>
  new Encoder(data.length + 16).u8(MSG.PUSH).varUint(id).bytes(data).done()

export const encodeEph = (data: Uint8Array): Uint8Array => new Encoder(data.length + 8).u8(MSG.EPH).bytes(data).done()

export const encodeCompact = (upto: number, snapshot: Uint8Array): Uint8Array =>
  new Encoder(snapshot.length + 16).u8(MSG.COMPACT).varUint(upto).bytes(snapshot).done()

// ---------------------------------------------------------------------------
// Server → client

export interface WelcomeFrame {
  type: typeof MSG.WELCOME
  snapSeq: number
  head: number
  logBytes: number
  peers: number
  snapshot: Uint8Array | null
  updates: { seq: number; data: Uint8Array }[]
  /** Largest logical frame the relay accepts (optional trailing field; null from older relays). */
  maxMessage: number | null
}

export type ServerFrame =
  | WelcomeFrame
  | { type: typeof MSG.ACK; id: number; seq: number }
  | { type: typeof MSG.UPD; seq: number; data: Uint8Array }
  | { type: typeof MSG.EPH; data: Uint8Array }
  | { type: typeof MSG.COMPACTED; snapSeq: number; logBytes: number }
  | { type: typeof MSG.ERR; code: number; ref: number; message: string }
  | { type: typeof MSG.PEERS; peers: number }

/** Decodes a complete (already reassembled) frame sent by the relay. Throws ProtocolError. */
export function decodeServerFrame(frame: Uint8Array): ServerFrame {
  const d = new Decoder(frame)
  const type = d.u8()
  switch (type) {
    case MSG.WELCOME: {
      const snapSeq = d.varUint()
      const head = d.varUint()
      const logBytes = d.varUint()
      const peers = d.varUint()
      const snap = d.bytes()
      const n = d.varUint()
      if (n > frame.length) throw new ProtocolError('bad update count')
      const updates: { seq: number; data: Uint8Array }[] = []
      for (let i = 0; i < n; i++) updates.push({ seq: d.varUint(), data: d.bytes() })
      // Fields appended by newer relays; older relays end the frame here.
      const maxMessage = d.pos < frame.length ? d.varUint() : 0
      return { type, snapSeq, head, logBytes, peers, snapshot: snap.length ? snap : null, updates, maxMessage: maxMessage || null }
    }
    case MSG.ACK:
      return { type, id: d.varUint(), seq: d.varUint() }
    case MSG.UPD:
      return { type, seq: d.varUint(), data: d.bytes() }
    case MSG.EPH:
      return { type, data: d.bytes() }
    case MSG.COMPACTED:
      return { type, snapSeq: d.varUint(), logBytes: d.varUint() }
    case MSG.ERR:
      return { type, code: d.varUint(), ref: d.varUint(), message: d.string(1024) }
    case MSG.PEERS:
      return { type, peers: d.varUint() }
    default:
      throw new ProtocolError(`unexpected frame type ${type}`)
  }
}

// ---------------------------------------------------------------------------
// Large frames

/** Splits a logical frame into wire frames of at most MAX_WIRE_FRAME bytes. */
export function splitFrame(frame: Uint8Array, transferId: number): Uint8Array[] {
  if (frame.length <= MAX_WIRE_FRAME) return [frame]
  const total = Math.ceil(frame.length / PART_CHUNK)
  const out: Uint8Array[] = []
  for (let i = 0; i < total; i++) {
    const chunk = frame.subarray(i * PART_CHUNK, Math.min(frame.length, (i + 1) * PART_CHUNK))
    out.push(new Encoder(chunk.length + 24).u8(MSG.PART).varUint(transferId).varUint(i).varUint(total).bytes(chunk).done())
  }
  return out
}

/** Reassembles PART frames; returns the logical frame once complete, null while incomplete. */
export class Reassembler {
  private transfers = new Map<number, { total: number; chunks: Uint8Array[]; size: number }>()

  constructor(
    private maxMessage: number,
    private maxConcurrent = 4,
  ) {}

  /** `frame` is a PART wire frame (including its type byte). */
  push(frame: Uint8Array): Uint8Array | null {
    const d = new Decoder(frame)
    if (d.u8() !== MSG.PART) throw new ProtocolError('not a part')
    const id = d.varUint()
    const index = d.varUint()
    const total = d.varUint()
    const chunk = d.bytes(MAX_WIRE_FRAME)
    if (total < 2 || total > MAX_PARTS) throw new ProtocolError('bad part count')
    let t = this.transfers.get(id)
    if (!t) {
      if (index !== 0) throw new ProtocolError('part out of order')
      if (this.transfers.size >= this.maxConcurrent) throw new ProtocolError('too many transfers')
      t = { total, chunks: [], size: 0 }
      this.transfers.set(id, t)
    }
    if (index !== t.chunks.length || total !== t.total) throw new ProtocolError('part out of order')
    t.size += chunk.length
    if (t.size > this.maxMessage) throw new ProtocolError('message too large')
    t.chunks.push(chunk)
    if (t.chunks.length < t.total) return null
    this.transfers.delete(id)
    const out = new Uint8Array(t.size)
    let off = 0
    for (const c of t.chunks) {
      out.set(c, off)
      off += c.length
    }
    return out
  }

  reset() {
    this.transfers.clear()
  }
}
