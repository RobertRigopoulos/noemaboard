// @ts-check
/**
 * Noema relay wire protocol (binary WebSocket frames).
 *
 * Every frame is `[u8 type][fields...]` where integers are lib0-style varUints (7 bits per byte,
 * little-endian groups, high bit = continuation), strings are `varUint byteLength + UTF-8` and byte
 * arrays are `varUint length + bytes`. All payloads (`data`, `snapshot`) are opaque ciphertext:
 * the relay never sees plaintext and has no Yjs dependency.
 *
 * Keep in sync with src/collab/relay/protocol.ts (client) and relay/cloudflare/src/protocol.ts.
 */

export const PROTOCOL_VERSION = 1

export const MSG = Object.freeze({
  /** c→s varUint version, varUint flags, varString roomId, varString token, varString accessKey, varUint since */
  HELLO: 1,
  /** s→c varUint snapSeq, varUint head, varUint logBytes, varUint peers, varUint8Array snapshot (empty = none), varUint n, n × (varUint seq, varUint8Array data) */
  WELCOME: 2,
  /** c→s varUint clientMsgId, varUint8Array data */
  PUSH: 3,
  /** s→c varUint clientMsgId, varUint seq */
  ACK: 4,
  /** s→c varUint seq, varUint8Array data */
  UPD: 5,
  /** both varUint8Array data (ephemeral, never stored) */
  EPH: 6,
  /** c→s varUint upto, varUint8Array snapshot */
  COMPACT: 7,
  /** s→c varUint snapSeq, varUint logBytes */
  COMPACTED: 8,
  /** s→c varUint code, varUint ref (clientMsgId or 0), varString message */
  ERR: 9,
  /** both varUint transferId, varUint index, varUint total, varUint8Array chunk */
  PART: 10,
  /** s→c varUint number of other connections in the room */
  PEERS: 11,
})

/** HELLO flags. PROBE: check access only (used by "Test relay"), never creates a room. */
export const HELLO_PROBE = 1

export const ERR = Object.freeze({
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
})

/** WebSocket close codes used by the relay (4000-4999 are application defined). */
export const CLOSE = Object.freeze({
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
})

/** Largest frame put on the wire. Bigger logical frames are split into PART frames. */
export const MAX_WIRE_FRAME = 1024 * 1024
export const PART_CHUNK = 512 * 1024
/** Upper bound on PART chunks of one logical frame. */
export const MAX_PARTS = 4096

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,64}$/
export const HASH_RE = /^[0-9a-f]{64}$/

// ---------------------------------------------------------------------------
// Encoding

export class Encoder {
  constructor(initial = 64) {
    this.buf = new Uint8Array(initial)
    this.pos = 0
  }

  /** @param {number} n */
  ensure(n) {
    if (this.pos + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.pos + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.pos))
    this.buf = next
  }

  /** @param {number} b */
  u8(b) {
    this.ensure(1)
    this.buf[this.pos++] = b & 0xff
    return this
  }

  /** @param {number} n */
  varUint(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('varUint out of range')
    this.ensure(8)
    while (n > 0x7f) {
      this.buf[this.pos++] = 0x80 | (n % 0x80)
      n = Math.floor(n / 0x80)
    }
    this.buf[this.pos++] = n
    return this
  }

  /** @param {Uint8Array} bytes */
  bytes(bytes) {
    this.varUint(bytes.length)
    this.ensure(bytes.length)
    this.buf.set(bytes, this.pos)
    this.pos += bytes.length
    return this
  }

  /** @param {string} s */
  string(s) {
    return this.bytes(textEncoder.encode(s))
  }

  done() {
    return this.buf.subarray(0, this.pos)
  }
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8', { fatal: true })

export class ProtocolError extends Error {}

/** A logical message over the relay's limit (closed with CLOSE.TOO_LARGE so clients send smaller pieces). */
export class TooLargeError extends ProtocolError {}

export class Decoder {
  /** @param {Uint8Array} buf */
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }

  u8() {
    if (this.pos >= this.buf.length) throw new ProtocolError('unexpected end of frame')
    return this.buf[this.pos++]
  }

  varUint() {
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

  /** @param {number} [max] */
  bytes(max = Infinity) {
    const len = this.varUint()
    if (len > max) throw new ProtocolError('field too large')
    if (this.pos + len > this.buf.length) throw new ProtocolError('unexpected end of frame')
    const out = this.buf.subarray(this.pos, this.pos + len)
    this.pos += len
    return out
  }

  /** @param {number} [max] */
  string(max = 1024) {
    try {
      return textDecoder.decode(this.bytes(max))
    } catch (e) {
      if (e instanceof ProtocolError) throw e
      throw new ProtocolError('invalid utf-8')
    }
  }

  get done() {
    return this.pos >= this.buf.length
  }
}

// ---------------------------------------------------------------------------
// Frame builders (server side)

/**
 * `maxMessage` (largest logical message this relay accepts) is an optional trailing field: older
 * clients stop reading before it, newer clients treat its absence as "unknown".
 * @param {{ snapSeq: number, head: number, logBytes: number, peers: number, snapshot: Uint8Array | null, updates: { seq: number, data: Uint8Array }[], maxMessage?: number }} w
 */
