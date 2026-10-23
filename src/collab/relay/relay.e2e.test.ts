/**
 * End-to-end: real relay server (relay/bin, spawned on a random port) + real client connections.
 * Skipped when the relay package's dependencies are not installed (`cd relay && npm install`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { newSecret } from '../../model/ids'
import { hashBytes } from '../crypto'
import { RelayConnection, type RelayTiming } from './connection'
import { deriveRelayKeys, type RelayKeys } from './keys'
import { memoryStateStore, type RelayStateStore } from './state'
import { parseRelayUrl, type RelayEndpoint } from './url'
import { downloadBlob, relayHasBlob, uploadBlob } from './blobs'
import { Encoder, MSG, decodeServerFrame } from './protocol'
import type { BoardRelayStatus } from './status'
import { testRelay } from './index'

// Node built-ins without pulling @types/node into the app's type-check.
const load = (m: string): Promise<any> => import(/* @vite-ignore */ m)
const cp = await load('node:child_process')
const fs = await load('node:fs')
const os = await load('node:os')
const path = await load('node:path')
const { fileURLToPath } = await load('node:url')
const proc: any = (globalThis as any).process

const BIN: string = fileURLToPath(new URL('../../../relay/bin/noema-relay.js', import.meta.url))
const HAS_RELAY: boolean = fs.existsSync(path.join(path.dirname(BIN), '..', 'node_modules', 'ws'))
// CI's relay job sets this: there, skipping would hide a broken relay protocol.
if (!HAS_RELAY && proc.env.REQUIRE_RELAY_E2E) {
  throw new Error('The relay end-to-end tests need the relay dependencies: run `npm ci` in relay/.')
}

const FAST: Partial<RelayTiming> = {
  pushIntervalMs: 20,
  ephIntervalMs: 20,
  foreignDelayMs: [250, 350],
  compactDelayMs: [20, 40],
  compactUpdates: 5,
  compactBytes: 1e9,
  backoffBaseMs: 50,
  backoffMaxMs: 400,
  persistDelayMs: 10,
}

interface Relay {
  url: string
  port: number
  dir: string
  stop: () => Promise<void>
}

