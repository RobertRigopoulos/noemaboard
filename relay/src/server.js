// @ts-check
/**
 * Noema "blind" relay server.
 *
 * Stores and forwards end-to-end encrypted board data for teams that want boards to stay available
 * while nobody else is online, or whose networks block peer-to-peer connections. Everything it
 * stores is ciphertext keyed by ids derived from board secrets it never sees.
 *
 *   WS   /ws/<roomId>             binary protocol, see protocol.js
 *   PUT  /blob/<roomId>/<sha256>  encrypted blob (Authorization: Bearer <writeToken>)
 *   GET  /blob/<roomId>/<sha256 or alias>
 *   GET  /healthz
 *
 * Paths may carry a prefix (e.g. /relay/ws/<roomId>) so the server can sit behind a reverse proxy.
 */
import fs from 'node:fs'
import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { WebSocketServer } from 'ws'
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
} from './protocol.js'
import { QuotaError, RelayStore } from './store.js'
import { IpLimiter, forwardedClient, ipKey } from './limits.js'

const MiB = 1024 * 1024
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export const VERSION = /** @type {string} */ (pkg.version)

/**
 * @typedef {object} RelayOptions
 * @property {number} [port] TCP port (default 8787; 0 = random free port)
 * @property {string} [host] Interface to bind (default: all interfaces)
 * @property {string} [dataDir] Where the database and blobs live (default ./data)
 * @property {string} [accessKey] Optional relay-wide key every client must present
 * @property {number} [maxBlobMB] Largest single file (default 50)
 * @property {number} [maxRoomMB] Storage quota per board, updates + snapshots + files (default 1024)
 * @property {number} [maxMessageMB] Largest logical WebSocket message, e.g. a snapshot (default 32)
 * @property {number} [maxRooms] Maximum number of boards, 0 = unlimited (default 0)
 * @property {number} [maxConnectionsPerIp] Concurrent WebSockets per client IP / IPv6 /64 (default 4096).
 *   An office behind one NAT address shares it, and each person keeps several boards connected.
 * @property {number} [messagesPerSecond] WebSocket messages per second per IP (default 2000, burst 4x)
 * @property {number} [httpPerSecond] HTTP requests (incl. WebSocket handshakes) per second per IP (default 200, burst 4x)
 * @property {boolean | number} [trustProxy] Number of trusted reverse proxies in front of the relay
 *   (true = 1): the client IP is taken from that many entries from the right of X-Forwarded-For.
 * @property {number} [helloTimeoutMs] Time a socket may stay unauthenticated (default 10000)
 * @property {number} [pingIntervalMs] Keepalive ping interval (default 30000)
 * @property {((msg: string) => void) | false} [log] Logger (default console.log with timestamp)
 */

/**
 * @typedef {object} Client
 * @property {import('ws').WebSocket} ws
 * @property {string} ip
 * @property {string | null} pathRoom
 * @property {string | null} room
 * @property {boolean} alive
 * @property {number} transferSeq
 * @property {Reassembler} parts
 * @property {number} buffered bytes of incomplete multi-part messages held for this client
 * @property {ReturnType<typeof setTimeout> | null} helloTimer
 * @property {ReturnType<typeof setTimeout> | null} killTimer
 * @property {() => void} release frees the client's per-IP connection slot (idempotent)
 */

/** @param {RelayOptions} [options] */
export function resolveOptions(options = {}) {
  const pos = (/** @type {unknown} */ v, /** @type {number} */ d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d)
  return {
    port: pos(options.port, 8787),
    host: options.host || undefined,
    dataDir: options.dataDir || './data',
    accessKey: options.accessKey || '',
    maxBlobBytes: Math.max(1, pos(options.maxBlobMB, 50)) * MiB,
    maxRoomBytes: Math.max(1, pos(options.maxRoomMB, 1024)) * MiB,
    maxMessageBytes: Math.max(1, pos(options.maxMessageMB, 32)) * MiB,
    maxRooms: pos(options.maxRooms, 0),
    maxConnectionsPerIp: pos(options.maxConnectionsPerIp, 4096),
    messagesPerSecond: pos(options.messagesPerSecond, 2000),
    httpPerSecond: pos(options.httpPerSecond, 200),
    trustProxy: options.trustProxy === true ? 1 : Math.floor(pos(options.trustProxy, 0)),
    helloTimeoutMs: pos(options.helloTimeoutMs, 10_000),
    pingIntervalMs: pos(options.pingIntervalMs, 30_000),
    log:
      options.log === false
        ? () => {}
        : (options.log ?? ((/** @type {string} */ m) => console.log(`${new Date().toISOString()} ${m}`))),
  }
}