export function encodeWelcome(w) {
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

/** @param {number} id @param {number} seq */
export const encodeAck = (id, seq) => new Encoder(20).u8(MSG.ACK).varUint(id).varUint(seq).done()

/** @param {number} seq @param {Uint8Array} data */
export const encodeUpd = (seq, data) => new Encoder(data.length + 16).u8(MSG.UPD).varUint(seq).bytes(data).done()

/** @param {Uint8Array} data */
export const encodeEph = (data) => new Encoder(data.length + 8).u8(MSG.EPH).bytes(data).done()

/** @param {number} snapSeq @param {number} logBytes */
export const encodeCompacted = (snapSeq, logBytes) => new Encoder(20).u8(MSG.COMPACTED).varUint(snapSeq).varUint(logBytes).done()

/** @param {number} code @param {number} ref @param {string} message */
export const encodeErr = (code, ref, message) => new Encoder(64).u8(MSG.ERR).varUint(code).varUint(ref).string(message.slice(0, 200)).done()

/** @param {number} n */
export const encodePeers = (n) => new Encoder(8).u8(MSG.PEERS).varUint(n).done()

// Client frame builders (used by tests and any JavaScript client).

/**
 * @param {{ roomId: string, token: string, accessKey?: string, since?: number, flags?: number, version?: number }} h
 */
export const encodeHello = (h) =>
  new Encoder(128)
    .u8(MSG.HELLO)
    .varUint(h.version ?? PROTOCOL_VERSION)
    .varUint(h.flags ?? 0)
    .string(h.roomId)
    .string(h.token)
    .string(h.accessKey ?? '')
    .varUint(h.since ?? 0)
    .done()

/** @param {number} id @param {Uint8Array} data */
export const encodePush = (id, data) => new Encoder(data.length + 16).u8(MSG.PUSH).varUint(id).bytes(data).done()

/** @param {number} upto @param {Uint8Array} snapshot */
export const encodeCompact = (upto, snapshot) => new Encoder(snapshot.length + 16).u8(MSG.COMPACT).varUint(upto).bytes(snapshot).done()

/**
 * Decodes any non-PART frame into a plain object (for tests, tools and debugging).
 * @param {Uint8Array} frame
 * @returns {Record<string, any> & { type: number }}
 */
export function decodeFrame(frame) {
  const d = new Decoder(frame)
  const type = d.u8()
  switch (type) {
    case MSG.HELLO:
      return { type, version: d.varUint(), flags: d.varUint(), roomId: d.string(64), token: d.string(128), accessKey: d.string(512), since: d.varUint() }
    case MSG.WELCOME: {
      const w = {
        type,
        snapSeq: d.varUint(),
        head: d.varUint(),
        logBytes: d.varUint(),
        peers: d.varUint(),
        snapshot: /** @type {Uint8Array | null} */ (null),
        updates: /** @type {{ seq: number, data: Uint8Array }[]} */ ([]),
        maxMessage: /** @type {number | null} */ (null),
      }
      const snap = d.bytes()
      w.snapshot = snap.length ? snap : null
      const n = d.varUint()
      for (let i = 0; i < n; i++) w.updates.push({ seq: d.varUint(), data: d.bytes() })
      if (!d.done) w.maxMessage = d.varUint() || null
      return w
    }
    case MSG.PUSH:
      return { type, id: d.varUint(), data: d.bytes() }
    case MSG.ACK:
      return { type, id: d.varUint(), seq: d.varUint() }
    case MSG.UPD:
      return { type, seq: d.varUint(), data: d.bytes() }
    case MSG.EPH:
      return { type, data: d.bytes() }
    case MSG.COMPACT:
      return { type, upto: d.varUint(), snapshot: d.bytes() }
    case MSG.COMPACTED:
      return { type, snapSeq: d.varUint(), logBytes: d.varUint() }
    case MSG.ERR:
      return { type, code: d.varUint(), ref: d.varUint(), message: d.string(1024) }
    case MSG.PEERS:
      return { type, peers: d.varUint() }
    default:
      throw new ProtocolError(`unknown frame type ${type}`)
  }
}

/**
 * Splits a logical frame into wire frames of at most MAX_WIRE_FRAME bytes.
 * @param {Uint8Array} frame
 * @param {number} transferId
 * @returns {Uint8Array[]}
 */
export function splitFrame(frame, transferId) {
  if (frame.length <= MAX_WIRE_FRAME) return [frame]
  const total = Math.ceil(frame.length / PART_CHUNK)
  const out = []
  for (let i = 0; i < total; i++) {
    const chunk = frame.subarray(i * PART_CHUNK, Math.min(frame.length, (i + 1) * PART_CHUNK))
    out.push(new Encoder(chunk.length + 24).u8(MSG.PART).varUint(transferId).varUint(i).varUint(total).bytes(chunk).done())
  }
  return out
}

/**
 * Reassembles PART frames from one peer. `push` returns the complete logical frame when the
 * last part arrives, null while incomplete, and throws ProtocolError on abuse.
 */
export class Reassembler {
  /** @param {number} maxMessage largest logical frame accepted, in bytes */
  constructor(maxMessage, maxConcurrent = 4) {
    this.maxMessage = maxMessage
    this.maxConcurrent = maxConcurrent
    /** @type {Map<number, { total: number, chunks: Uint8Array[], size: number }>} */
    this.transfers = new Map()
  }

  /** @param {Decoder} d decoder positioned after the PART type byte */
  push(d) {
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
    // The chunk is a view into the wire frame, which is not reused, so no copy is needed.
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

  /** Bytes currently buffered in incomplete transfers. */
  get buffered() {
    let n = 0
    for (const t of this.transfers.values()) n += t.size
    return n
  }

  /** Drops every incomplete transfer (frees its memory). */
  reset() {
    this.transfers.clear()
  }
}