async function startRelay(opts: { port?: number; dir?: string; env?: Record<string, string> } = {}): Promise<Relay> {
  const dir: string = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'noema-relay-e2e-'))
  const child = cp.spawn(proc.execPath, [BIN], {
    env: { ...proc.env, PORT: String(opts.port ?? 0), HOST: '127.0.0.1', DATA_DIR: dir, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let err = ''
  child.stderr.on('data', (d: unknown) => (err += String(d)))
  const port: number = await new Promise((resolve, reject) => {
    let out = ''
    const t = setTimeout(() => reject(new Error(`relay did not start: ${err}`)), 10_000)
    child.stdout.on('data', (d: unknown) => {
      out += String(d)
      const m = out.match(/RELAY_PORT=(\d+)/)
      if (m) {
        clearTimeout(t)
        resolve(Number(m[1]))
      }
    })
    child.once('exit', (code: number) => reject(new Error(`relay exited (${code}): ${err}`)))
  })
  return {
    url: `ws://127.0.0.1:${port}`,
    port,
    dir,
    stop: async () => {
      // A process ended by a signal keeps exitCode null: check both, or a second stop() hangs.
      if (child.exitCode !== null || child.signalCode !== null) return
      const exited = new Promise((r) => child.once('exit', r))
      child.kill()
      await exited
    },
  }
}

async function waitFor(cond: () => boolean, ms = 5000, what = 'condition') {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 15))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Device {
  doc: Y.Doc
  conn: RelayConnection
  store: RelayStateStore
  statuses: BoardRelayStatus[]
}

function device(endpoint: RelayEndpoint, keys: RelayKeys, opts: { doc?: Y.Doc; store?: RelayStateStore; timing?: Partial<RelayTiming> } = {}): Device {
  const doc = opts.doc ?? new Y.Doc()
  const store = opts.store ?? memoryStateStore()
  const statuses: BoardRelayStatus[] = []
  const conn = new RelayConnection({
    boardId: 'board-e2e-0001',
    endpoint,
    keys,
    doc,
    store,
    timing: { ...FAST, ...opts.timing },
    onStatus: (s) => statuses.push(s),
  })
  conn.start()
  return { doc, conn, store, statuses }
}

const text = (d: Y.Doc) => d.getMap<string>('cards').toJSON()

describe.skipIf(!HAS_RELAY)('relay end-to-end', () => {
  let relay: Relay
  let endpoint: RelayEndpoint
  const all: Device[] = []
  const dev = (keys: RelayKeys, opts?: Parameters<typeof device>[2]) => {
    const d = device(endpoint, keys, opts)
    all.push(d)
    return d
  }

  beforeAll(async () => {
    relay = await startRelay()
    endpoint = parseRelayUrl(relay.url)!
  })

  afterAll(async () => {
    for (const d of all) d.conn.stop()
    await relay?.stop()
  })

  it('syncs two devices live and restores a late joiner', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    const b = dev(keys)
    await waitFor(() => a.conn.connected && b.conn.connected, 5000, 'connect')
    expect(a.statuses.at(-1)?.state).toBe('connected')

    a.doc.getMap('cards').set('c1', 'from A')
    await waitFor(() => text(b.doc).c1 === 'from A', 5000, 'A -> B')
    b.doc.getMap('cards').set('c2', 'from B')
    await waitFor(() => text(a.doc).c2 === 'from B', 5000, 'B -> A')

    const c = dev(keys)
    await waitFor(() => c.conn.connected, 5000, 'late joiner')
    expect(text(c.doc)).toEqual({ c1: 'from A', c2: 'from B' })
    await waitFor(() => a.conn.clean && b.conn.clean, 5000, 'clean')
    expect(b.statuses.at(-1)?.peers).toBe(2)
  })

  it('never stores plaintext on the relay', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    await waitFor(() => a.conn.connected)
    a.doc.getMap('cards').set('secret', 'TOP-SECRET-PLAN-1234')
    await waitFor(() => a.conn.clean, 5000, 'pushed')
    await sleep(100)
    for (const f of fs.readdirSync(relay.dir)) {
      const p = path.join(relay.dir, f)
      if (!fs.statSync(p).isFile()) continue
      expect(fs.readFileSync(p).includes('TOP-SECRET-PLAN')).toBe(false)
    }
  })

  it('pushes edits made while disconnected when it reconnects', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    const b = dev(keys)
    await waitFor(() => a.conn.connected && b.conn.connected)
    a.doc.getMap('cards').set('before', 1 as unknown as string)
    await waitFor(() => text(b.doc).before !== undefined)
    await waitFor(() => a.conn.clean)
    a.conn.stop()
    // Edits while no relay connection exists (app closed / relay not configured).
    a.doc.getMap('cards').set('offline', 'typed offline')
    a.doc.getMap('cards').delete('before')
    const a2 = dev(keys, { doc: a.doc, store: a.store })
    await waitFor(() => a2.conn.connected)
    await waitFor(() => text(b.doc).offline === 'typed offline' && text(b.doc).before === undefined, 5000, 'offline edits')
  })

  it('compacts the log and late joiners restore from the snapshot', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    await waitFor(() => a.conn.connected)
    for (let i = 0; i < 12; i++) {
      a.doc.getMap('cards').set(`k${i}`, `v${i}`)
      await sleep(30)
    }
    await waitFor(() => a.conn.snapSeq > 0, 5000, 'compaction')
    a.doc.getMap('cards').set('after', 'compaction')
    await waitFor(() => a.conn.clean)
    const late = dev(keys)
    await waitFor(() => late.conn.connected)
    expect(Object.keys(text(late.doc)).length).toBe(13)
    expect(text(late.doc).after).toBe('compaction')
    expect(late.conn.snapSeq).toBe(a.conn.snapSeq)
  })

  it('does not re-push edits that arrived peer-to-peer, unless the relay lacks them', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    const b = dev(keys)
    await waitFor(() => a.conn.connected && b.conn.connected)
    // A edits; B gets the same update over "peer-to-peer" before the relay delivers it.
    a.doc.on('update', (u: Uint8Array, origin: unknown) => {
      if (origin !== a.conn.origin) Y.applyUpdate(b.doc, u, 'p2p')
    })
    a.doc.getMap('cards').set('shared', 'via both')
    await waitFor(() => a.conn.clean)
    await sleep(500)
    expect(a.conn.lastSeq).toBe(1)
    expect(b.conn.lastSeq).toBe(1)

    // An author without relay access: only B can bring their edit to the relay.
    const offline = new Y.Doc()
    Y.applyUpdate(offline, Y.encodeStateAsUpdate(b.doc))
    offline.on('update', (u: Uint8Array) => Y.applyUpdate(b.doc, u, 'p2p'))
    offline.getMap('cards').set('p2p-only', 'needs a lift')
    await waitFor(() => text(a.doc)['p2p-only'] === 'needs a lift', 5000, 'foreign push')
    await waitFor(() => b.conn.clean)
    expect(b.conn.lastSeq).toBe(2)
  })

  it('forwards presence and removes it when a device leaves', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const a = dev(keys)
    const b = dev(keys)
    await waitFor(() => a.conn.connected && b.conn.connected)
    const awA = new Awareness(a.doc)
    const awB = new Awareness(b.doc)
    a.conn.attachAwareness(awA)
    b.conn.attachAwareness(awB)
    awA.setLocalState({ user: { id: 'u-a', name: 'Ada', color: '#f00' }, pointer: { x: 1, y: 2 } })
    await waitFor(() => (awB.getStates().get(awA.clientID) as { user?: { name?: string } } | undefined)?.user?.name === 'Ada', 5000, 'presence')
    // B's state reaches A too (answer to a newcomer).
    awB.setLocalState({ user: { id: 'u-b', name: 'Bo', color: '#00f' } })
    await waitFor(() => awA.getStates().has(awB.clientID), 5000, 'presence back')
    a.conn.stop()
    await waitFor(() => !awB.getStates().has(awA.clientID), 5000, 'presence removed')
    awA.destroy()
    awB.destroy()
  })

  it('recovers when the relay loses its data', async () => {
    const r1 = await startRelay()
    const ep = parseRelayUrl(r1.url)!
    const keys = await deriveRelayKeys(newSecret())
    const a = device(ep, keys)
    all.push(a)
    await waitFor(() => a.conn.connected)
    a.doc.getMap('cards').set('precious', 'data')
    await waitFor(() => a.conn.clean && a.conn.lastSeq === 1)
    const mark = a.statuses.length
    await r1.stop()
    await waitFor(() => !a.conn.connected, 5000, 'disconnect')
    // The UI hears about the loss: 'offline', or straight to 'connecting' when the retry fires first.
    expect(a.statuses.slice(mark).some((s) => s.state === 'offline' || s.state === 'connecting')).toBe(true)
    // Same address, empty storage.
    const r2 = await startRelay({ port: r1.port })
    try {
      await waitFor(() => a.conn.connected, 8000, 'reconnect')
      await waitFor(() => a.conn.clean, 5000, 'reupload')
      const b = device(ep, keys)
      all.push(b)
      await waitFor(() => b.conn.connected)
      expect(text(b.doc).precious).toBe('data')
    } finally {
      await r2.stop()
    }
  })

  it('reports a missing access key as an error', async () => {
    const locked = await startRelay({ env: { ACCESS_KEY: 'k-123456' } })
    try {
      const keys = await deriveRelayKeys(newSecret())
      const bad = device(parseRelayUrl(locked.url)!, keys)
      all.push(bad)
      await waitFor(() => bad.statuses.at(-1)?.state === 'error', 5000, 'error state')
      expect(bad.statuses.at(-1)?.message).toMatch(/access key/)
      bad.conn.stop()
      const good = device(parseRelayUrl(`${locked.url}?key=k-123456`)!, keys)
      all.push(good)
      await waitFor(() => good.conn.connected)

      expect((await testRelay(locked.url)).message).toMatch(/access key/)
      expect((await testRelay(`${locked.url}/?key=wrong`)).ok).toBe(false)
      expect((await testRelay(`${locked.url}/?key=k-123456`)).ok).toBe(true)
    } finally {
      await locked.stop()
    }
  })

  it('tests relay addresses', async () => {
    const ok = await testRelay(relay.url.replace('ws://', 'http://'))
    expect(ok.ok).toBe(true)
    expect(ok.message).toMatch(/Connected/)
    expect((await testRelay('not a url')).ok).toBe(false)
    const down = await testRelay('ws://127.0.0.1:9')
    expect(down.ok).toBe(false)
    expect(down.message).toMatch(/reach/)
  })

  it('splits changes larger than the relay limit and never marks an unsendable one as synced', async () => {
    const small = await startRelay({ env: { MAX_MESSAGE_MB: '1' } })
    try {
      const ep = parseRelayUrl(small.url)!
      const keys = await deriveRelayKeys(newSecret())
      // About 3 MB of board content that existed before the relay was configured.
      const doc = new Y.Doc()
      const cards = doc.getMap<string>('cards')
      for (let i = 0; i < 300; i++) cards.set(`k${i}`, `${i}:`.padEnd(10_000, 'x'))
      const a = device(ep, keys, { doc })
      all.push(a)
      await waitFor(() => a.conn.connected && a.conn.clean, 10_000, 'reconcile in pieces')
      expect(a.conn.messageLimit).toBe(1024 * 1024)
      expect(a.conn.lastSeq).toBeGreaterThanOrEqual(3)
      const b = device(ep, keys)
      all.push(b)
      await waitFor(() => b.conn.connected, 5000, 'late joiner')
      expect(Object.keys(text(b.doc))).toHaveLength(300)

      // One struct bigger than the limit cannot be cut: it stays on this device, marked unsynced.
      a.doc.getText('big').insert(0, 'z'.repeat(1_500_000))
      await waitFor(() => a.statuses.at(-1)?.state === 'error', 5000, 'too large reported')
      expect(a.statuses.at(-1)?.message).toMatch(/too large/)
      a.doc.getMap('cards').set('after', 'later edit')
      await sleep(300)
      expect(a.conn.clean).toBe(false)
      expect(a.store.load('board-e2e-0001', ep.wsBase).dirty).toBe(true)

      // The admin raises the limit: the held change goes out on the next connection.
      await small.stop()
      const bigger = await startRelay({ port: small.port, dir: small.dir, env: { MAX_MESSAGE_MB: '4' } })
      try {
        await waitFor(() => a.conn.connected && a.conn.clean, 10_000, 'held change sent')
        await waitFor(() => b.doc.getText('big').length === 1_500_000 && text(b.doc).after === 'later edit', 10_000, 'held change received')
      } finally {
        await bigger.stop()
      }
    } finally {
      await small.stop()
    }
  }, 40_000)

  it('sends smaller pieces after a relay that does not announce its limit refuses a message (4413)', async () => {
    const small = await startRelay({ env: { MAX_MESSAGE_MB: '1' } })
    // Behaves like an older relay: WELCOME without the trailing message limit.
    class OldRelaySocket extends WebSocket {
      set onmessage(fn: ((ev: MessageEvent) => void) | null) {
        super.onmessage = !fn
          ? null
          : (ev: MessageEvent) => {
              const data = ev.data
              if (data instanceof ArrayBuffer && new Uint8Array(data)[0] === MSG.WELCOME) {
                const w = decodeServerFrame(new Uint8Array(data))
                if (w.type === MSG.WELCOME) {
                  const e = new Encoder().u8(MSG.WELCOME).varUint(w.snapSeq).varUint(w.head).varUint(w.logBytes).varUint(w.peers)
                  e.bytes(w.snapshot ?? new Uint8Array()).varUint(w.updates.length)
                  for (const u of w.updates) e.varUint(u.seq).bytes(u.data)
                  return fn(new MessageEvent('message', { data: e.done().slice().buffer }))
                }
              }
              fn(ev)
            }
      }
      get onmessage() {
        return super.onmessage
      }
    }
    try {
      const ep = parseRelayUrl(small.url)!
      const keys = await deriveRelayKeys(newSecret())
      const doc = new Y.Doc()
      for (let i = 0; i < 300; i++) doc.getMap<string>('cards').set(`k${i}`, `${i}:`.padEnd(10_000, 'x'))
      const statuses: BoardRelayStatus[] = []
      const conn = new RelayConnection({
        boardId: 'board-e2e-old',
        endpoint: ep,
        keys,
        doc,
        store: memoryStateStore(),
        timing: FAST,
        WebSocketImpl: OldRelaySocket as typeof WebSocket,
        onStatus: (s) => statuses.push(s),
      })
      conn.start()
      try {
        await waitFor(() => conn.connected && conn.clean, 20_000, 'pushed after shrinking')
        expect(statuses.some((s) => /too large/.test(s.message ?? ''))).toBe(true)
        expect(conn.messageLimit).toBeLessThanOrEqual(1024 * 1024)
        const b = device(ep, keys)
        all.push(b)
        await waitFor(() => b.conn.connected, 5000, 'late joiner')
        expect(Object.keys(text(b.doc))).toHaveLength(300)
      } finally {
        conn.stop()
      }
    } finally {
      await small.stop()
    }
  }, 40_000)

  it('uploads and downloads encrypted files', async () => {
    const keys = await deriveRelayKeys(newSecret())
    const target = { endpoint, keys }
    const bytes = crypto.getRandomValues(new Uint8Array(50_000))
    const hash = await hashBytes(bytes)
    const file = new Blob([bytes], { type: 'image/webp' })
    expect(await relayHasBlob(target, hash)).toBe(false)
    expect(await uploadBlob(target, hash, file)).toBe('uploaded')
    expect(await relayHasBlob(target, hash)).toBe(true)
    expect(await uploadBlob(target, hash, file)).toBe('exists')
    const back = await downloadBlob(target, hash)
    expect(back?.type).toBe('image/webp')
    expect(await hashBytes(await back!.arrayBuffer())).toBe(hash)
    // Another board cannot find it.
    const other = { endpoint, keys: await deriveRelayKeys(newSecret()) }
    expect(await downloadBlob(other, hash)).toBeNull()
    expect(await downloadBlob(target, 'f'.repeat(64))).toBeNull()
  })
})

