import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness'
import {
  MSG_AWARENESS,
  MSG_AWARENESS_RELAY,
  MSG_PEERS,
  MSG_HELLO,
  MSG_SYNC,
  MSG_WANT,
  PROTOCOL_VERSION,
  decodeBlobReply,
  decodeHeader,
  encodeAwareness,
  encodeAwarenessRelay,
  encodePeers,
  filterAwarenessUpdate,
  readPeers,
  encodeBlobHeader,
  encodeHello,
  encodeSyncStep1,
  encodeUpdate,
  encodeWant,
  isCompatible,
  readAwarenessEntries,
  readHello,
  sanitizeMime,
} from './protocol'

describe('message framing', () => {
  it('round-trips every message type', () => {
    const doc = new Y.Doc()
    doc.getMap('cards').set('a', 1)
    const s1 = decodeHeader(encodeSyncStep1('board123', doc))!
    expect(s1).toMatchObject({ type: MSG_SYNC, docId: 'board123' })
    expect(decoding.readVarUint(s1.decoder)).toBe(syncProtocol.messageYjsSyncStep1)

    const up = decodeHeader(encodeUpdate('board123', Y.encodeStateAsUpdate(doc)))!
    expect(up.type).toBe(MSG_SYNC)
    expect(decoding.readVarUint(up.decoder)).toBe(syncProtocol.messageYjsUpdate)

    expect(decodeHeader(encodeWant('board123'))).toMatchObject({ type: MSG_WANT, docId: 'board123' })

    const aw = new Awareness(doc)
    aw.setLocalState({ user: { name: 'A' } })
    const a = decodeHeader(encodeAwareness('board123', encodeAwarenessUpdate(aw, [aw.clientID])))!
    expect(a.type).toBe(MSG_AWARENESS)
    expect(readAwarenessEntries(decoding.readVarUint8Array(a.decoder))).toEqual([{ clientID: aw.clientID, clock: 1, removed: false }])
    aw.destroy()

    const h = decodeHeader(encodeHello())!
    expect(h).toMatchObject({ type: MSG_HELLO, docId: '' })
    const hello = readHello(h.decoder)!
    expect(hello.v).toBe(PROTOCOL_VERSION)
    expect(isCompatible(hello)).toBe(true)
    expect(isCompatible({ ...hello, v: PROTOCOL_VERSION + 1 })).toBe(false)
  })

  it('rejects malformed and unknown messages instead of throwing', () => {
    expect(decodeHeader(new Uint8Array([]))).toBeNull()
    expect(decodeHeader(new Uint8Array([0]))).toBeNull()
    expect(decodeHeader(new Uint8Array([0, 200, 1]))).toBeNull() // string longer than the buffer
    const unknown = encoding.createEncoder()
    encoding.writeVarUint(unknown, 42)
    encoding.writeVarString(unknown, 'board123')
    expect(decodeHeader(encoding.toUint8Array(unknown))).toBeNull()
    const longId = encoding.createEncoder()
    encoding.writeVarUint(longId, MSG_SYNC)
    encoding.writeVarString(longId, 'x'.repeat(65))
    expect(decodeHeader(encoding.toUint8Array(longId))).toBeNull()
    // SYNC must name a doc, HELLO must not.
    expect(decodeHeader(encodeWant(''))).toBeNull()
    const helloWithDoc = encoding.createEncoder()
    encoding.writeVarUint(helloWithDoc, MSG_HELLO)
    encoding.writeVarString(helloWithDoc, 'board123')
    expect(decodeHeader(encoding.toUint8Array(helloWithDoc))).toBeNull()
    expect(decodeHeader('nope' as unknown as Uint8Array)).toBeNull()
  })

  it('validates HELLO payloads', () => {
    const bad = (json: string) => {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, MSG_HELLO)
      encoding.writeVarString(e, '')
      encoding.writeVarString(e, json)
      return readHello(decodeHeader(encoding.toUint8Array(e))!.decoder)
    }
    expect(bad('not json')).toBeNull()
    expect(bad('{"v":"1"}')).toBeNull()
    expect(bad('{"v":1.5}')).toBeNull()
    expect(bad('{"v":1,"app":7}')).toEqual({ v: 1, m: 0, app: '' })
  })

  it('parses awareness removals and rejects garbage', () => {
    const doc = new Y.Doc()
    const aw = new Awareness(doc)
    aw.setLocalState(null)
    expect(readAwarenessEntries(encodeAwarenessUpdate(aw, [aw.clientID]))).toEqual([{ clientID: aw.clientID, clock: 1, removed: true }])
    expect(readAwarenessEntries(new Uint8Array([5, 1]))).toBeNull()
    aw.destroy()
  })
})

describe('blob replies', () => {
  it('round-trips the envelope', () => {
    const header = encodeBlobHeader('image/png')
    const body = new Uint8Array([1, 2, 3])
    const wire = new Uint8Array([...header, ...body])
    expect(decodeBlobReply(wire)).toEqual({ mime: 'image/png', bytes: body })
    expect(decodeBlobReply(new Uint8Array([9, 0]))).toBeNull()
  })

  it('neutralises mime types that could run as a page', () => {
    expect(sanitizeMime('image/png')).toBe('image/png')
    expect(sanitizeMime('IMAGE/JPEG; charset=x')).toBe('image/jpeg')
    expect(sanitizeMime('text/html')).toBe('application/octet-stream')
    expect(sanitizeMime('application/javascript')).toBe('application/octet-stream')
    expect(sanitizeMime('image/svg+xml')).toBe('image/svg+xml')
    expect(sanitizeMime(42)).toBe('application/octet-stream')
  })
})

describe('peer lists and relayed presence', () => {
  it('round-trips PEERS and bounds it', () => {
    const msg = decodeHeader(encodePeers(['alice', 'bob', '', 'x'.repeat(65)]))!
    expect(msg).toMatchObject({ type: MSG_PEERS, docId: '' })
    expect([...readPeers(msg.decoder)!]).toEqual(['alice', 'bob'])
    const withDoc = encoding.createEncoder()
    encoding.writeVarUint(withDoc, MSG_PEERS)
    encoding.writeVarString(withDoc, 'board123')
    expect(decodeHeader(encoding.toUint8Array(withDoc))).toBeNull()
    const huge = encoding.createEncoder()
    encoding.writeVarUint(huge, 100_000)
    expect(readPeers(decoding.createDecoder(encoding.toUint8Array(huge)))).toBeNull()
    expect(decodeHeader(encodeAwarenessRelay('board123', new Uint8Array([0])))).toMatchObject({ type: MSG_AWARENESS_RELAY })
  })

  it('filters awareness entries', () => {
    const a = new Awareness(new Y.Doc())
    const b = new Awareness(new Y.Doc())
    a.setLocalState({ user: { name: 'A' } })
    b.setLocalState({ user: { name: 'B' } })
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 2)
    for (const aw of [a, b]) {
      encoding.writeVarUint(e, aw.clientID)
      encoding.writeVarUint(e, 1)
      encoding.writeVarString(e, JSON.stringify(aw.getLocalState()))
    }
    const both = encoding.toUint8Array(e)
    const onlyB = filterAwarenessUpdate(both, (x) => x.clientID === b.clientID)!
    expect(readAwarenessEntries(onlyB)).toEqual([{ clientID: b.clientID, clock: 1, removed: false }])
    expect(filterAwarenessUpdate(both, () => false)).toBeNull()
    expect(filterAwarenessUpdate(new Uint8Array([5, 1]), () => true)).toBeNull()
    a.destroy()
    b.destroy()
  })
})
