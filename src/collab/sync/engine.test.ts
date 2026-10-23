import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, initBoardDoc, updateMeta } from '../../model/board'
import { newBoardId, newSecret } from '../../model/ids'
import { deriveRoomId } from '../crypto'
import { MemoryHub } from './memory'
import * as encoding from 'lib0/encoding'
import { MSG_AWARENESS_RELAY, MSG_SYNC, decodeHeader, encodeAwareness, encodeHello, encodeSyncStep1, encodeUpdate, encodeWant } from './protocol'
import { cardIds, converged, makeDevice, sleep, waitFor, type TestDevice } from './testkit'
import type { BlobReply } from './transport'

const devices: TestDevice[] = []

function device(hub: MemoryHub, name: string, opts: Parameters<typeof makeDevice>[2] = {}) {
  const d = makeDevice(hub, name, opts)
  devices.push(d)
  return d
}

afterEach(async () => {
  for (const d of devices.splice(0)) {
    d.presence.releaseAll()
    await d.engine.stop()
  }
})

function board(d: TestDevice, id: string, title: string): Y.Doc {
  const doc = d.docs.doc(id)
  initBoardDoc(doc, { id, title }, d.name)
  return doc
}

function nest(parent: Y.Doc, childId: string, secret: string, who: string) {
  return createCard(parent, 'board', { boardId: childId, secret, title: 'Child' }, who)
}

/** A hand-driven peer, for playing an attacker or an outdated app. */
async function rawPeer(hub: MemoryHub, secret: string, name: string) {
  const roomId = await deriveRoomId(secret)
  const t = hub.transport(roomId, name)
  const received: { from: string; type: number; docId: string }[] = []
  const joined = new Set<string>()
  let onBlob: (hash: string, peer: string) => Promise<BlobReply | null> = async () => null
  const blobRequests: string[] = []
  t.connect({
    onPeerJoin: (p) => joined.add(p),
    onPeerLeave: (p) => joined.delete(p),
    onMessage: (data, from) => {
      const h = decodeHeader(data)
      if (h) received.push({ from, type: h.type, docId: h.docId })
    },
    onBlobRequest: (hash, peer) => {
      blobRequests.push(hash)
      return onBlob(hash, peer)
    },
  })
  return {
    t,
    received,
    joined,
    blobRequests,
    setBlobHandler: (f: typeof onBlob) => {
      onBlob = f
    },
    send: (to: string, bytes: Uint8Array) => t.send(bytes, [to]),
    syncFor: (docId: string) => received.filter((m) => m.type === MSG_SYNC && m.docId === docId),
  }
}