describe.skipIf(!HAS_RELAY)('relay manager', () => {
  let relay: Relay
  beforeAll(async () => {
    relay = await startRelay()
  })
  afterAll(async () => {
    await relay?.stop()
  })

  it('connects relay boards and their nested boards, follows meta changes, moves files', async () => {
    const { useLibrary } = await import('../library')
    const { docs } = await import('../docs')
    const { getBlob, putBlob } = await import('../blobs')
    const { createCard, initBoardDoc, updateMeta, SYSTEM_ORIGIN } = await import('../../model/board')
    const { RelayManager, effectiveRelay } = await import('./manager')
    const { useRelayStatus } = await import('./status')

    const lib = useLibrary.getState()
    const now = Date.now()
    const ids = { parent: 'parentBoard01', child: 'childBoard001', grand: 'grandBoard001', unseen: 'unseenBoard01', other: 'otherBoard001' }
    const secrets = { parent: newSecret(), child: newSecret(), grand: newSecret(), unseen: newSecret(), other: newSecret() }
    lib.upsert({ id: ids.parent, secret: secrets.parent, relay: relay.url, parentId: 'home', lastOpened: now })
    lib.upsert({ id: ids.child, secret: secrets.child, parentId: ids.parent, lastOpened: now - 1 })
    lib.upsert({ id: ids.grand, secret: secrets.grand, parentId: ids.child, lastOpened: now - 2 })
    // Known from a board card but never opened on this device.
    lib.upsert({ id: ids.unseen, secret: secrets.unseen, parentId: ids.child, lastOpened: 0 })
    lib.upsert({ id: ids.other, secret: secrets.other, parentId: 'home', lastOpened: now })
    const entries = useLibrary.getState().entries
    expect(effectiveRelay(ids.grand, entries)).toBe(relay.url)
    expect(effectiveRelay(ids.unseen, entries)).toBe(relay.url)
    expect(effectiveRelay(ids.other, entries)).toBeNull()

    const manager = new RelayManager(memoryStateStore())
    manager.start()
    const state = (id: string) => useRelayStatus.getState().boards[id]?.state
    await waitFor(() => state(ids.parent) === 'connected' && state(ids.child) === 'connected' && state(ids.grand) === 'connected', 8000, 'manager connect')
    expect(state(ids.other)).toBeUndefined()
    // Never-opened nested boards do not hold a relay connection in the background.
    expect(state(ids.unseen)).toBeUndefined()

    // A local edit on the parent board reaches another device through the relay.
    const parentDoc = docs.peek(ids.parent)!
    initBoardDoc(parentDoc, { id: ids.parent, title: 'Parent', relay: relay.url }, 'u1')
    const cardId = createCard(parentDoc, 'note', { x: 10, y: 20 }, 'u1')
    const keys = await deriveRelayKeys(secrets.parent)
    const other = device(parseRelayUrl(relay.url)!, keys)
    await waitFor(() => other.doc.getMap('cards').has(cardId), 8000, 'manager push')

    // Files added on a relay board are uploaded; missing files are fetched from the relay.
    const bytes = crypto.getRandomValues(new Uint8Array(1000))
    const { hash } = await putBlob(new Blob([bytes], { type: 'image/png' }), ids.parent)
    const target = { endpoint: parseRelayUrl(relay.url)!, keys }
    const deadline = Date.now() + 8000
    while (!(await relayHasBlob(target, hash)) && Date.now() < deadline) await sleep(50)
    expect(await relayHasBlob(target, hash)).toBe(true)
    const remoteBytes = crypto.getRandomValues(new Uint8Array(500))
    const remoteHash = await hashBytes(remoteBytes)
    expect(await uploadBlob(target, remoteHash, new Blob([remoteBytes]))).toBe('uploaded')
    const fetched = await getBlob(remoteHash, ids.parent)
    expect(fetched && (await hashBytes(await fetched.arrayBuffer()))).toBe(remoteHash)

    // Removing the relay from the board's meta disconnects it and everything that inherited it.
    updateMeta(parentDoc, { relay: null }, SYSTEM_ORIGIN)
    await waitFor(() => !state(ids.parent) && !state(ids.child) && !state(ids.grand), 8000, 'manager disconnect')
    expect(useLibrary.getState().entries[ids.parent].relay).toBeNull()
    other.conn.stop()
  })
})
