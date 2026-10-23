/**
 * Noema relay for Cloudflare Workers (works on the free plan).
 *
 * Same protocol as the Node relay (relay/src/server.js):
 *   - RelayRoom: one SQLite-backed Durable Object per board room. WebSockets use the Hibernation
 *     API, so idle connections cost nothing; "ping" text frames are answered by the runtime
 *     without waking the object. While a multi-part message is incomplete a timer stays pending,
 *     which keeps the object in memory so the parts received so far are not lost.
 *   - BlobStore: one Durable Object per board room for encrypted files, stored in rows of at most
 *     1.5 MB (SQLite rows are limited to 2 MB). No R2/KV, no alarms.
 * Everything stored is ciphertext; the relay cannot read boards.
 */
import { DurableObject } from 'cloudflare:workers'
import {
  CLOSE,
  Decoder,
  ERR,
  HASH_RE,
  HELLO_PROBE,
  MSG,
  PROTOCOL_VERSION,
  ProtocolError,
  Reassembler,
  ROOM_ID_RE,
  TooLargeError,
  encodeAck,
  encodeCompacted,
  encodeEph,
  encodeErr,
  encodePeers,
  encodeUpd,
  encodeWelcome,
  splitFrame,
} from './protocol'

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>
  BLOBS: DurableObjectNamespace<BlobStore>
  /** Optional relay-wide key (set with `wrangler secret put ACCESS_KEY`). */
  ACCESS_KEY?: string
  MAX_BLOB_MB?: string
  MAX_ROOM_MB?: string
  MAX_MESSAGE_MB?: string
}

const VERSION = '0.1.0'
const MiB = 1024 * 1024
/** SQLite rows are limited to 2 MB on Durable Objects. */
const ROW_CHUNK = 1_500_000
const MAX_EPHEMERAL = 64 * 1024
const MAX_SOCKETS_PER_ROOM = 256
/** Per-socket message budget (token bucket). */
const MSG_RATE = 50
const MSG_BURST = 200
/** HELLO is small and never split; anything else before it is refused without buffering. */
const MAX_HELLO_BYTES = 4096
/** A multi-part message whose next part takes longer than this is dropped (and its socket closed). */
const PART_IDLE_MS = 60_000

function limits(env: Env) {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v)
    return Number.isFinite(x) && x > 0 ? x : d
  }
  return {
    maxBlobBytes: n(env.MAX_BLOB_MB, 25) * MiB,
    maxRoomBytes: n(env.MAX_ROOM_MB, 512) * MiB,
    maxMessageBytes: n(env.MAX_MESSAGE_MB, 16) * MiB,
  }
}

const enc = new TextEncoder()

async function sha256(data: Uint8Array | string): Promise<Uint8Array> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

/** Constant-time comparison (hashes first so lengths do not leak). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
  return crypto.subtle.timingSafeEqual(ha, hb)
}

/** Copies a byte range into its own ArrayBuffer (what SQL bindings take). */
const ab = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Relay-Key, X-Blob-Alias',
  'access-control-expose-headers': 'X-Content-SHA256, ETag, Content-Length',
  'access-control-max-age': '86400',
  'x-content-type-options': 'nosniff',
}