describe('SyncEngine', () => {
  it('syncs several shared boards both ways, including offline edits after reconnect', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b1 = newBoardId()
    const b2 = newBoardId()
    const s1 = newSecret()
    const s2 = newSecret()
    const a1 = board(alice, b1, 'Board one')
    createCard(a1, 'note', { x: 10 }, 'alice')
    const bb2 = board(bob, b2, 'Board two')
    createCard(bb2, 'swatch', { x: 20 }, 'bob')
    for (const d of [alice, bob]) {
      d.library.set(b1, s1, true)
      d.library.set(b2, s2, true)
      d.engine.start()
    }

    await waitFor(() => converged(alice.docs.peek(b1), bob.docs.peek(b1)) && converged(alice.docs.peek(b2), bob.docs.peek(b2)), 'initial sync')
    expect(cardIds(bob.docs.peek(b1))).toHaveLength(1)
    expect(cardIds(alice.docs.peek(b2))).toHaveLength(1)

    // Live edits travel both ways.
    createCard(bob.docs.peek(b1)!, 'todo', {}, 'bob')
    await waitFor(() => cardIds(alice.docs.peek(b1)).length === 2, 'live edit')

    // Offline: both keep editing, then merge on reconnect.
    hub.setOffline('bob', true)
    await waitFor(() => alice.engine.inspect().rooms.every((r) => r.peers.length === 0), 'disconnect noticed')
    createCard(alice.docs.peek(b1)!, 'note', { x: 1 }, 'alice')
    createCard(alice.docs.peek(b2)!, 'note', { x: 2 }, 'alice')
    createCard(bob.docs.peek(b1)!, 'note', { x: 3 }, 'bob')
    createCard(bob.docs.peek(b2)!, 'note', { x: 4 }, 'bob')
    await sleep(30)
    expect(cardIds(alice.docs.peek(b1))).toHaveLength(3)
    hub.setOffline('bob', false)

    await waitFor(() => converged(alice.docs.peek(b1), bob.docs.peek(b1)) && converged(alice.docs.peek(b2), bob.docs.peek(b2)), 'merge after reconnect')
    expect(cardIds(alice.docs.peek(b1))).toHaveLength(4)
    expect(cardIds(bob.docs.peek(b2))).toHaveLength(3)
    expect(alice.store.getState().boards[b1].peers).toBe(1)
  })

  it('discovers nested boards through board cards and keeps syncing them', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const root = newBoardId()
    const child = newBoardId()
    const grandchild = newBoardId()
    const sRoot = newSecret()
    const sChild = newSecret()
    const sGrand = newSecret()
    const r = board(alice, root, 'Root')
    const c = board(alice, child, 'Child')
    nest(r, child, sChild, 'alice')
    createCard(c, 'note', {}, 'alice')
    alice.library.set(root, sRoot, true)
    alice.library.set(child, sChild, false)
    // Bob was only invited to the root.
    bob.library.set(root, sRoot, true)
    alice.engine.start()
    bob.engine.start()

    await waitFor(() => converged(alice.docs.peek(child), bob.docs.peek(child)), 'child synced')
    expect(cardIds(bob.docs.peek(child))).toHaveLength(1)
    expect(bob.engine.inspect().rooms[0].scope).toEqual([root, child].sort())

    // A board created later, two levels down, is picked up as well.
    const g = board(alice, grandchild, 'Grandchild')
    createCard(g, 'swatch', {}, 'alice')
    nest(alice.docs.peek(child)!, grandchild, sGrand, 'alice')
    await waitFor(() => converged(alice.docs.peek(grandchild), bob.docs.peek(grandchild)), 'grandchild synced')
    expect(cardIds(bob.docs.peek(grandchild))).toHaveLength(1)

    // Edits inside the nested board keep flowing.
    createCard(bob.docs.peek(grandchild)!, 'note', {}, 'bob')
    await waitFor(() => cardIds(alice.docs.peek(grandchild)).length === 2, 'edit in nested board')
    expect(bob.store.getState().boards[grandchild]).toMatchObject({ peers: 1, active: true })
  })

  it('never gives a peer of a nested board access to its parent', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const eve = device(hub, 'eve')
    const parent = newBoardId()
    const child = newBoardId()
    const sParent = newSecret()
    const sChild = newSecret()
    const p = board(alice, parent, 'Parent')
    createCard(p, 'note', {}, 'alice')
    const c = board(alice, child, 'Child')
    createCard(c, 'note', {}, 'alice')
    nest(p, child, sChild, 'alice')
    // The child was shared on its own (invite link), so its meta says so.
    updateMeta(c, { shared: true })
    alice.library.set(parent, sParent, true)
    alice.library.set(child, sChild, false)
    eve.library.set(child, sChild, true)
    alice.engine.start()
    eve.engine.start()

    // Alice serves the child's own room once she sees meta.shared.
    await waitFor(() => alice.library.entries.get(child)?.shared === true, 'child room opened')
    await waitFor(() => converged(alice.docs.peek(child), eve.docs.peek(child)), 'child synced to eve')
    expect(eve.docs.peek(parent)).toBeUndefined()

    // A hand-crafted client in the child's room asks for the parent directly.
    const mallory = await rawPeer(hub, sChild, 'mallory')
    await waitFor(() => mallory.joined.has('alice'), 'mallory connected')
    const probe = new Y.Doc()
    mallory.send('alice', encodeSyncStep1(parent, probe))
    mallory.send('alice', encodeWant(parent))
    mallory.send('alice', encodeSyncStep1(child, probe))
    await waitFor(() => mallory.syncFor(child).length > 0, 'reply for the child')
    await sleep(30)
    expect(mallory.syncFor(parent)).toHaveLength(0)

    // ...and tries to write into it.
    const evil = new Y.Doc()
    createCard(evil, 'note', { id: 'evilcard01' }, 'mallory')
    mallory.send('alice', encodeUpdate(parent, Y.encodeStateAsUpdate(evil)))
    await sleep(30)
    expect(cardIds(alice.docs.peek(parent))).not.toContain('evilcard01')

    // A board card naming the parent with a made-up secret does not pull it into the child's scope.
    const forged = new Y.Doc()
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(alice.docs.peek(child)!))
    createCard(forged, 'board', { boardId: parent, secret: newSecret() }, 'mallory')
    mallory.send('alice', encodeUpdate(child, Y.encodeStateAsUpdate(forged)))
    await waitFor(() => cardIds(alice.docs.peek(child)).length === 2, 'forged card applied to child')
    await sleep(40)
    const childRoom = alice.engine.inspect().rooms.find((r) => r.rootId === child)!
    expect(childRoom.scope).toEqual([child])
    mallory.send('alice', encodeSyncStep1(parent, probe))
    await sleep(30)
    expect(mallory.syncFor(parent)).toHaveLength(0)
    expect(eve.docs.peek(parent)).toBeUndefined()
  })

  it('keeps the Home board off the peer-to-peer network', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    const home = board(alice, 'home', 'Home')
    // Even a board card pointing at Home is not followed.
    createCard(alice.docs.peek(b)!, 'board', { boardId: 'home', secret: newSecret() }, 'alice')
    alice.library.set(b, s, true)
    alice.engine.start()
    const raw = await rawPeer(hub, s, 'raw')
    await waitFor(() => raw.joined.has('alice'), 'connected')
    raw.send('alice', encodeSyncStep1('home', new Y.Doc()))
    createCard(home, 'note', {}, 'alice')
    await sleep(40)
    expect(raw.received.some((m) => m.docId === 'home')).toBe(false)
    expect(alice.engine.inspect().seeded).toEqual([b])
  })

  it('removes presence of a peer that leaves', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced')
    const awA = alice.presence.acquire(b, alice.docs.peek(b)!)
    const awB = bob.presence.acquire(b, bob.docs.peek(b)!)
    awA.setLocalStateField('user', { name: 'Alice' })
    awB.setLocalStateField('user', { name: 'Bob' })
    await waitFor(() => awB.getStates().get(awA.clientID)?.user?.name === 'Alice', 'bob sees alice')
    await waitFor(() => awA.getStates().get(awB.clientID)?.user?.name === 'Bob', 'alice sees bob')

    // Throttled pointer moves still arrive, last one wins.
    for (let i = 0; i < 20; i++) awA.setLocalStateField('pointer', { x: i, y: i })
    await waitFor(() => awB.getStates().get(awA.clientID)?.pointer?.x === 19, 'latest pointer')

    // Presence from peers must be an object; other JSON values are dropped.
    const raw = await rawPeer(hub, s, 'raw')
    await waitFor(() => raw.joined.has('bob'), 'raw connected')
    for (const [id, json] of [
      [424242, '"just a string"'],
      [434343, '{"user":{"name":"Raw"}}'],
    ] as const) {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 1)
      encoding.writeVarUint(e, id)
      encoding.writeVarUint(e, 1)
      encoding.writeVarString(e, json)
      raw.send('bob', encodeAwareness(b, encoding.toUint8Array(e)))
    }
    await waitFor(() => awB.getStates().has(434343), 'valid raw presence applied')
    expect(awB.getStates().has(424242)).toBe(false)
    await raw.t.leave()
    await waitFor(() => !awB.getStates().has(434343), 'raw presence removed')

    hub.setOffline('alice', true)
    await waitFor(() => !awB.getStates().has(awA.clientID), 'presence removed on leave')

    // Closing a board tells others right away.
    hub.setOffline('alice', false)
    await waitFor(() => awB.getStates().has(awA.clientID), 'presence back after reconnect')
    alice.presence.release(b)
    await waitFor(() => !awB.getStates().has(awA.clientID), 'presence removed on close')
  })

  it('fetches blobs from peers and rejects bytes that do not match the hash', async () => {
    const hub = new MemoryHub()
    const b = newBoardId()
    const s = newSecret()
    // Mallory is in the room first, so Bob asks her first.
    const mallory = await rawPeer(hub, s, 'mallory')
    mallory.setBlobHandler(async () => ({ mime: 'image/png', data: new Uint8Array([6, 6, 6]) }))
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const shared = board(alice, b, 'Shared')
    const bytes = new Uint8Array(70_000).map((_, i) => (i * 7) % 251)
    const hash = await alice.blobs.put(bytes, 'image/png')
    createCard(shared, 'image', { blob: hash, mime: 'image/png', name: 'a.png' }, 'alice')
    alice.library.set(b, s, true)
    bob.library.set(b, s, true)
    alice.engine.start()
    await waitFor(() => mallory.joined.has('alice'), 'alice in room')
    bob.engine.start()
    await waitFor(() => bob.engine.inspect().rooms[0]?.peers.length === 2, 'bob sees both')

    const got = await bob.blobs.fetch(hash, b)
    expect(mallory.blobRequests).toContain(hash)
    expect(got).not.toBeNull()
    expect(new Uint8Array(await got!.arrayBuffer())).toEqual(bytes)
    expect(got!.type).toBe('image/png')

    // Only the liar left: nothing is accepted.
    const other = await alice.blobs.put(new Uint8Array([1, 2, 3, 4]), 'text/html')
    createCard(shared, 'file', { blob: other, mime: 'text/html', name: 'page.html', size: 4 }, 'alice')
    await waitFor(() => cardIds(bob.docs.peek(b)).length === 2, 'file card synced')
    hub.setOffline('alice', true)
    await waitFor(() => bob.engine.inspect().rooms[0].peers.length === 1, 'alice gone')
    expect(await bob.blobs.fetch(other, b)).toBeNull()

    // Peer-provided mime types that could run as a page are neutralised.
    hub.setOffline('alice', false)
    await waitFor(() => bob.engine.inspect().rooms[0].peers.length === 2, 'alice back')
    const html = await bob.blobs.fetch(other, b)
    expect(html?.type).toBe('application/octet-stream')
  })

  it('ignores peers speaking another protocol version and reports it', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    alice.library.set(b, s, true)
    alice.engine.start()
    const old = await rawPeer(hub, s, 'old')
    await waitFor(() => old.joined.has('alice'), 'connected')
    old.send('alice', encodeHello({ v: 99, m: 0, app: '9.0.0' }))
    const other = new Y.Doc()
    createCard(other, 'note', { id: 'fromfuture' }, 'old')
    old.send('alice', encodeUpdate(b, Y.encodeStateAsUpdate(other)))
    await waitFor(() => alice.store.getState().problem !== null, 'problem reported')
    expect(alice.store.getState().problem).toMatch(/different version/)
    const before = old.received.length
    old.send('alice', encodeSyncStep1(b, new Y.Doc()))
    await sleep(30)
    expect(old.received.length).toBe(before)
    expect(cardIds(alice.docs.peek(b))).not.toContain('fromfuture')
    expect(alice.store.getState().boards[b].peers).toBe(0)

    await old.t.leave()
    await waitFor(() => alice.store.getState().problem === null, 'problem cleared')
  })

  it('caps room size and lets a waiting peer in when a slot frees up', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice', { maxPeersPerRoom: 1 })
    const bob = device(hub, 'bob')
    const carol = device(hub, 'carol')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    createCard(alice.docs.peek(b)!, 'note', {}, 'alice')
    alice.library.set(b, s, true)
    alice.engine.start()
    bob.library.set(b, s, true)
    bob.engine.start()
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'bob synced')
    carol.library.set(b, s, true)
    carol.engine.start()
    await waitFor(() => alice.store.getState().problem !== null, 'room full reported')
    expect(alice.store.getState().problem).toMatch(/limit 30/)
    // Carol still gets the board through Bob.
    await waitFor(() => converged(alice.docs.peek(b), carol.docs.peek(b)), 'carol synced via bob')

    hub.setOffline('bob', true)
    await waitFor(() => alice.store.getState().problem === null, 'slot freed')
    createCard(alice.docs.peek(b)!, 'note', {}, 'alice')
    await waitFor(() => converged(alice.docs.peek(b), carol.docs.peek(b)), 'carol promoted')
  })

  it('repairs lost messages with anti-entropy', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced')
    hub.drop = (_room, from) => from === 'alice'
    createCard(alice.docs.peek(b)!, 'note', {}, 'alice')
    await sleep(30)
    expect(cardIds(bob.docs.peek(b))).toHaveLength(0)
    hub.drop = null
    bob.engine.antiEntropy()
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'repaired')
  })

  it('leaves rooms whose board is no longer shared', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => bob.store.getState().boards[b]?.peers === 1, 'connected')
    bob.library.remove(b)
    await waitFor(() => alice.store.getState().boards[b]?.peers === 0, 'bob left')
    expect(bob.engine.inspect().rooms).toHaveLength(0)
    await waitFor(() => bob.engine.inspect().seeded.length === 0, 'docs released')
    createCard(alice.docs.peek(b)!, 'note', {}, 'alice')
    await sleep(30)
    expect(cardIds(bob.docs.peek(b))).toHaveLength(0)
  })

  it('turns peer-to-peer off and on', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob', { p2pEnabled: false })
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await sleep(30)
    expect(hub.peersIn(await deriveRoomId(s))).toEqual(['alice'])
    expect(bob.store.getState().boards[b]).toEqual({ peers: 0, active: false, lastSyncAt: 0 })
    bob.engine.setP2PEnabled(true)
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced after enabling')
    expect(bob.store.getState().boards[b].lastSyncAt).toBeGreaterThan(0)
  })

  it('reports peers that cannot connect directly (TURN hint)', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice', { turnGraceMs: 10 })
    const b = newBoardId()
    const s = newSecret()
    alice.library.set(b, s, true)
    alice.engine.start()
    const roomId = await deriveRoomId(s)
    await waitFor(() => alice.transports.has(roomId), 'joined')
    alice.transports.get(roomId)!.handlers!.onConnectFailure!('stranger')
    await waitFor(() => alice.store.getState().problem !== null, 'turn problem')
    expect(alice.store.getState().problem).toMatch(/TURN/)
    // The same peer making it through later clears the hint.
    const stranger = await rawPeer(hub, s, 'stranger')
    await waitFor(() => stranger.joined.has('alice'), 'stranger connected')
    await waitFor(() => alice.store.getState().problem === null, 'cleared')
  })

  it('reconnects every room when network settings change', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced')
    const first = bob.transports.get(await deriveRoomId(s))
    await bob.engine.reconnectAll()
    await waitFor(() => bob.transports.get(alice.engine.inspect().rooms[0].roomId!) !== first, 'new transport')
    createCard(alice.docs.peek(b)!, 'note', {}, 'alice')
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced after reconnect')
  })

  it('never joins again before the previous transport has left', async () => {
    const hub = new MemoryHub()
    const events: string[] = []
    let n = 0
    const slow = device(hub, 'slow', {
      createTransport: ({ roomId }) => {
        const t = hub.transport(roomId, 'slow')
        const id = ++n
        events.push(`join${id}`)
        const leave = t.leave.bind(t)
        t.leave = async () => {
          await sleep(40)
          events.push(`left${id}`)
          await leave()
        }
        return t
      },
    })
    slow.library.set(newBoardId(), newSecret(), true)
    slow.engine.start()
    await waitFor(() => events.length === 1, 'first join')
    void slow.engine.reconnectAll()
    // A second settings change while the first rejoin is still waiting.
    void slow.engine.reconnectAll()
    await waitFor(() => events.includes('join2'), 'rejoined')
    await sleep(60)
    expect(events).toEqual(['join1', 'left1', 'join2'])
  })
})

