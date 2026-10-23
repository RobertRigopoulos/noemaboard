/**
 * Noema relay wire protocol (server side, Cloudflare Workers).
 * Keep in sync with ../../src/protocol.js (Node server) and src/collab/relay/protocol.ts (client).
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

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
export const HASH_RE = /^[0-9a-f]{64}$/

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

export class ProtocolError extends Error {}

/** A logical message over the relay's limit (closed with CLOSE.TOO_LARGE so clients send smaller pieces). */
export class TooLargeError extends ProtocolError {}

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
  readonly buf: Uint8Array

  constructor(buf: Uint8Array) {
    this.buf = buf
  }

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

export interface Welcome {
  snapSeq: number
  head: number
  logBytes: number
  peers: number
  snapshot: Uint8Array | null
  updates: { seq: number; data: Uint8Array }[]
  /** Largest logical message accepted; optional trailing field older clients never read. */
  maxMessage?: number
}

export function encodeWelcome(w: Welcome): Uint8Array {
  let size = 40 + (w.snapshot?.length ?? 0)
  for (const u of w.updates) size += u.data.length + 16
  const e = new Encoder(size)
  e.u8(MSG.WELCOME).varUint(w.snapSeq).varUint(w.head).varUint(w.logBytes).varUint(w.peers)
  e.bytes(w.snapshot ?? new Uint8Array(0))
  e.varUint(w.updates.length)
  for (const u of w.updates) e.varUint(u.seq).bytes(u.data)
  if (w.maxMessage) e.varUint(w.maxMessage)
  return e.done()
}

export const encodeAck = (id: number, seq: number) => new Encoder(20).u8(MSG.ACK).varUint(id).varUint(seq).done()
export const encodeUpd = (seq: number, data: Uint8Array) => new Encoder(data.length + 16).u8(MSG.UPD).varUint(seq).bytes(data).done()
export const encodeEph = (data: Uint8Array) => new Encoder(data.length + 8).u8(MSG.EPH).bytes(data).done()
export const encodeCompacted = (snapSeq: number, logBytes: number) =>
  new Encoder(20).u8(MSG.COMPACTED).varUint(snapSeq).varUint(logBytes).done()
export const encodeErr = (code: number, ref: number, message: string) =>
  new Encoder(64).u8(MSG.ERR).varUint(code).varUint(ref).string(message.slice(0, 200)).done()
export const encodePeers = (n: number) => new Encoder(8).u8(MSG.PEERS).varUint(n).done()

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

export class Reassembler {
  private transfers = new Map<number, { total: number; chunks: Uint8Array[]; size: number }>()
  private readonly maxMessage: number
  private readonly maxConcurrent: number

  constructor(maxMessage: number, maxConcurrent = 4) {
    this.maxMessage = maxMessage
    this.maxConcurrent = maxConcurrent
  }

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
    if (t.size > this.maxMessage) throw new TooLargeError('message too large')
    // Copy: the incoming message buffer is not ours to keep.
    t.chunks.push(chunk.slice())
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

  /** Bytes held in incomplete transfers. */
  get buffered(): number {
    let n = 0
    for (const t of this.transfers.values()) n += t.size
    return n
  }
}
