// @ts-check
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import WebSocket from 'ws'
import { CLOSE, ERR, HELLO_PROBE, MSG, encodeCompact, encodeHello, encodePush, Encoder } from '../src/protocol.js'
import { createRelayServer } from '../src/server.js'
import { TestClient, bytes, randomRoom, randomToken, spawnRelay, tempDir } from './helpers.js'

const sha = (/** @type {Uint8Array} */ b) => createHash('sha256').update(b).digest('hex')

/**
 * Starts an upload that declares `size` bytes but sends only a first chunk, and resolves with the
 * status the relay answers before the rest arrives. Sending the whole body with fetch() would race
 * the relay closing the connection on a refused upload (EPIPE / ECONNRESET instead of the status).
 * @param {string} url @param {Record<string, string>} headers @param {number} size
 * @returns {Promise<number>}
 */
function statusOfDeclaredUpload(url, headers, size) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'PUT', headers: { ...headers, 'content-length': String(size) } }, (res) => {
      resolve(res.statusCode ?? 0)
      res.resume()
      req.destroy()
    })
    req.on('error', reject) // ignored once the status has arrived
    // A relay that waits for the rest instead of refusing would otherwise hang the test.
    req.setTimeout(5000, () => req.destroy(new Error('the relay did not answer before the upload finished')))
    req.write(Buffer.alloc(Math.min(size, 1024)))
  })
}

