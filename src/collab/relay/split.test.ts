import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { splitUpdate } from './split'

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function shuffle<T>(list: T[], rand: () => number): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** A board-like doc edited by several "sessions" (client ids), with nested types, text and deletions. */
function busyDoc(rand: () => number): Y.Doc {
  const doc = new Y.Doc()
  for (let session = 0; session < 6; session++) {
    const editor = new Y.Doc()
    Y.applyUpdate(editor, Y.encodeStateAsUpdate(doc))
    const cards = editor.getMap<Y.Map<unknown>>('cards')
    for (let i = 0; i < 40; i++) {
      const id = `card-${session}-${i}`
      const card = new Y.Map<unknown>()
      card.set('x', Math.floor(rand() * 1000))
      card.set('y', Math.floor(rand() * 1000))
      const text = new Y.XmlFragment()
      card.set('text', text)
      cards.set(id, card)
      const p = new Y.XmlElement('paragraph')
      text.insert(0, [p])
      p.insert(0, [new Y.XmlText(`note ${id} `.repeat(1 + Math.floor(rand() * 20)))])
    }
    const log = editor.getText('log')
    for (let i = 0; i < 30; i++) log.insert(Math.floor(rand() * (log.length + 1)), `entry ${session}/${i};`, rand() < 0.3 ? { bold: true } : undefined)
    // Deletions of other sessions' content.
    const keys = Array.from(cards.keys())
    for (let i = 0; i < 10 && keys.length; i++) cards.delete(keys[Math.floor(rand() * keys.length)])
    if (log.length > 20) log.delete(Math.floor(rand() * (log.length - 10)), 10)
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(editor, Y.encodeStateVector(doc)))
  }
  return doc
}

const snapshotOf = (doc: Y.Doc) => ({
  cards: doc.getMap('cards').toJSON(),
  log: doc.getText('log').toDelta(),
  sv: Array.from(Y.decodeStateVector(Y.encodeStateVector(doc)).entries()).sort((a, b) => a[0] - b[0]),
})

function applyAll(pieces: Uint8Array[], rand: () => number): Y.Doc {
  const doc = new Y.Doc()
  for (const p of shuffle(pieces, rand)) Y.applyUpdate(doc, p)
  return doc
}

describe('splitUpdate', () => {
  it('returns small updates unchanged', () => {
    const doc = new Y.Doc()
    doc.getMap('m').set('a', 1)
    const u = Y.encodeStateAsUpdate(doc)
    expect(splitUpdate(u, u.length)[0]).toBe(u)
  })

  it('cuts a big update into pieces under the limit that rebuild the same doc in any order', () => {
    const rand = rng(1)
    const doc = busyDoc(rand)
    expect(Y.decodeStateVector(Y.encodeStateVector(doc)).size).toBe(6)
    const full = Y.encodeStateAsUpdate(doc)
    for (const max of [4096, 20_000, Math.floor(full.length / 2)]) {
      const pieces = splitUpdate(full, max)
      expect(pieces.length).toBeGreaterThan(1)
      for (const p of pieces) expect(p.length).toBeLessThanOrEqual(max)
      for (let round = 0; round < 3; round++) {
        const copy = applyAll(pieces, rand)
        expect(snapshotOf(copy)).toEqual(snapshotOf(doc))
        // Nothing left pending: every dependency arrived.
        expect(copy.store.pendingStructs).toBeNull()
        expect(copy.store.pendingDs).toBeNull()
      }
    }
  })

  it('handles updates with holes (merged, non-contiguous updates)', () => {
    const doc = new Y.Doc()
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    const t = doc.getText('t')
    for (let i = 0; i < 60; i++) {
      t.insert(t.length, `chunk ${i} ${'x'.repeat(200)}`)
      if (i % 7 === 0) t.delete(0, 5)
    }
    // Leave out every third update: the merge has gaps (Skip structs) for those clocks.
    const kept = updates.filter((_, i) => i % 3 !== 1)
    const missing = updates.filter((_, i) => i % 3 === 1)
    const merged = Y.mergeUpdates(kept)
    expect(Y.decodeUpdate(merged).structs.some((s) => s instanceof Y.Skip)).toBe(true)
    const pieces = splitUpdate(merged, 1500)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(1500)
    const copy = applyAll([...pieces, ...missing], rng(2))
    expect(copy.getText('t').toString()).toBe(t.toString())
  })

  it('moves a large delete set into pieces of its own', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<number>('a')
    for (let i = 0; i < 3000; i++) arr.push([i])
    // Many separate deletions -> many delete-set ranges.
    doc.transact(() => {
      for (let i = arr.length - 2; i >= 0; i -= 2) arr.delete(i, 1)
    })
    const full = Y.encodeStateAsUpdate(doc)
    const pieces = splitUpdate(full, 2000)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(2000)
    const deleteOnly = pieces.filter((p) => Y.decodeUpdate(p).structs.length === 0)
    expect(deleteOnly.length).toBeGreaterThan(0)
    const copy = applyAll(pieces, rng(3))
    expect(copy.getArray('a').toArray()).toEqual(arr.toArray())
  })

  it('returns a struct that cannot be cut as its own oversized piece', () => {
    const doc = new Y.Doc()
    doc.getMap('m').set('small', 'a')
    doc.getText('huge').insert(0, 'y'.repeat(50_000))
    doc.getMap('m').set('after', 'b')
    const full = Y.encodeStateAsUpdate(doc)
    const pieces = splitUpdate(full, 10_000)
    const oversized = pieces.filter((p) => p.length > 10_000)
    expect(oversized).toHaveLength(1)
    expect(pieces.length).toBeGreaterThan(1)
    const copy = applyAll(pieces, rng(4))
    expect(copy.getText('huge').length).toBe(50_000)
    expect(copy.getMap('m').toJSON()).toEqual({ small: 'a', after: 'b' })
  })
})