function reply(status: number, body: string | object = '', headers: Record<string, string> = {}): Response {
  const isJson = typeof body !== 'string'
  return new Response(isJson ? JSON.stringify(body) : body, {
    status,
    headers: {
      ...CORS,
      'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function withCors(res: Response): Response {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v)
  return out
}

function bearer(req: Request): string {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+([A-Za-z0-9_-]{22,128})$/)
  return m ? m[1] : ''
}

// ---------------------------------------------------------------------------
// Board room

interface Attachment {
  room: string
  authed: boolean
}

interface RoomState {
  tokenHash: Uint8Array | null
  head: number
  logBytes: number
  snapSeq: number
  snapBytes: number
  prevSnapBytes: number
}

export type AuthResult = 'ok' | 'unauthorized' | 'missing'

export class RelayRoom extends DurableObject<Env> {
  private sql: SqlStorage
  private cache: RoomState | null = null
  private parts = new Map<WebSocket, Reassembler>()
  /** When each socket's last PART arrived. */
  private partsAt = new Map<WebSocket, number>()
  /**
   * Pending while any multi-part message is incomplete. A pending timer keeps the object in memory
   * (no hibernation or eviction), so partial messages held in `parts` are never lost between parts.
   */
  private partsTimer: ReturnType<typeof setTimeout> | null = null
  private buckets = new Map<WebSocket, { tokens: number; last: number }>()
  private transferSeq = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      create table if not exists room (
        id integer primary key check (id = 1),
        room_id text not null,
        token_hash blob not null,
        snap_seq integer not null default 0,
        snap_bytes integer not null default 0,
        prev_snap_seq integer not null default 0,
        prev_snap_bytes integer not null default 0,
        created_at integer not null
      );
      create table if not exists log (
        seq integer not null,
        part integer not null,
        data blob not null,
        primary key (seq, part)
      ) without rowid;
      create table if not exists snaps (
        gen integer not null,
        part integer not null,
        data blob not null,
        primary key (gen, part)
      ) without rowid;
    `)
    // Keepalive without waking the object from hibernation.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  /** Room bookkeeping, derived from storage once per wake-up (keeps rows written to one per update). */
  private state(): RoomState {
    if (this.cache) return this.cache
    const room = this.sql
      .exec<{ token_hash: ArrayBuffer; snap_seq: number; snap_bytes: number; prev_snap_bytes: number }>(
        'select token_hash, snap_seq, snap_bytes, prev_snap_bytes from room where id = 1',
      )
      .toArray()[0]
    const agg = this.sql.exec<{ head: number | null; bytes: number | null }>('select max(seq) as head, sum(length(data)) as bytes from log').one()
    const snapSeq = room?.snap_seq ?? 0
    this.cache = {
      tokenHash: room ? new Uint8Array(room.token_hash) : null,
      head: Math.max(agg.head ?? 0, snapSeq),
      logBytes: agg.bytes ?? 0,
      snapSeq,
      snapBytes: room?.snap_bytes ?? 0,
      prevSnapBytes: room?.prev_snap_bytes ?? 0,
    }
    return this.cache
  }

  /** Token check with trust on first use. Also called by the Worker for file requests (RPC). */
  async authorize(roomId: string, token: string, create: boolean): Promise<AuthResult> {
    if (!ROOM_ID_RE.test(roomId) || typeof token !== 'string' || token.length < 22 || token.length > 128) return 'unauthorized'
    const th = await sha256(token)
    // No awaits below: check-and-claim is atomic.
    const s = this.state()
    if (!s.tokenHash) {
      if (!create) return 'missing'
      this.sql.exec('insert into room (id, room_id, token_hash, created_at) values (1, ?, ?, ?)', roomId, ab(th), Date.now())
      s.tokenHash = th
      return 'ok'
    }
    return s.tokenHash.length === th.length && crypto.subtle.timingSafeEqual(s.tokenHash, th) ? 'ok' : 'unauthorized'
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const m = url.pathname.match(/\/ws\/([A-Za-z0-9_-]{16,64})\/?$/)
    if (!m || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reply(426, 'expected a websocket')
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) return reply(503, 'too many connections to this board')
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ room: m[1], authed: false } satisfies Attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Text frames: only "ping", which the runtime answers itself.
    if (typeof message === 'string') return
    if (!this.allow(ws)) return this.closeWs(ws, CLOSE.RATE_LIMITED, 'rate limited')
    try {
      let frame: Uint8Array | null = new Uint8Array(message)
      const att = ws.deserializeAttachment() as Attachment
      // Nothing is buffered for a socket that has not authenticated.
      if (!att.authed && (frame[0] !== MSG.HELLO || frame.length > MAX_HELLO_BYTES)) throw new ProtocolError('expected hello')
      if (frame[0] === MSG.PART) {
        const lim = limits(this.env)
        let r = this.parts.get(ws)
        if (!r) {
          r = new Reassembler(lim.maxMessageBytes)
          this.parts.set(ws, r)
        }
        frame = r.push(frame)
        this.partsAt.set(ws, Date.now())
        if (this.bufferedBytes() > Math.max(2 * lim.maxMessageBytes, 32 * MiB)) {
          // Durable Objects have 128 MB of memory: never let concurrent uploads exhaust it.
          this.forget(ws)
          return this.closeWs(ws, CLOSE.RATE_LIMITED, 'too much data in flight')
        }
        this.holdForParts()
        if (!frame) return
      }
      await this.handle(ws, att, frame)
    } catch (e) {
      if (e instanceof TooLargeError) {
        this.forget(ws)
        this.closeWs(ws, CLOSE.TOO_LARGE, e.message)
      } else if (e instanceof ProtocolError) {
        this.forget(ws)
        this.closeWs(ws, CLOSE.BAD_REQUEST, e.message)
      } else {
        console.error('relay error', e)
        this.send(ws, encodeErr(ERR.INTERNAL, 0, 'internal error'))
        this.closeWs(ws, CLOSE.INTERNAL, 'internal error')
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    this.forget(ws)
    this.closeWs(ws, code === 1005 || code === 1006 ? CLOSE.NORMAL : code, reason)
    this.broadcastPeers(undefined, ws)
  }

  async webSocketError(ws: WebSocket) {
    this.forget(ws)
    this.broadcastPeers(undefined, ws)
  }

  private forget(ws: WebSocket) {
    this.parts.delete(ws)
    this.partsAt.delete(ws)
    this.buckets.delete(ws)
    this.holdForParts()
  }

  private bufferedBytes(): number {
    let n = 0
    for (const r of this.parts.values()) n += r.buffered
    return n
  }

  /** Keeps a timer pending exactly while some multi-part message is incomplete. */
  private holdForParts() {
    if (this.partsTimer) clearTimeout(this.partsTimer)
    this.partsTimer = null
    let oldest = Infinity
    for (const [ws, r] of this.parts) if (r.buffered > 0) oldest = Math.min(oldest, this.partsAt.get(ws) ?? 0)
    if (oldest === Infinity) return
    this.partsTimer = setTimeout(() => this.expireParts(), Math.max(0, oldest + PART_IDLE_MS - Date.now()) + 50)
  }

  /** Drops transfers whose sender went quiet (a stalled or vanished client). */
  private expireParts() {
    this.partsTimer = null
    const now = Date.now()
    for (const [ws, r] of [...this.parts]) {
      if (r.buffered > 0 && now - (this.partsAt.get(ws) ?? 0) >= PART_IDLE_MS) {
        this.parts.delete(ws)
        this.partsAt.delete(ws)
        this.closeWs(ws, CLOSE.HELLO_TIMEOUT, 'transfer timed out')
      }
    }
    this.holdForParts()
  }

  private allow(ws: WebSocket): boolean {
    const now = Date.now()
    let b = this.buckets.get(ws)
    if (!b) {
      b = { tokens: MSG_BURST, last: now }
      this.buckets.set(ws, b)
    }
    b.tokens = Math.min(MSG_BURST, b.tokens + ((now - b.last) / 1000) * MSG_RATE)
    b.last = now
    if (b.tokens < 1) return false
    b.tokens--
    return true
  }

  private closeWs(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason.slice(0, 120))
    } catch {
      // already closed
    }
  }

  private send(ws: WebSocket, frame: Uint8Array) {
    try {
      for (const f of splitFrame(frame, ++this.transferSeq)) ws.send(f)
    } catch {
      // socket went away
    }
  }

  private authedSockets(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => {
      if (w === except || w.readyState !== 1) return false
      const att = w.deserializeAttachment() as Attachment | null
      return !!att?.authed
    })
  }

  private broadcast(frame: Uint8Array, except?: WebSocket) {
    for (const w of this.authedSockets(except)) this.send(w, frame)
  }

  /** Tells everyone (but `skip`) how many others are connected; `gone` is a socket that is closing. */
  private broadcastPeers(skip?: WebSocket, gone?: WebSocket) {
    const socks = this.authedSockets(gone)
    const frame = encodePeers(Math.max(0, socks.length - 1))
    for (const w of socks) if (w !== skip) this.send(w, frame)
  }

  private async handle(ws: WebSocket, att: Attachment, frame: Uint8Array) {
    const d = new Decoder(frame)
    const type = d.u8()
    if (!att.authed) {
      if (type !== MSG.HELLO) throw new ProtocolError('expected hello')
      return this.hello(ws, att, d)
    }
    const lim = limits(this.env)
    switch (type) {
      case MSG.PUSH: {
        const id = d.varUint()
        const data = d.bytes(lim.maxMessageBytes)
        if (!data.length) throw new ProtocolError('empty update')
        const s = this.state()
        if (s.logBytes + s.snapBytes + s.prevSnapBytes + data.length > lim.maxRoomBytes) {
          return this.send(ws, encodeErr(ERR.QUOTA, id, 'This board is over its storage quota on the relay.'))
        }
        const seq = s.head + 1
        this.ctx.storage.transactionSync(() => this.writeParts('log', seq, data))
        s.head = seq
        s.logBytes += data.length
        this.send(ws, encodeAck(id, seq))
        this.broadcast(encodeUpd(seq, data), ws)
        return
      }
      case MSG.EPH: {
        const data = d.bytes(MAX_EPHEMERAL)
        this.broadcast(encodeEph(data), ws)
        return
      }
      case MSG.COMPACT: {
        const upto = d.varUint()
        const snapshot = d.bytes(lim.maxMessageBytes)
        const s = this.state()
        if (upto <= s.snapSeq || upto > s.head || !snapshot.length) return this.send(ws, encodeCompacted(s.snapSeq, s.logBytes))
        this.ctx.storage.transactionSync(() => {
          // Keep the previous snapshot generation as a fallback.
          this.sql.exec('delete from snaps where gen = 1')
          this.sql.exec('update snaps set gen = 1 where gen = 0')
          this.writeParts('snaps', 0, snapshot)
          this.sql.exec('delete from log where seq <= ?', upto)
          this.sql.exec(
            'update room set prev_snap_seq = snap_seq, prev_snap_bytes = snap_bytes, snap_seq = ?, snap_bytes = ? where id = 1',
            upto,
            snapshot.length,
          )
        })
        const agg = this.sql.exec<{ bytes: number | null }>('select sum(length(data)) as bytes from log').one()
        s.prevSnapBytes = s.snapBytes
        s.snapSeq = upto
        s.snapBytes = snapshot.length
        s.logBytes = agg.bytes ?? 0
        this.broadcast(encodeCompacted(s.snapSeq, s.logBytes))
        return
      }
      case MSG.HELLO:
        throw new ProtocolError('duplicate hello')
      default:
        throw new ProtocolError('unknown frame type')
    }
  }

  private async hello(ws: WebSocket, att: Attachment, d: Decoder) {
    const version = d.varUint()
    if (version !== PROTOCOL_VERSION) {
      this.send(ws, encodeErr(ERR.VERSION, 0, `This relay speaks protocol ${PROTOCOL_VERSION}.`))
      return this.closeWs(ws, CLOSE.VERSION, 'protocol version mismatch')
    }
    const flags = d.varUint()
    const roomId = d.string(64)
    const token = d.string(128)
    const accessKey = d.string(512)
    const since = d.varUint()
    if (!ROOM_ID_RE.test(roomId) || roomId !== att.room) throw new ProtocolError('bad room id')
    if (this.env.ACCESS_KEY && !(await safeEqual(accessKey, this.env.ACCESS_KEY))) {
      this.send(ws, encodeErr(ERR.FORBIDDEN, 0, 'This relay requires an access key.'))
      return this.closeWs(ws, CLOSE.FORBIDDEN, 'access key required')
    }
    const maxMessage = limits(this.env).maxMessageBytes
    if (flags & HELLO_PROBE) {
      this.send(ws, encodeWelcome({ snapSeq: 0, head: 0, logBytes: 0, peers: 0, snapshot: null, updates: [], maxMessage }))
      return this.closeWs(ws, CLOSE.NORMAL, 'probe ok')
    }
    const auth = await this.authorize(roomId, token, true)
    if (auth !== 'ok') {
      this.send(ws, encodeErr(ERR.UNAUTHORIZED, 0, 'Wrong board key for this relay room.'))
      return this.closeWs(ws, CLOSE.UNAUTHORIZED, 'unauthorized')
    }
    att.authed = true
    ws.serializeAttachment(att)
    const s = this.state()
    const from = since > s.head ? 0 : since
    const snapshot = s.snapSeq > 0 && from < s.snapSeq ? this.readParts('select data from snaps where gen = 0 order by part') : null
    const updates = this.readLog(Math.max(from, s.snapSeq))
    const peers = this.authedSockets(ws).length
    this.send(ws, encodeWelcome({ snapSeq: s.snapSeq, head: s.head, logBytes: s.logBytes, peers, snapshot, updates, maxMessage }))
    this.broadcastPeers(ws)
  }

  private writeParts(table: 'log' | 'snaps', key: number, data: Uint8Array) {
    const sql = table === 'log' ? 'insert into log (seq, part, data) values (?, ?, ?)' : 'insert into snaps (gen, part, data) values (?, ?, ?)'
    for (let off = 0, part = 0; off < data.length; off += ROW_CHUNK, part++) {
      this.sql.exec(sql, key, part, ab(data.subarray(off, off + ROW_CHUNK)))
    }
  }

  private readParts(query: string, ...bindings: SqlStorageValue[]): Uint8Array | null {
    const rows = this.sql.exec<{ data: ArrayBuffer }>(query, ...bindings).toArray()
    if (!rows.length) return null
    return concat(rows.map((r) => new Uint8Array(r.data)))
  }

  private readLog(after: number): { seq: number; data: Uint8Array }[] {
    const out: { seq: number; data: Uint8Array }[] = []
    let cur: { seq: number; parts: Uint8Array[] } | null = null
    for (const row of this.sql.exec<{ seq: number; data: ArrayBuffer }>('select seq, data from log where seq > ? order by seq, part', after)) {
      if (!cur || cur.seq !== row.seq) {
        if (cur) out.push({ seq: cur.seq, data: concat(cur.parts) })
        cur = { seq: row.seq, parts: [] }
      }
      cur.parts.push(new Uint8Array(row.data))
    }
    if (cur) out.push({ seq: cur.seq, data: concat(cur.parts) })
    return out
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

// ---------------------------------------------------------------------------
// Encrypted files of one board room (only reachable through the Worker, after authorization)

export class BlobStore extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(`
      create table if not exists blobs (
        hash text primary key,
        alias text unique,
        size integer not null,
        created_at integer not null
      );
      create table if not exists chunks (
        hash text not null,
        part integer not null,
        data blob not null,
        primary key (hash, part)
      ) without rowid;
    `)
  }

  private find(key: string): { hash: string; size: number } | null {
    return this.sql.exec<{ hash: string; size: number }>('select hash, size from blobs where hash = ? or alias = ? limit 1', key, key).toArray()[0] ?? null
  }

  async fetch(request: Request): Promise<Response> {
    const m = new URL(request.url).pathname.match(/\/blob\/[A-Za-z0-9_-]{16,64}\/([0-9a-f]{64})$/)
    if (!m) return reply(404, 'not found')
    const key = m[1]
    if (request.method === 'GET' || request.method === 'HEAD') return this.get(request, key)
    if (request.method === 'PUT') return this.put(request, key)
    return reply(405, 'method not allowed')
  }

  private get(request: Request, key: string): Response {
    const b = this.find(key)
    if (!b) return reply(404, 'not found')
    const headers = {
      ...CORS,
      'content-type': 'application/octet-stream',
      'content-length': String(b.size),
      'cache-control': 'private, max-age=31536000, immutable',
      etag: `"${b.hash}"`,
      'x-content-sha256': b.hash,
    }
    if (request.headers.get('if-none-match') === `"${b.hash}"`) return new Response(null, { status: 304, headers })
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    // Stream chunk by chunk so large files never sit in memory twice.
    const sql = this.sql
    let part = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const row = sql.exec<{ data: ArrayBuffer }>('select data from chunks where hash = ? and part = ?', b.hash, part++).toArray()[0]
        if (row) controller.enqueue(new Uint8Array(row.data))
        else controller.close()
      },
    })
    return new Response(body, { status: 200, headers })
  }

  private async put(request: Request, hash: string): Promise<Response> {
    const lim = limits(this.env)
    const aliasHeader = request.headers.get('x-blob-alias')
    const alias = aliasHeader ? aliasHeader : null
    if (alias !== null && !HASH_RE.test(alias)) return reply(400, 'bad alias')
    if (this.find(hash) || (alias && this.find(alias))) return reply(200, { ok: true, hash, existed: true })
    const declared = Number(request.headers.get('content-length') ?? NaN)
    if (Number.isFinite(declared) && declared > lim.maxBlobBytes) return reply(413, `file larger than ${lim.maxBlobBytes / MiB} MB`)
    const data = new Uint8Array(await request.arrayBuffer())
    if (data.length > lim.maxBlobBytes) return reply(413, `file larger than ${lim.maxBlobBytes / MiB} MB`)
    if (hex(await sha256(data)) !== hash) return reply(400, 'hash mismatch')
    const used = this.sql.exec<{ n: number | null }>('select sum(size) as n from blobs').one().n ?? 0
    if (used + data.length > lim.maxRoomBytes) return reply(507, 'board storage quota exceeded')
    // Re-check after the awaits above: another upload of the same file may have finished.
    if (this.find(hash) || (alias && this.find(alias))) return reply(200, { ok: true, hash, existed: true })
    this.ctx.storage.transactionSync(() => {
      for (let off = 0, part = 0; off < data.length; off += ROW_CHUNK, part++) {
        this.sql.exec('insert into chunks (hash, part, data) values (?, ?, ?)', hash, part, ab(data.subarray(off, off + ROW_CHUNK)))
      }
      this.sql.exec('insert into blobs (hash, alias, size, created_at) values (?, ?, ?, ?)', hash, alias, data.length, Date.now())
    })
    return reply(201, { ok: true, hash, existed: false })
  }
}

// ---------------------------------------------------------------------------
// Worker entry: routing, access key, CORS

async function handleBlob(request: Request, env: Env, roomId: string): Promise<Response> {
  if (!['GET', 'HEAD', 'PUT'].includes(request.method)) return reply(405, 'method not allowed', { allow: 'GET, HEAD, PUT, OPTIONS' })
  if (env.ACCESS_KEY && !(await safeEqual(request.headers.get('x-relay-key') ?? '', env.ACCESS_KEY))) {
    return reply(403, 'access key required')
  }
  const token = bearer(request)
  if (!token) return reply(401, 'missing token')
  const room = env.ROOMS.get(env.ROOMS.idFromName(roomId))
  const auth = await room.authorize(roomId, token, request.method === 'PUT')
  if (auth === 'missing') return reply(404, 'not found')
  if (auth !== 'ok') return reply(401, 'unauthorized')
  const lim = limits(env)
  const declared = Number(request.headers.get('content-length') ?? NaN)
  if (request.method === 'PUT' && Number.isFinite(declared) && declared > lim.maxBlobBytes) {
    return reply(413, `file larger than ${lim.maxBlobBytes / MiB} MB`)
  }
  const store = env.BLOBS.get(env.BLOBS.idFromName(roomId))
  return withCors(await store.fetch(request))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
      const path = new URL(request.url).pathname
      if (path.endsWith('/healthz')) {
        const lim = limits(env)
        return reply(200, {
          ok: true,
          service: 'noema-relay',
          version: VERSION,
          protocol: PROTOCOL_VERSION,
          runtime: 'cloudflare',
          accessKeyRequired: !!env.ACCESS_KEY,
          maxBlobMB: lim.maxBlobBytes / MiB,
          maxRoomMB: lim.maxRoomBytes / MiB,
          maxMessageMB: lim.maxMessageBytes / MiB,
          maxMessageBytes: lim.maxMessageBytes,
        })
      }
      const ws = path.match(/\/ws\/([A-Za-z0-9_-]{16,64})\/?$/)
      if (ws) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return reply(426, 'expected a websocket')
        return env.ROOMS.get(env.ROOMS.idFromName(ws[1])).fetch(request)
      }
      const blob = path.match(/\/blob\/([A-Za-z0-9_-]{16,64})\/([0-9a-f]{64})$/)
      if (blob) return await handleBlob(request, env, blob[1])
      if (path === '/' || path.endsWith('/')) {
        return reply(200, 'Noema relay is running. Add this address to a board in the Share dialog (Advanced).\n')
      }
      return reply(404, 'not found')
    } catch (e) {
      console.error('worker error', e)
      return reply(500, 'internal error')
    }
  },
} satisfies ExportedHandler<Env>
