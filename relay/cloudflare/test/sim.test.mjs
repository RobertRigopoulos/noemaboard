// Logic tests for the Cloudflare adapter under plain Node (fake Durable Objects runtime).
// Run: node --test test/   (Node >= 22.18; no Cloudflare tooling needed)
import { fakeCtx, FakeSocket } from './runtime.mjs'
import { describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { CLOSE, Decoder, ERR, HELLO_PROBE, MSG, Reassembler, decodeFrame, encodeCompact, encodeHello, encodePush, Encoder, splitFrame } from '../../src/protocol.js'

const { RelayRoom, BlobStore, default: worker } = await import('../src/index.ts')

const sha = (b) => createHash('sha256').update(b).digest('hex')
const room = () => randomBytes(16).toString('base64url')
const token = () => randomBytes(32).toString('base64url')

function harness(env = {}) {
  const ctx = fakeCtx()
  const h = {
    ctx,
    env,
    obj: new RelayRoom(ctx, env),
    tid: 0,
    /** Simulates hibernation/eviction: a fresh object over the same storage and sockets. */
    wake() {
      h.obj = new RelayRoom(ctx, env)
    },
    connect(roomId) {
      const ws = new FakeSocket()
      ws.parts = new Reassembler(1 << 30)
      ctx.acceptWebSocket(ws)
      ws.serializeAttachment({ room: roomId, authed: false })
      return ws
    },
    async send(ws, frame) {
      for (const f of splitFrame(frame, ++h.tid)) await h.obj.webSocketMessage(ws, f.slice().buffer)
    },
    /** Decoded frames received by `ws` since the last call. */
    frames(ws) {
      const out = []
      for (const raw of ws.sent.splice(0)) {
        if (typeof raw === 'string') continue
        let frame = raw
        if (raw[0] === MSG.PART) {
          const d = new Decoder(raw)
          d.u8()
          frame = ws.parts.push(d)
          if (!frame) continue
        }
        out.push(decodeFrame(frame))
      }
      return out
    },
    async join(roomId, tok, since = 0, accessKey = '') {
      const ws = h.connect(roomId)
      await h.send(ws, encodeHello({ roomId, token: tok, since, accessKey }))
      const welcome = h.frames(ws).find((f) => f.type === MSG.WELCOME)
      return { ws, welcome }
    },
  }
  return h
}

describe('cloudflare RelayRoom', () => {
  test('push, broadcast, late joiner, compaction and wake-up', async () => {
    const h = harness()
    const r = room()
    const t = token()
    const a = await h.join(r, t)
    assert.equal(a.welcome.head, 0)
    const b = await h.join(r, t)
    assert.equal(b.welcome.peers, 1)
    assert.deepEqual(h.frames(a.ws).map((f) => f.type), [MSG.PEERS])

    await h.send(a.ws, encodePush(5, new Uint8Array([1, 2, 3])))
    assert.deepEqual(h.frames(a.ws), [{ type: MSG.ACK, id: 5, seq: 1 }])
    const upd = h.frames(b.ws)
    assert.equal(upd[0].type, MSG.UPD)
    assert.equal(upd[0].seq, 1)
    await h.send(b.ws, encodePush(1, new Uint8Array([4])))
    await h.send(a.ws, encodePush(6, new Uint8Array([5, 6])))
    h.frames(a.ws)
    h.frames(b.ws)

    const c = await h.join(r, t)
    assert.deepEqual(c.welcome.updates.map((u) => u.seq), [1, 2, 3])
    assert.equal(c.welcome.peers, 2)
    for (const ws of [a.ws, b.ws]) assert.deepEqual(h.frames(ws), [{ type: MSG.PEERS, peers: 2 }])
    assert.equal(c.welcome.logBytes, 6)

    await h.send(a.ws, encodeCompact(2, new Uint8Array(40).fill(9)))
    for (const ws of [a.ws, b.ws, c.ws]) assert.deepEqual(h.frames(ws), [{ type: MSG.COMPACTED, snapSeq: 2, logBytes: 2 }])
    await h.send(b.ws, encodeCompact(2, new Uint8Array(40)))
    assert.deepEqual(h.frames(b.ws), [{ type: MSG.COMPACTED, snapSeq: 2, logBytes: 2 }])
    assert.deepEqual(h.frames(a.ws), [])

    // A fresh object (after hibernation) rebuilds its bookkeeping from storage.
    h.wake()
    const d = await h.join(r, t, 0)
    assert.equal(d.welcome.snapSeq, 2)
    assert.equal(d.welcome.head, 3)
    assert.equal(d.welcome.snapshot.length, 40)
    assert.deepEqual(d.welcome.updates.map((u) => u.seq), [3])
    const e = await h.join(r, t, 3)
    assert.equal(e.welcome.snapshot, null)
    assert.equal(e.welcome.updates.length, 0)
    const f = await h.join(r, t, 99)
    assert.notEqual(f.welcome.snapshot, null)
    await h.send(f.ws, encodePush(1, new Uint8Array([7])))
    assert.equal(h.frames(f.ws)[0].seq, 4)

    // Previous snapshot generation is kept; the log below the snapshot is gone.
    const gens = h.ctx.db.prepare('select gen, count(*) as n from snaps group by gen order by gen').all()
    assert.deepEqual(gens.map((g) => g.gen), [0])
    await h.send(a.ws, encodeCompact(4, new Uint8Array(10)))
    const gens2 = h.ctx.db.prepare('select gen from snaps group by gen order by gen').all()
    assert.deepEqual(gens2.map((g) => g.gen), [0, 1])
    assert.equal(h.ctx.db.prepare('select count(*) as n from log').get().n, 0)
  })

  test('large updates are chunked in storage and on the wire', async () => {
    const h = harness()
    const r = room()
    const t = token()
    const a = await h.join(r, t)
    const b = await h.join(r, t)
    h.frames(a.ws)
    const big = randomBytes(3_400_000)
    await h.send(a.ws, encodePush(1, big))
    assert.equal(h.frames(a.ws)[0].seq, 1)
    assert.ok(b.ws.sent.length > 1, 'sent as PART frames')
    assert.equal(sha(h.frames(b.ws)[0].data), sha(big))
    assert.equal(h.ctx.db.prepare('select count(*) as n from log where seq = 1').get().n, 3)
    h.wake()
    const c = await h.join(r, t)
    assert.equal(sha(c.welcome.updates[0].data), sha(big))
    assert.equal(c.welcome.logBytes, big.length)
  })

  test('rejects wrong tokens, bad frames, wrong access keys; probes do not claim rooms', async () => {
    const h = harness({ ACCESS_KEY: 'k-1' })
    const r = room()
    const t = token()
    const bad = await h.join(r, t, 0, 'nope')
    assert.equal(bad.ws.closed.code, CLOSE.FORBIDDEN)

    const probe = h.connect(r)
    await h.send(probe, encodeHello({ roomId: r, token: token(), accessKey: 'k-1', flags: HELLO_PROBE }))
    assert.equal(h.frames(probe)[0].type, MSG.WELCOME)
    assert.equal(probe.closed.code, CLOSE.NORMAL)

    const owner = await h.join(r, t, 0, 'k-1')
    assert.ok(owner.welcome)
    const thief = await h.join(r, token(), 0, 'k-1')
    assert.equal(thief.ws.closed.code, CLOSE.UNAUTHORIZED)

    const mismatch = h.connect(r)
    await h.send(mismatch, encodeHello({ roomId: room(), token: t, accessKey: 'k-1' }))
    assert.equal(mismatch.closed.code, CLOSE.BAD_REQUEST)

    const early = h.connect(r)
    await h.send(early, encodePush(1, new Uint8Array([1])))
    assert.equal(early.closed.code, CLOSE.BAD_REQUEST)

    const version = h.connect(r)
    await h.send(version, encodeHello({ roomId: r, token: t, accessKey: 'k-1', version: 2 }))
    assert.equal(version.closed.code, CLOSE.VERSION)
  })

  test('quota, ephemeral broadcast and rate limit', async () => {
    const h = harness({ MAX_ROOM_MB: '1' })
    const r = room()
    const t = token()
    const a = await h.join(r, t)
    const b = await h.join(r, t)
    h.frames(a.ws)
    await h.send(a.ws, new Encoder().u8(MSG.EPH).bytes(new Uint8Array([1, 2])).done())
    assert.deepEqual(h.frames(b.ws).map((f) => f.type), [MSG.EPH])
    assert.deepEqual(h.frames(a.ws), [])

    await h.send(a.ws, encodePush(1, randomBytes(700_000)))
    h.frames(a.ws)
    await h.send(a.ws, encodePush(2, randomBytes(700_000)))
    const err = h.frames(a.ws)[0]
    assert.deepEqual([err.type, err.code, err.ref], [MSG.ERR, ERR.QUOTA, 2])

    const eph = new Encoder().u8(MSG.EPH).bytes(new Uint8Array([1])).done()
    for (let i = 0; i < 400 && !b.ws.closed; i++) await h.send(b.ws, eph)
    assert.equal(b.ws.closed?.code, CLOSE.RATE_LIMITED)
  })
})

describe('cloudflare RelayRoom limits', () => {
  test('announces its message limit and closes oversized messages with 4413', async () => {
    const h = harness({ MAX_MESSAGE_MB: '1' })
    const a = await h.join(room(), token())
    assert.equal(a.welcome.maxMessage, 1024 * 1024)
    await h.send(a.ws, encodePush(1, randomBytes(1_500_000)))
    assert.equal(a.ws.closed?.code, CLOSE.TOO_LARGE)
    const health = await (await worker.fetch(new Request('https://relay.example/healthz'), { MAX_MESSAGE_MB: '1' })).json()
    assert.equal(health.maxMessageMB, 1)
  })

  test('buffers nothing before HELLO', async () => {
    const h = harness()
    const ws = h.connect(room())
    const parts = splitFrame(encodePush(1, randomBytes(3_000_000)), 1)
    await h.obj.webSocketMessage(ws, parts[0].slice().buffer)
    assert.equal(ws.closed?.code, CLOSE.BAD_REQUEST)
    assert.equal(h.obj.parts.size, 0)
  })

  test('stays awake while a multi-part message is incomplete, and drops stalled ones', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
    try {
      const h = harness()
      const r = room()
      const t = token()
      const a = await h.join(r, t)
      h.frames(a.ws)
      // A slow uplink: one part every 30 s. A pending timer keeps the object from hibernating.
      const parts = splitFrame(encodePush(7, randomBytes(1_600_000)), 1)
      assert.ok(parts.length >= 3)
      for (const part of parts) {
        await h.obj.webSocketMessage(a.ws, part.slice().buffer)
        assert.equal(a.ws.closed, null)
        mock.timers.tick(30_000)
      }
      assert.deepEqual(h.frames(a.ws).map((f) => [f.type, f.id]), [[MSG.ACK, 7]])

      // A sender that stops mid-message is cut off instead of holding memory forever.
      await h.obj.webSocketMessage(a.ws, splitFrame(encodePush(8, randomBytes(1_600_000)), 2)[0].slice().buffer)
      mock.timers.tick(61_000)
      assert.equal(a.ws.closed?.code, CLOSE.HELLO_TIMEOUT)
      assert.equal(h.obj.parts.size, 0)
    } finally {
      mock.timers.reset()
    }
  })
})