describe('relay (spawned CLI)', () => {
  /** @type {Awaited<ReturnType<typeof spawnRelay>>} */
  let relay
  before(async () => {
    relay = await spawnRelay({ MAX_BLOB_MB: '2' })
  })
  after(async () => {
    await relay?.stop()
  })

  test('healthz and CORS preflight', async () => {
    const res = await fetch(`${relay.http}/healthz`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const body = /** @type {any} */ (await res.json())
    assert.equal(body.ok, true)
    assert.equal(body.protocol, 1)
    assert.equal(body.accessKeyRequired, false)
    assert.equal(body.maxBlobMB, 2)
    const pre = await fetch(`${relay.http}/blob/x/y`, { method: 'OPTIONS' })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/)
  })

  test('two clients push and receive; late joiner restores snapshot + tail; compaction', async () => {
    const roomId = randomRoom()
    const token = randomToken()
    const a = await TestClient.join(relay.ws, { roomId, token })
    assert.equal(a.welcome.head, 0)
    assert.equal(a.welcome.snapshot, null)
    const b = await TestClient.join(relay.ws, { roomId, token })
    assert.equal(b.welcome.peers, 1)
    assert.equal((await a.client.next(MSG.PEERS)).peers, 1)

    a.client.send(encodePush(11, bytes(10, 1)))
    const ack1 = await a.client.next(MSG.ACK)
    assert.deepEqual([ack1.id, ack1.seq], [11, 1])
    const upd1 = await b.client.next(MSG.UPD)
    assert.equal(upd1.seq, 1)
    assert.deepEqual([...upd1.data], [...bytes(10, 1)])
    // The sender does not get its own update back.
    assert.equal(await a.client.receives(MSG.UPD, 200), false)

    b.client.send(encodePush(1, bytes(5, 2)))
    assert.equal((await b.client.next(MSG.ACK)).seq, 2)
    assert.equal((await a.client.next(MSG.UPD)).seq, 2)
    a.client.send(encodePush(12, bytes(5, 3)))
    assert.equal((await a.client.next(MSG.ACK)).seq, 3)
    await b.client.next(MSG.UPD)

    // Late joiner without snapshot gets the whole log.
    const c = await TestClient.join(relay.ws, { roomId, token, since: 0 })
    assert.deepEqual(c.welcome.updates.map((/** @type {any} */ u) => u.seq), [1, 2, 3])
    assert.equal(c.welcome.head, 3)
    assert.equal(c.welcome.logBytes, 20)

    // Compaction up to 2: everybody is told, log rows <= 2 are gone.
    a.client.send(encodeCompact(2, bytes(50, 9)))
    const comp = await a.client.next(MSG.COMPACTED)
    assert.equal(comp.snapSeq, 2)
    assert.equal(comp.logBytes, 5)
    assert.equal((await b.client.next(MSG.COMPACTED)).snapSeq, 2)
    // Stale compaction is refused and only the sender learns the current state.
    b.client.send(encodeCompact(1, bytes(50, 8)))
    assert.equal((await b.client.next(MSG.COMPACTED)).snapSeq, 2)
    assert.equal(await a.client.receives(MSG.COMPACTED, 200), false)
    // Beyond the head is refused too.
    b.client.send(encodeCompact(99, bytes(50, 8)))
    assert.equal((await b.client.next(MSG.COMPACTED)).snapSeq, 2)

    const d = await TestClient.join(relay.ws, { roomId, token, since: 0 })
    assert.equal(d.welcome.snapSeq, 2)
    assert.deepEqual([...d.welcome.snapshot], [...bytes(50, 9)])
    assert.deepEqual(d.welcome.updates.map((/** @type {any} */ u) => u.seq), [3])

    // A client that already has everything up to 2 gets no snapshot.
    const e = await TestClient.join(relay.ws, { roomId, token, since: 2 })
    assert.equal(e.welcome.snapshot, null)
    assert.deepEqual(e.welcome.updates.map((/** @type {any} */ u) => u.seq), [3])
    // A client behind the snapshot gets snapshot + tail.
    const f = await TestClient.join(relay.ws, { roomId, token, since: 1 })
    assert.notEqual(f.welcome.snapshot, null)
    // A client ahead of the head (room reset / different server) gets everything.
    const g = await TestClient.join(relay.ws, { roomId, token, since: 50 })
    assert.notEqual(g.welcome.snapshot, null)
    assert.equal(g.welcome.head, 3)

    for (const x of [a, b, c, d, e, f, g]) await x.client.close()
  })

  test('ephemeral messages are broadcast but never stored', async () => {
    const roomId = randomRoom()
    const token = randomToken()
    const a = await TestClient.join(relay.ws, { roomId, token })
    const b = await TestClient.join(relay.ws, { roomId, token })
    a.client.send(new Encoder().u8(MSG.EPH).bytes(bytes(30, 4)).done())
    const eph = await b.client.next(MSG.EPH)
    assert.equal(eph.data.length, 30)
    assert.equal(await a.client.receives(MSG.EPH, 200), false)
    const c = await TestClient.join(relay.ws, { roomId, token })
    assert.equal(c.welcome.head, 0)
    assert.equal(c.welcome.updates.length, 0)
    for (const x of [a, b, c]) await x.client.close()
  })

  test('large messages travel as PART frames both ways', async () => {
    const roomId = randomRoom()
    const token = randomToken()
    const a = await TestClient.join(relay.ws, { roomId, token })
    const b = await TestClient.join(relay.ws, { roomId, token })
    const big = randomBytes(1_600_000)
    a.client.send(encodePush(1, big))
    assert.equal((await a.client.next(MSG.ACK)).seq, 1)
    const upd = await b.client.next(MSG.UPD)
    assert.equal(sha(upd.data), sha(big))
    const c = await TestClient.join(relay.ws, { roomId, token })
    assert.equal(sha(c.welcome.updates[0].data), sha(big))
    for (const x of [a, b, c]) await x.client.close()
  })

  test('wrong token is rejected with 4401', async () => {
    const roomId = randomRoom()
    const a = await TestClient.join(relay.ws, { roomId, token: randomToken() })
    const bad = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
    bad.send(encodeHello({ roomId, token: randomToken() }))
    const err = await bad.next(MSG.ERR)
    assert.equal(err.code, ERR.UNAUTHORIZED)
    const closed = /** @type {{ code: number }} */ (await bad.closed)
    assert.equal(closed.code, CLOSE.UNAUTHORIZED)
    await a.client.close()
  })

  test('protocol errors close the socket', async () => {
    const roomId = randomRoom()
    const garbage = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
    garbage.ws.send(new Uint8Array([MSG.PUSH, 1, 2, 3]))
    assert.equal((/** @type {any} */ (await garbage.closed)).code, CLOSE.BAD_REQUEST)

    const version = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
    version.send(encodeHello({ roomId, token: randomToken(), version: 99 }))
    assert.equal((await version.next(MSG.ERR)).code, ERR.VERSION)
    assert.equal((/** @type {any} */ (await version.closed)).code, CLOSE.VERSION)

    const mismatch = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
    mismatch.send(encodeHello({ roomId: randomRoom(), token: randomToken() }))
    assert.equal((/** @type {any} */ (await mismatch.closed)).code, CLOSE.BAD_REQUEST)

    const ping = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
    ping.ws.send('ping')
    await new Promise((r) => setTimeout(r, 200))
    assert.deepEqual(ping.texts, ['pong'])
    await ping.close()

    const res = await fetch(`${relay.http}/ws/${roomId}`, { headers: { connection: 'upgrade', upgrade: 'nope' } }).catch(() => null)
    assert.ok(!res || res.status !== 101)
  })

  test('blob PUT/GET with hash check, alias lookup and auth', async () => {
    const roomId = randomRoom()
    const token = randomToken()
    const data = randomBytes(100_000)
    const hash = sha(data)
    const alias = sha(randomBytes(8))
    const auth = { authorization: `Bearer ${token}` }

    const wrong = await fetch(`${relay.http}/blob/${roomId}/${sha(randomBytes(4))}`, { method: 'PUT', body: data, headers: auth })
    assert.equal(wrong.status, 400)
    const noToken = await fetch(`${relay.http}/blob/${roomId}/${hash}`, { method: 'PUT', body: data })
    assert.equal(noToken.status, 401)

    const put = await fetch(`${relay.http}/blob/${roomId}/${hash}`, { method: 'PUT', body: data, headers: { ...auth, 'x-blob-alias': alias } })
    assert.equal(put.status, 201)
    const again = await fetch(`${relay.http}/blob/${roomId}/${hash}`, { method: 'PUT', body: data, headers: auth })
    assert.equal(again.status, 200)
    assert.equal((/** @type {any} */ (await again.json())).existed, true)

    const get = await fetch(`${relay.http}/blob/${roomId}/${hash}`, { headers: auth })
    assert.equal(get.status, 200)
    assert.match(get.headers.get('cache-control') ?? '', /immutable/)
    assert.equal(get.headers.get('x-content-sha256'), hash)
    assert.equal(sha(new Uint8Array(await get.arrayBuffer())), hash)

    const byAlias = await fetch(`${relay.http}/blob/${roomId}/${alias}`, { headers: auth })
    assert.equal(byAlias.status, 200)
    assert.equal(sha(new Uint8Array(await byAlias.arrayBuffer())), hash)

    const head = await fetch(`${relay.http}/blob/${roomId}/${alias}`, { method: 'HEAD', headers: auth })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), String(data.length))

    const missing = await fetch(`${relay.http}/blob/${roomId}/${sha(randomBytes(4))}`, { headers: auth })
    assert.equal(missing.status, 404)
    const badToken = await fetch(`${relay.http}/blob/${roomId}/${hash}`, { headers: { authorization: `Bearer ${randomToken()}` } })
    assert.equal(badToken.status, 401)
    const noRoom = await fetch(`${relay.http}/blob/${randomRoom()}/${hash}`, { headers: auth })
    assert.equal(noRoom.status, 404)

    // The blob room is the same room as the WebSocket one (same token).
    const ws = await TestClient.join(relay.ws, { roomId, token })
    await ws.client.close()

    // Refused from the declared size alone, before the relay reads any of it.
    assert.equal(await statusOfDeclaredUpload(`${relay.http}/blob/${roomId}/${sha(randomBytes(4))}`, auth, 2 * 1024 * 1024 + 10), 413)
  })

  test('state survives a restart', async () => {
    const dataDir = tempDir()
    const r1 = await spawnRelay({}, dataDir)
    const roomId = randomRoom()
    const token = randomToken()
    const a = await TestClient.join(r1.ws, { roomId, token })
    a.client.send(encodePush(1, bytes(3)))
    await a.client.next(MSG.ACK)
    await a.client.close()
    await r1.stop()

    const r2 = await spawnRelay({}, dataDir)
    try {
      const b = await TestClient.join(r2.ws, { roomId, token })
      assert.equal(b.welcome.head, 1)
      await b.client.close()
      const bad = /** @type {TestClient} */ (await TestClient.open(`${r2.ws}/ws/${roomId}`))
      bad.send(encodeHello({ roomId, token: randomToken() }))
      assert.equal((/** @type {any} */ (await bad.closed)).code, CLOSE.UNAUTHORIZED)
    } finally {
      await r2.stop()
    }
  })
})