/** Constant-time string comparison (hashes first so lengths do not leak). */
function safeEqual(/** @type {string} */ a, /** @type {string} */ b) {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, PUT, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Relay-Key, X-Blob-Alias',
  'access-control-expose-headers': 'X-Content-SHA256, ETag, Content-Length',
  'access-control-max-age': '86400',
  // Lets pages on public origins reach a relay on the local network (Chrome Private Network Access).
  'access-control-allow-private-network': 'true',
  'x-content-type-options': 'nosniff',
}

const MAX_EPHEMERAL = 64 * 1024
/** A client this far behind on reading is dropped instead of buffering without bound. */
const MAX_BUFFERED = 64 * MiB
/** HELLO is small (ids, token, access key) and never split; anything bigger before it is abuse. */
const MAX_HELLO_BYTES = 4096
/** A socket we closed that does not finish the close handshake is cut off after this long. */
const CLOSE_GRACE_MS = 5000

/** @param {RelayOptions} [options] */
export function createRelayServer(options = {}) {
  const opts = resolveOptions(options)
  const log = opts.log
  const store = new RelayStore({ dataDir: opts.dataDir, maxRoomBytes: opts.maxRoomBytes, maxRooms: opts.maxRooms })
  const limiter = new IpLimiter({
    maxConnections: opts.maxConnectionsPerIp,
    messagesPerSecond: opts.messagesPerSecond,
    messageBurst: opts.messagesPerSecond * 4,
    bytesPerSecond: 16 * MiB,
    byteBurst: Math.max(64 * MiB, opts.maxMessageBytes * 2),
    httpPerSecond: opts.httpPerSecond,
    httpBurst: opts.httpPerSecond * 4,
  })
  /** @type {Map<string, Set<Client>>} */
  const rooms = new Map()
  /** @type {Set<Client>} */
  const clients = new Set()
  let closing = false
  // Memory held by incomplete multi-part messages, bounded per IP and for the whole relay.
  const maxBufferedPerIp = Math.max(64 * MiB, 2 * opts.maxMessageBytes)
  const maxBufferedTotal = Math.max(256 * MiB, 4 * opts.maxMessageBytes)
  /** @type {Map<string, number>} */
  const bufferedByIp = new Map()
  let bufferedTotal = 0

  const server = http.createServer((req, res) => {
    handleHttp(req, res).catch((e) => {
      log(`http error: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) send(res, 500, 'internal error')
      else res.destroy()
    })
  })
  server.headersTimeout = 30_000
  server.requestTimeout = 10 * 60_000

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * MiB, perMessageDeflate: false, clientTracking: false })

  // -------------------------------------------------------------------------
  // HTTP

  /** Rate-limit key of the client (IPv4 address or IPv6 /64). @param {http.IncomingMessage} req */
  function clientIp(req) {
    const forwarded = opts.trustProxy ? forwardedClient(req.headers['x-forwarded-for'], opts.trustProxy) : null
    return ipKey(forwarded ?? req.socket.remoteAddress)
  }

  /** @param {http.ServerResponse} res @param {number} status @param {string | object} body */
  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string'
    const text = isJson ? JSON.stringify(body) : body
    res.writeHead(status, {
      ...CORS,
      'content-type': isJson ? 'application/json' : 'text/plain; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'cache-control': 'no-store',
      ...headers,
    })
    res.end(text)
  }

  /** @param {http.IncomingMessage} req */
  function accessOk(req) {
    if (!opts.accessKey) return true
    const k = req.headers['x-relay-key']
    return typeof k === 'string' && safeEqual(k, opts.accessKey)
  }

  /** @param {http.IncomingMessage} req */
  function bearer(req) {
    const h = req.headers.authorization
    const m = typeof h === 'string' ? h.match(/^Bearer\s+([A-Za-z0-9_-]{22,128})$/) : null
    return m ? m[1] : ''
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleHttp(req, res) {
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const p = url.pathname
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return
    }
    if (!limiter.http(clientIp(req))) return send(res, 429, 'too many requests', { 'retry-after': '1' })

    if (p.endsWith('/healthz')) {
      return send(res, 200, {
        ok: true,
        service: 'noema-relay',
        version: VERSION,
        protocol: PROTOCOL_VERSION,
        accessKeyRequired: !!opts.accessKey,
        maxBlobMB: opts.maxBlobBytes / MiB,
        maxRoomMB: opts.maxRoomBytes / MiB,
        maxMessageMB: opts.maxMessageBytes / MiB,
        maxMessageBytes: opts.maxMessageBytes,
      })
    }
    const m = p.match(/\/blob\/([A-Za-z0-9_-]{16,64})\/([0-9a-f]{64})$/)
    if (m) return handleBlob(req, res, m[1], m[2])
    if (p === '/' || p.endsWith('/')) {
      return send(res, 200, 'Noema relay is running. Add this address to a board in the Share dialog (Advanced).\n')
    }
    return send(res, 404, 'not found')
  }

  /**
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   * @param {string} roomId @param {string} key
   */
  async function handleBlob(req, res, roomId, key) {
    if (!accessOk(req)) return send(res, 403, 'access key required')
    const token = bearer(req)
    if (!token) return send(res, 401, 'missing token')

    if (req.method === 'GET' || req.method === 'HEAD') {
      const auth = store.authorize(roomId, token, false)
      if (auth === 'missing') return send(res, 404, 'not found')
      if (auth !== 'ok') return send(res, 401, 'unauthorized')
      const b = store.findBlob(roomId, key)
      if (!b) return send(res, 404, 'not found')
      const headers = {
        ...CORS,
        'content-type': 'application/octet-stream',
        'content-length': String(b.size),
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${b.hash}"`,
        'x-content-sha256': b.hash,
      }
      if (req.headers['if-none-match'] === `"${b.hash}"`) {
        res.writeHead(304, headers)
        res.end()
        return
      }
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      await pipeline(fs.createReadStream(b.path), res).catch(() => res.destroy())
      return
    }

    if (req.method !== 'PUT') return send(res, 405, 'method not allowed', { allow: 'GET, HEAD, PUT, OPTIONS' })
    const hash = key
    const aliasHeader = req.headers['x-blob-alias']
    const alias = typeof aliasHeader === 'string' && aliasHeader ? aliasHeader : null
    if (alias !== null && !HASH_RE.test(alias)) return send(res, 400, 'bad alias')
    const declared = Number(req.headers['content-length'] ?? NaN)
    if (Number.isFinite(declared) && declared > opts.maxBlobBytes) {
      res.setHeader('connection', 'close')
      return send(res, 413, `file larger than ${opts.maxBlobBytes / MiB} MB`)
    }
    const auth = store.authorize(roomId, token, true)
    if (auth === 'room_limit') return send(res, 503, 'this relay has reached its board limit')
    if (auth !== 'ok') return send(res, 401, 'unauthorized')
    if (store.findBlob(roomId, hash) || (alias && store.findBlob(roomId, alias))) {
      // Already stored: drain the body so the client sees a clean response.
      req.resume()
      await new Promise((r) => req.once('end', r).once('error', r))
      return send(res, 200, { ok: true, hash, existed: true })
    }

    const limit = Math.min(opts.maxBlobBytes, store.freeBytes(roomId))
    const tmp = store.newTempPath()
    const hasher = createHash('sha256')
    let size = 0
    let tooLarge = false
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        if (size > limit) {
          tooLarge = true
          cb(new Error('too large'))
          return
        }
        hasher.update(chunk)
        cb(null, chunk)
      },
    })
    try {
      await pipeline(req, meter, fs.createWriteStream(tmp))
    } catch {
      fs.rmSync(tmp, { force: true })
      if (tooLarge) {
        res.setHeader('connection', 'close')
        return limit < opts.maxBlobBytes
          ? send(res, 507, 'board storage quota exceeded')
          : send(res, 413, `file larger than ${opts.maxBlobBytes / MiB} MB`)
      }
      if (!res.headersSent && !res.destroyed) send(res, 400, 'upload interrupted')
      return
    }
    if (hasher.digest('hex') !== hash) {
      fs.rmSync(tmp, { force: true })
      return send(res, 400, 'hash mismatch')
    }
    const result = store.commitBlob(roomId, hash, alias, size, tmp)
    if (result === 'quota') return send(res, 507, 'board storage quota exceeded')
    return send(res, result === 'created' ? 201 : 200, { ok: true, hash, existed: result === 'exists' })
  }

  // -------------------------------------------------------------------------
  // WebSocket

  server.on('upgrade', (req, socket, head) => {
    const reject = (/** @type {number} */ status, /** @type {string} */ text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    }
    socket.on('error', () => {})
    if (closing) return reject(503, 'Service Unavailable')
    if (socket.destroyed) return
    const url = new URL(req.url ?? '/', 'http://relay.invalid')
    const m = url.pathname.match(/\/ws(?:\/([A-Za-z0-9_-]{16,64}))?\/?$/)
    if (!m) return reject(404, 'Not Found')
    const ip = clientIp(req)
    // Handshakes are HTTP requests too: a flood of junk upgrades must cost the sender.
    if (!limiter.http(ip) || !limiter.connect(ip)) return reject(429, 'Too Many Requests')
    // Exactly one release per counted connection, however it ends: ws aborts invalid handshakes
    // (bad key/version, non-GET, client gone mid-handshake) without ever calling us back.
    let released = false
    const release = () => {
      if (released) return
      released = true
      limiter.disconnect(ip)
    }
    socket.once('close', release)
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ip, m[1] ?? null, release))
  })

  /**
   * @param {import('ws').WebSocket} ws @param {string} ip @param {string | null} pathRoom
   * @param {() => void} release
   */
  function onConnection(ws, ip, pathRoom, release) {
    /** @type {Client} */
    const c = {
      ws,
      ip,
      pathRoom,
      room: null,
      alive: true,
      transferSeq: 0,
      parts: new Reassembler(opts.maxMessageBytes),
      buffered: 0,
      helloTimer: null,
      killTimer: null,
      release,
    }
    clients.add(c)
    c.helloTimer = setTimeout(() => closeClient(c, CLOSE.HELLO_TIMEOUT, 'hello timeout'), opts.helloTimeoutMs)
    ws.on('pong', () => {
      c.alive = true
    })
    ws.on('message', (data, isBinary) => {
      c.alive = true
      try {
        onMessage(c, data, isBinary)
      } catch (e) {
        if (e instanceof TooLargeError) {
          closeClient(c, CLOSE.TOO_LARGE, e.message)
        } else if (e instanceof ProtocolError) {
          closeClient(c, CLOSE.BAD_REQUEST, e.message)
        } else {
          log(`internal error: ${e instanceof Error ? e.stack : String(e)}`)
          sendFrame(c, encodeErr(ERR.INTERNAL, 0, 'internal error'))
          closeClient(c, CLOSE.INTERNAL, 'internal error')
        }
      }
    })
    ws.on('error', () => {})
    ws.on('close', () => onClose(c))
  }

  /** @param {Client} c @param {number} delta */
  function addBuffered(c, delta) {
    if (!delta) return
    c.buffered += delta
    bufferedTotal += delta
    const n = (bufferedByIp.get(c.ip) ?? 0) + delta
    if (n > 0) bufferedByIp.set(c.ip, n)
    else bufferedByIp.delete(c.ip)
  }

  /** Frees the memory of the client's incomplete messages. @param {Client} c */
  function releaseParts(c) {
    c.parts.reset()
    addBuffered(c, -c.buffered)
  }

  /** @param {Client} c @param {number} code @param {string} reason */
  function closeClient(c, code, reason) {
    // Nothing from this socket is processed any more: free its buffers now, not when the close
    // handshake ends (which a hostile peer can stall), and cut it off if it never answers.
    releaseParts(c)
    if (!c.killTimer) {
      c.killTimer = setTimeout(() => c.ws.terminate(), CLOSE_GRACE_MS)
      c.killTimer.unref?.()
    }
    try {
      c.ws.close(code, reason.slice(0, 120))
    } catch {
      c.ws.terminate()
    }
  }

  /** @param {Client} c @param {Uint8Array} frame */
  function sendFrame(c, frame) {
    if (c.ws.readyState !== c.ws.OPEN) return
    if (c.ws.bufferedAmount > MAX_BUFFERED) {
      c.ws.terminate()
      return
    }
    for (const f of splitFrame(frame, ++c.transferSeq)) c.ws.send(f, { binary: true })
  }

  /** @param {Client} c @param {import('ws').RawData} raw @param {boolean} isBinary */
  function onMessage(c, raw, isBinary) {
    if (c.ws.readyState !== c.ws.OPEN) return
    const data = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    if (!isBinary) {
      // Application-level keepalive (browsers cannot send ping frames).
      if (data.length === 4 && data.toString() === 'ping') c.ws.send('pong')
      return
    }
    if (!limiter.message(c.ip, data.length)) {
      closeClient(c, CLOSE.RATE_LIMITED, 'rate limited')
      return
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length)
    const d = new Decoder(bytes)
    const type = d.u8()
    // Nothing is buffered for a socket that has not authenticated (HELLO is never split).
    if (!c.room && (type !== MSG.HELLO || bytes.length > MAX_HELLO_BYTES)) throw new ProtocolError('expected hello')
    if (type === MSG.PART) {
      const full = c.parts.push(d)
      addBuffered(c, c.parts.buffered - c.buffered)
      if (c.buffered && ((bufferedByIp.get(c.ip) ?? 0) > maxBufferedPerIp || bufferedTotal > maxBufferedTotal)) {
        closeClient(c, CLOSE.RATE_LIMITED, 'too much data in flight')
        return
      }
      if (full) handleFrame(c, full)
      return
    }
    handleFrame(c, bytes)
  }

  /** @param {Client} c @param {Uint8Array} frame */
  function handleFrame(c, frame) {
    const d = new Decoder(frame)
    const type = d.u8()
    if (!c.room) {
      if (type !== MSG.HELLO) throw new ProtocolError('expected hello')
      return onHello(c, d)
    }
    const roomId = c.room
    switch (type) {
      case MSG.PUSH: {
        const id = d.varUint()
        const data = d.bytes(opts.maxMessageBytes)
        if (data.length === 0) throw new ProtocolError('empty update')
        let seq
        try {
          seq = store.append(roomId, data)
        } catch (e) {
          if (e instanceof QuotaError) {
            sendFrame(c, encodeErr(ERR.QUOTA, id, 'This board is over its storage quota on the relay.'))
            return
          }
          throw e
        }
        sendFrame(c, encodeAck(id, seq))
        const upd = encodeUpd(seq, data)
        for (const o of rooms.get(roomId) ?? []) if (o !== c) sendFrame(o, upd)
        return
      }
      case MSG.EPH: {
        const data = d.bytes(MAX_EPHEMERAL)
        const eph = encodeEph(data)
        for (const o of rooms.get(roomId) ?? []) if (o !== c) sendFrame(o, eph)
        return
      }
      case MSG.COMPACT: {
        const upto = d.varUint()
        const snapshot = d.bytes(opts.maxMessageBytes)
        const r = store.compact(roomId, upto, snapshot)
        const msg = encodeCompacted(r.snapSeq, r.logBytes)
        if (r.ok) {
          for (const o of rooms.get(roomId) ?? []) sendFrame(o, msg)
        } else {
          sendFrame(c, msg)
        }
        return
      }
      case MSG.HELLO:
        throw new ProtocolError('duplicate hello')
      default:
        throw new ProtocolError('unknown frame type')
    }
  }

  /** @param {Client} c @param {Decoder} d */
  function onHello(c, d) {
    const version = d.varUint()
    if (version !== PROTOCOL_VERSION) {
      sendFrame(c, encodeErr(ERR.VERSION, 0, `This relay speaks protocol ${PROTOCOL_VERSION}.`))
      return closeClient(c, CLOSE.VERSION, 'protocol version mismatch')
    }
    const flags = d.varUint()
    const roomId = d.string(64)
    const token = d.string(128)
    const accessKey = d.string(512)
    const since = d.varUint()
    if (!ROOM_ID_RE.test(roomId) || (c.pathRoom && c.pathRoom !== roomId)) throw new ProtocolError('bad room id')
    if (opts.accessKey && !safeEqual(accessKey, opts.accessKey)) {
      sendFrame(c, encodeErr(ERR.FORBIDDEN, 0, 'This relay requires an access key.'))
      return closeClient(c, CLOSE.FORBIDDEN, 'access key required')
    }
    if (c.helloTimer) clearTimeout(c.helloTimer)
    c.helloTimer = null
    if (flags & HELLO_PROBE) {
      sendFrame(c, encodeWelcome({ snapSeq: 0, head: 0, logBytes: 0, peers: 0, snapshot: null, updates: [], maxMessage: opts.maxMessageBytes }))
      return closeClient(c, CLOSE.NORMAL, 'probe ok')
    }
    const auth = store.authorize(roomId, token, true)
    if (auth === 'room_limit') {
      sendFrame(c, encodeErr(ERR.ROOM_LIMIT, 0, 'This relay has reached its board limit.'))
      return closeClient(c, CLOSE.SERVER_FULL, 'board limit reached')
    }
    if (auth !== 'ok') {
      sendFrame(c, encodeErr(ERR.UNAUTHORIZED, 0, 'Wrong board key for this relay room.'))
      return closeClient(c, CLOSE.UNAUTHORIZED, 'unauthorized')
    }
    store.touch(roomId)
    c.room = roomId
    let set = rooms.get(roomId)
    if (!set) {
      set = new Set()
      rooms.set(roomId, set)
    }
    set.add(c)
    const w = store.welcome(roomId, since)
    sendFrame(c, encodeWelcome({ ...w, peers: set.size - 1, maxMessage: opts.maxMessageBytes }))
    broadcastPeers(roomId, c)
  }

  /** @param {string} roomId @param {Client} [except] */
  function broadcastPeers(roomId, except) {
    const set = rooms.get(roomId)
    if (!set) return
    const frame = encodePeers(set.size - 1)
    for (const o of set) if (o !== except) sendFrame(o, frame)
  }

  /** @param {Client} c */
  function onClose(c) {
    if (!clients.delete(c)) return
    if (c.helloTimer) clearTimeout(c.helloTimer)
    if (c.killTimer) clearTimeout(c.killTimer)
    c.helloTimer = c.killTimer = null
    releaseParts(c)
    c.release()
    if (!c.room) return
    const set = rooms.get(c.room)
    if (!set) return
    set.delete(c)
    if (set.size === 0) rooms.delete(c.room)
    else broadcastPeers(c.room)
  }

  const keepalive = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate()
        continue
      }
      c.alive = false
      try {
        c.ws.ping()
      } catch {
        // socket already closing
      }
    }
    limiter.sweep()
  }, opts.pingIntervalMs)
  keepalive.unref()

  // -------------------------------------------------------------------------
  // Lifecycle

  /** @returns {Promise<{ port: number, host: string }>} */
  function listen(port = opts.port, host = opts.host) {
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        const a = server.address()
        const info = typeof a === 'object' && a ? { port: a.port, host: a.address } : { port, host: host ?? '' }
        log(`Noema relay ${VERSION} listening on port ${info.port} (data: ${store.dataDir}${opts.accessKey ? ', access key required' : ''})`)
        resolve(info)
      })
    })
  }

  /** Stops accepting connections, closes sockets politely and flushes the database. */
  async function close(/** @type {number} */ graceMs = 3000) {
    if (closing) return
    closing = true
    clearInterval(keepalive)
    const done = new Promise((r) => server.close(() => r(undefined)))
    for (const c of clients) {
      try {
        c.ws.close(CLOSE.GOING_AWAY, 'server shutting down')
      } catch {
        c.ws.terminate()
      }
    }
    const deadline = Date.now() + graceMs
    while (clients.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    for (const c of clients) c.ws.terminate()
    server.closeAllConnections?.()
    await done
    store.close()
    log('relay stopped')
  }

  return {
    server,
    store,
    listen,
    close,
    /** Live counts for monitoring. */
    stats: () => ({ connections: clients.size, rooms: rooms.size }),
  }
}