describe('cloudflare worker + BlobStore', () => {
  function env(extra = {}) {
    const rooms = new Map()
    const blobs = new Map()
    const base = { MAX_BLOB_MB: '5', MAX_ROOM_MB: '50', ...extra }
    const ns = (map, Cls) => ({
      idFromName: (name) => name,
      get: (id) => {
        if (!map.has(id)) map.set(id, new Cls(fakeCtx(), base))
        return map.get(id)
      },
    })
    base.ROOMS = ns(rooms, RelayRoom)
    base.BLOBS = ns(blobs, BlobStore)
    return { env: base, blobs }
  }

  test('health check and CORS', async () => {
    const { env: e } = env({ ACCESS_KEY: 'x' })
    const res = await worker.fetch(new Request('https://relay.example/healthz'), e)
    const body = await res.json()
    assert.equal(body.service, 'noema-relay')
    assert.equal(body.protocol, 1)
    assert.equal(body.accessKeyRequired, true)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    const pre = await worker.fetch(new Request('https://relay.example/blob/x/y', { method: 'OPTIONS' }), e)
    assert.equal(pre.status, 204)
  })

  test('blob upload, chunked storage, alias lookup, hash check and limits', async () => {
    const { env: e, blobs } = env()
    const r = room()
    const t = token()
    const auth = { authorization: `Bearer ${t}` }
    const data = randomBytes(3_500_000)
    const hash = sha(data)
    const alias = sha(randomBytes(4))
    const url = (k) => `https://relay.example/blob/${r}/${k}`

    assert.equal((await worker.fetch(new Request(url(hash), { headers: auth }), e)).status, 404)
    const wrong = await worker.fetch(new Request(url(sha(randomBytes(3))), { method: 'PUT', body: data, headers: auth }), e)
    assert.equal(wrong.status, 400)
    const put = await worker.fetch(new Request(url(hash), { method: 'PUT', body: data, headers: { ...auth, 'x-blob-alias': alias } }), e)
    assert.equal(put.status, 201)
    assert.equal(put.headers.get('access-control-allow-origin'), '*')
    assert.equal(blobs.get(r).ctx.db.prepare('select count(*) as n from chunks').get().n, 3)
    const again = await worker.fetch(new Request(url(hash), { method: 'PUT', body: data, headers: auth }), e)
    assert.equal(again.status, 200)

    for (const k of [hash, alias]) {
      const get = await worker.fetch(new Request(url(k), { headers: auth }), e)
      assert.equal(get.status, 200)
      assert.equal(get.headers.get('x-content-sha256'), hash)
      assert.equal(sha(new Uint8Array(await get.arrayBuffer())), hash)
    }
    const head = await worker.fetch(new Request(url(alias), { method: 'HEAD', headers: auth }), e)
    assert.equal(head.headers.get('content-length'), String(data.length))

    const badToken = await worker.fetch(new Request(url(hash), { headers: { authorization: `Bearer ${token()}` } }), e)
    assert.equal(badToken.status, 401)
    const huge = randomBytes(6 * 1024 * 1024)
    const tooBig = await worker.fetch(new Request(url(sha(huge)), { method: 'PUT', body: huge, headers: auth }), e)
    assert.equal(tooBig.status, 413)

    // The same token works for the room's WebSocket (shared trust-on-first-use).
    const roomObj = e.ROOMS.get(r)
    assert.equal(await roomObj.authorize(r, t, false), 'ok')
    assert.equal(await roomObj.authorize(r, token(), false), 'unauthorized')
  })
})