describe('relay limits', () => {
  test('access key: wrong key 4403, probe never creates a room', async () => {
    const relay = await spawnRelay({ ACCESS_KEY: 'team-secret-key' })
    try {
      const health = /** @type {any} */ (await (await fetch(`${relay.http}/healthz`)).json())
      assert.equal(health.accessKeyRequired, true)
      const roomId = randomRoom()
      const token = randomToken()
      const bad = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
      bad.send(encodeHello({ roomId, token, accessKey: 'nope' }))
      assert.equal((await bad.next(MSG.ERR)).code, ERR.FORBIDDEN)
      assert.equal((/** @type {any} */ (await bad.closed)).code, CLOSE.FORBIDDEN)

      const probe = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
      probe.send(encodeHello({ roomId, token, accessKey: 'team-secret-key', flags: HELLO_PROBE }))
      await probe.next(MSG.WELCOME)
      assert.equal((/** @type {any} */ (await probe.closed)).code, CLOSE.NORMAL)
      // The probe did not claim the room: another token can still claim it.
      const owner = await TestClient.join(relay.ws, { roomId, token: randomToken(), accessKey: 'team-secret-key' })
      assert.equal(owner.welcome.head, 0)
      await owner.client.close()

      const blob = randomBytes(10)
      const noKey = await fetch(`${relay.http}/blob/${roomId}/${sha(blob)}`, { method: 'PUT', body: blob, headers: { authorization: `Bearer ${token}` } })
      assert.equal(noKey.status, 403)
    } finally {
      await relay.stop()
    }
  })

  test('message rate limit closes flooding sockets with 4429', async () => {
    const relay = await spawnRelay({ MSG_PER_SEC: '5' })
    try {
      const roomId = randomRoom()
      const token = randomToken()
      const a = await TestClient.join(relay.ws, { roomId, token })
      const eph = new Encoder().u8(MSG.EPH).bytes(bytes(10)).done()
      for (let i = 0; i < 100; i++) a.client.ws.send(eph)
      assert.equal((/** @type {any} */ (await a.client.closed)).code, CLOSE.RATE_LIMITED)
    } finally {
      await relay.stop()
    }
  })

  test('connections per IP are limited', async () => {
    const relay = await spawnRelay({ MAX_CONN_PER_IP: '2' })
    try {
      const roomId = randomRoom()
      const a = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
      const b = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
      await assert.rejects(TestClient.open(`${relay.ws}/ws/${roomId}`), /429/)
      await a.close()
      await new Promise((r) => setTimeout(r, 100))
      const c = /** @type {TestClient} */ (await TestClient.open(`${relay.ws}/ws/${roomId}`))
      await b.close()
      await c.close()
    } finally {
      await relay.stop()
    }
  })

  test('room quota rejects pushes but allows compaction', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), maxRoomMB: 1, log: false })
    const { port } = await relay.listen()
    try {
      const roomId = randomRoom()
      const token = randomToken()
      const a = await TestClient.join(`ws://127.0.0.1:${port}`, { roomId, token })
      a.client.send(encodePush(1, randomBytes(700_000)))
      assert.equal((await a.client.next(MSG.ACK)).seq, 1)
      a.client.send(encodePush(2, randomBytes(700_000)))
      const err = await a.client.next(MSG.ERR)
      assert.deepEqual([err.code, err.ref], [ERR.QUOTA, 2])
      a.client.send(encodeCompact(1, randomBytes(1000)))
      assert.equal((await a.client.next(MSG.COMPACTED)).logBytes, 0)
      a.client.send(encodePush(3, randomBytes(1000)))
      assert.equal((await a.client.next(MSG.ACK)).seq, 2)
      await a.client.close()
    } finally {
      await relay.close()
    }
  })

  test('unauthenticated sockets time out and shutdown is graceful', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), helloTimeoutMs: 200, log: false })
    const { port } = await relay.listen()
    const idle = /** @type {TestClient} */ (await TestClient.open(`ws://127.0.0.1:${port}/ws/${randomRoom()}`))
    assert.equal((/** @type {any} */ (await idle.closed)).code, CLOSE.HELLO_TIMEOUT)

    const a = await TestClient.join(`ws://127.0.0.1:${port}`, { roomId: randomRoom(), token: randomToken() })
    assert.equal(relay.stats().connections, 1)
    await relay.close()
    assert.equal((/** @type {any} */ (await a.client.closed)).code, CLOSE.GOING_AWAY)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`))
  })

  test('works through a path prefix (reverse proxy)', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), log: false })
    const { port } = await relay.listen()
    try {
      const res = await fetch(`http://127.0.0.1:${port}/relay/healthz`)
      assert.equal(res.status, 200)
      const a = await TestClient.join(`ws://127.0.0.1:${port}/relay`, { roomId: randomRoom(), token: randomToken() })
      await a.client.close()
      const ws = new WebSocket(`ws://127.0.0.1:${port}/nope`)
      await new Promise((resolve) => ws.once('unexpected-response', resolve).once('error', resolve))
    } finally {
      await relay.close()
    }
  })
})