describe('same-device sync (local transport)', () => {
  it('syncs Home and presence between tabs without any shared board', async () => {
    const hub = new MemoryHub()
    const tab1 = device(hub, 'tab1', { localTransport: hub.transport('local', 'tab:1'), p2pEnabled: false })
    const tab2 = device(hub, 'tab2', { localTransport: hub.transport('local', 'tab:2'), p2pEnabled: false })
    const home1 = board(tab1, 'home', 'Home')
    createCard(home1, 'note', {}, 'me')
    const home2 = tab2.docs.doc('home')
    tab1.engine.start()
    tab2.engine.start()
    await waitFor(() => converged(home1, home2), 'home synced between tabs')
    createCard(home2, 'todo', {}, 'me')
    await waitFor(() => cardIds(home1).length === 2, 'edit from tab 2')

    // A doc opened later in one tab catches up from the other.
    const b = newBoardId()
    const d1 = board(tab1, b, 'Private board')
    createCard(d1, 'swatch', {}, 'me')
    await sleep(20)
    const d2 = tab2.docs.doc(b)
    await waitFor(() => converged(d1, d2), 'late-opened doc')

    const aw1 = tab1.presence.acquire(b, d1)
    const aw2 = tab2.presence.acquire(b, d2)
    aw1.setLocalStateField('pointer', { x: 1, y: 2 })
    await waitFor(() => aw2.getStates().get(aw1.clientID)?.pointer?.y === 2, 'presence across tabs')
  })

  it('does not count our own other tabs as teammates', async () => {
    const hub = new MemoryHub()
    const b = newBoardId()
    const s = newSecret()
    const tabA = device(hub, 'p2p-a', { localTransport: hub.transport('local', 'tab:a') })
    const tabB = device(hub, 'p2p-b', { localTransport: hub.transport('local', 'tab:b') })
    const carol = device(hub, 'carol')
    board(carol, b, 'Shared')
    for (const d of [tabA, tabB, carol]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => tabA.engine.inspect().rooms[0]?.peers.length === 2, 'tab A sees tab B and carol over P2P')
    await waitFor(() => tabA.store.getState().boards[b]?.peers === 1 && tabB.store.getState().boards[b]?.peers === 1, 'only carol counted')
    expect(carol.store.getState().boards[b].peers).toBe(2)
  })

  it('relays updates received from peers to other tabs, but not tab edits back to peers twice', async () => {
    const hub = new MemoryHub()
    const b = newBoardId()
    const s = newSecret()
    const tab = device(hub, 'tab', { localTransport: hub.transport('local', 'tab:a') })
    const other = device(hub, 'other', { localTransport: hub.transport('local', 'tab:b'), p2pEnabled: false })
    const peer = device(hub, 'peer')
    board(peer, b, 'Shared')
    tab.library.set(b, s, true)
    peer.library.set(b, s, true)
    other.docs.doc(b)
    tab.engine.start()
    other.engine.start()
    peer.engine.start()
    await waitFor(() => converged(peer.docs.peek(b), tab.docs.peek(b)), 'tab synced from peer')
    await waitFor(() => converged(peer.docs.peek(b), other.docs.peek(b)), 'other tab synced through the local channel')
    createCard(peer.docs.peek(b)!, 'note', {}, 'peer')
    await waitFor(() => converged(peer.docs.peek(b), other.docs.peek(b)), 'live relay to other tab')
  })
})