describe('relay hardening', () => {
  test('announces its message limit and closes oversized messages with 4413', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), maxMessageMB: 1, log: false })
    const { port } = await relay.listen()
    try {
      const health = /** @type {any} */ (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json())
      assert.equal(health.maxMessageMB, 1)
      assert.equal(health.maxMessageBytes, 1024 * 1024)
      const a = await TestClient.join(`ws://127.0.0.1:${port}`, { roomId: randomRoom(), token: randomToken() })
      assert.equal(a.welcome.maxMessage, 1024 * 1024)
      a.client.send(encodePush(1, randomBytes(1_500_000)))
      assert.equal((/** @type {any} */ (await a.client.closed)).code, CLOSE.TOO_LARGE)
    } finally {
      await relay.close()
    }
  })

  test('nothing is buffered before HELLO: multi-part frames are refused at once', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), log: false })
    const { port } = await relay.listen()
    try {
      const roomId = randomRoom()
      const c = /** @type {TestClient} */ (await TestClient.open(`ws://127.0.0.1:${port}/ws/${roomId}`))
      // First part of a 4 MB transfer, sent without authenticating.
      c.ws.send(new Encoder().u8(MSG.PART).varUint(1).varUint(0).varUint(8).bytes(bytes(512 * 1024)).done())
      assert.equal((/** @type {any} */ (await c.closed)).code, CLOSE.BAD_REQUEST)
      // An oversized pseudo-HELLO is refused too.
      const d = /** @type {TestClient} */ (await TestClient.open(`ws://127.0.0.1:${port}/ws/${roomId}`))
      d.ws.send(new Encoder().u8(MSG.HELLO).bytes(bytes(100_000)).done())
      assert.equal((/** @type {any} */ (await d.closed)).code, CLOSE.BAD_REQUEST)
    } finally {
      await relay.close()
    }
  })

  test('aborted handshakes do not leak per-IP connection slots', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), maxConnectionsPerIp: 2, log: false })
    const { port } = await relay.listen()
    const net = await import('node:net')
    try {
      const roomId = randomRoom()
      // Upgrades ws aborts without calling back: no Sec-WebSocket-Key, wrong version, POST.
      const junk = [
        `GET /ws/${roomId} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        `GET /ws/${roomId} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 99\r\n\r\n`,
        `POST /ws/${roomId} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nContent-Length: 0\r\n\r\n`,
      ]
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => {
          const s = net.connect(port, '127.0.0.1', () => s.write(junk[i % junk.length]))
          s.on('data', () => {})
          s.on('error', resolve)
          s.on('close', resolve)
        })
      }
      await new Promise((r) => setTimeout(r, 50))
      const a = /** @type {TestClient} */ (await TestClient.open(`ws://127.0.0.1:${port}/ws/${roomId}`))
      const b = /** @type {TestClient} */ (await TestClient.open(`ws://127.0.0.1:${port}/ws/${roomId}`))
      await assert.rejects(TestClient.open(`ws://127.0.0.1:${port}/ws/${roomId}`), /429/)
      await a.close()
      await b.close()
    } finally {
      await relay.close()
    }
  })

  test('TRUST_PROXY limits by the address the proxy saw, not the one the client claims', async () => {
    const relay = createRelayServer({ port: 0, host: '127.0.0.1', dataDir: tempDir(), maxConnectionsPerIp: 1, trustProxy: 1, log: false })
    const { port } = await relay.listen()
    const open = (/** @type {string} */ xff) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/${randomRoom()}`, { headers: { 'x-forwarded-for': xff } })
        ws.once('open', () => resolve(ws))
        ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
        ws.once('error', reject)
      })
    try {
      // Same real client (as appended by the proxy), different forged prefixes.
      const first = /** @type {WebSocket} */ (await open('1.1.1.1, 198.51.100.4'))
      await assert.rejects(open('2.2.2.2, 198.51.100.4'), /429/)
      const other = /** @type {WebSocket} */ (await open('1.1.1.1, 198.51.100.5'))
      first.close()
      other.close()
    } finally {
      await relay.close()
    }
  })
})