describe('partial mesh, duplicate secrets, retries, blobs and presence', () => {
  it('relays edits and presence between peers that cannot connect directly', async () => {
    const hub = new MemoryHub()
    hub.block('alice', 'carol')
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const carol = device(hub, 'carol')
    const b = newBoardId()
    const s = newSecret()
    const a = board(alice, b, 'Shared')
    createCard(a, 'note', {}, 'alice')
    for (const d of [alice, bob, carol]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    // No anti-entropy in tests: only relaying through Bob can get Alice's board to Carol.
    await waitFor(() => converged(alice.docs.peek(b), carol.docs.peek(b)), 'carol synced through bob')
    createCard(alice.docs.peek(b)!, 'todo', {}, 'alice')
    await waitFor(() => cardIds(carol.docs.peek(b)).length === 2, 'live edit relayed to carol')
    createCard(carol.docs.peek(b)!, 'swatch', {}, 'carol')
    await waitFor(() => cardIds(alice.docs.peek(b)).length === 3, 'live edit relayed to alice')

    const awA = alice.presence.acquire(b, alice.docs.peek(b)!)
    const awC = carol.presence.acquire(b, carol.docs.peek(b)!)
    awA.setLocalStateField('user', { name: 'Alice' })
    awC.setLocalStateField('user', { name: 'Carol' })
    await waitFor(() => awC.getStates().get(awA.clientID)?.user?.name === 'Alice', 'carol sees alice')
    await waitFor(() => awA.getStates().get(awC.clientID)?.user?.name === 'Carol', 'alice sees carol')
    awA.setLocalStateField('pointer', { x: 7, y: 7 })
    await waitFor(() => awC.getStates().get(awA.clientID)?.pointer?.x === 7, 'pointer relayed')
    // Only Bob relays (to the two who cannot reach each other).
    const relayed = hub.log.filter(([, from, , bytes]) => from !== 'bob' && decodeHeader(bytes)?.type === MSG_AWARENESS_RELAY)
    expect(relayed).toHaveLength(0)
  })

  it('gives a room to only one of two boards with the same secret, preferring the trusted one', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const real = newBoardId()
    const s = newSecret()
    board(alice, real, 'Real')
    // A card planted in the shared board reused its secret under another id (which sorts first).
    alice.library.set('000000', s, true, false)
    alice.library.set(real, s, true)
    bob.library.set(real, s, true)
    alice.engine.start()
    bob.engine.start()
    await waitFor(() => alice.engine.inspect().rooms.some((r) => r.rootId === real && r.connected), 'real room joined')
    expect(alice.engine.inspect().rooms.map((r) => r.rootId)).toEqual([real])
    createCard(bob.docs.doc(real), 'note', {}, 'bob')
    await waitFor(() => converged(alice.docs.peek(real), bob.docs.peek(real)), 'real board syncs')

    // Another planted card with the same secret is not followed into the scope.
    const planted = newBoardId()
    createCard(alice.docs.peek(real)!, 'board', { boardId: planted, secret: s }, 'mallory')
    await sleep(40)
    expect(alice.engine.inspect().rooms[0].scope).toEqual([real])
  })

  it('retries joining a room that failed, and reports it meanwhile', async () => {
    const hub = new MemoryHub()
    let fail = 2
    const alice = device(hub, 'alice', {
      createTransport: ({ roomId }) => {
        if (fail-- > 0) throw new Error('chunk failed to load')
        return hub.transport(roomId, 'alice')
      },
    })
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(bob, b, 'Shared')
    createCard(bob.docs.peek(b)!, 'note', {}, 'bob')
    alice.library.set(b, s, true)
    bob.library.set(b, s, true)
    alice.engine.start()
    bob.engine.start()
    await waitFor(() => alice.status.active().includes('start'), 'start problem reported')
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced after retry')
    expect(alice.status.active()).not.toContain('start')
  })

  it('serves only files of boards in the room, and queues busy requests instead of refusing them', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const b = newBoardId()
    const s = newSecret()
    const doc = board(alice, b, 'Shared')
    const hashes: string[] = []
    for (let i = 0; i < 12; i++) {
      const h = await alice.blobs.put(new Uint8Array([i, 1, 2, 3]), 'image/png')
      createCard(doc, 'image', { blob: h, mime: 'image/png', name: `${i}.png` }, 'alice')
      hashes.push(h)
    }
    const unrelated = await alice.blobs.put(new Uint8Array([9, 9, 9]), 'image/png')
    alice.library.set(b, s, true)
    alice.engine.start()
    const raw = await rawPeer(hub, s, 'raw')
    await waitFor(() => raw.joined.has('alice'), 'connected')
    await waitFor(() => alice.engine.inspect().seeded.includes(b), 'seeded')
    await sleep(20)
    const all = await Promise.all(hashes.map((h) => raw.t.requestBlob(h, 'alice')))
    expect(all.every((r) => r !== null)).toBe(true)
    // A file on this device that no board of the room refers to.
    expect(await raw.t.requestBlob(unrelated, 'alice')).toBeNull()
  })

  it('never asks unrelated rooms for files of a board they do not carry', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    alice.library.set(b, s, true)
    alice.engine.start()
    const raw = await rawPeer(hub, s, 'raw')
    await waitFor(() => raw.joined.has('alice'), 'connected')
    await waitFor(() => alice.engine.inspect().rooms[0]?.scope.includes(b) === true, 'scope ready')
    const hash = '0'.repeat(64)
    expect(await alice.blobs.fetch(hash, newBoardId())).toBeNull()
    expect(await alice.blobs.fetch(hash, null)).toBeNull()
    expect(raw.blobRequests).toHaveLength(0)
    expect(await alice.blobs.fetch(hash, b)).toBeNull()
    expect(raw.blobRequests).toEqual([hash])
  })

  it('ignores presence a peer sends for our own client or with a forged clock for someone else', async () => {
    const hub = new MemoryHub()
    const alice = device(hub, 'alice')
    const bob = device(hub, 'bob')
    const b = newBoardId()
    const s = newSecret()
    board(alice, b, 'Shared')
    for (const d of [alice, bob]) {
      d.library.set(b, s, true)
      d.engine.start()
    }
    await waitFor(() => converged(alice.docs.peek(b), bob.docs.peek(b)), 'synced')
    const awA = alice.presence.acquire(b, alice.docs.peek(b)!)
    const awB = bob.presence.acquire(b, bob.docs.peek(b)!)
    awA.setLocalStateField('user', { name: 'Alice' })
    awB.setLocalStateField('user', { name: 'Bob' })
    await waitFor(() => awA.getStates().get(awB.clientID)?.user?.name === 'Bob', 'alice sees bob')
    const mallory = await rawPeer(hub, s, 'mallory')
    await waitFor(() => mallory.joined.has('alice'), 'mallory connected')
    const forged = (clientID: number, clock: number, name: string) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 1)
      encoding.writeVarUint(e, clientID)
      encoding.writeVarUint(e, clock)
      encoding.writeVarString(e, JSON.stringify({ user: { name } }))
      return encodeAwareness(b, encoding.toUint8Array(e))
    }
    mallory.send('alice', forged(awA.clientID, 1_000_000, 'Boss'))
    mallory.send('alice', forged(awB.clientID, 1_000_000, 'Not Bob'))
    await sleep(40)
    expect(awA.getLocalState()?.user?.name).toBe('Alice')
    expect(awA.getStates().get(awB.clientID)?.user?.name).toBe('Bob')
    // Bob's real updates keep arriving.
    awB.setLocalStateField('pointer', { x: 3, y: 4 })
    await waitFor(() => awA.getStates().get(awB.clientID)?.pointer?.y === 4, 'bob still live')
  })
})
