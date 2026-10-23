import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { RangeSet, RelayCoverage, exceeds, mergeStateVectors } from './coverage'

describe('RangeSet', () => {
  it('merges overlapping and touching intervals', () => {
    const r = new RangeSet()
    r.add(10, 20)
    r.add(30, 40)
    expect(r.toArray()).toEqual([
      [10, 20],
      [30, 40],
    ])
    r.add(20, 30)
    expect(r.toArray()).toEqual([[10, 40]])
    r.add(0, 5)
    r.add(50, 60)
    r.add(4, 55)
    expect(r.toArray()).toEqual([[0, 60]])
    r.add(5, 5)
    expect(r.size).toBe(1)
  })

  it('answers coverage queries', () => {
    const r = new RangeSet()
    r.add(0, 10)
    r.add(20, 30)
    expect(r.covers(0, 10)).toBe(true)
    expect(r.covers(2, 3)).toBe(true)
    expect(r.covers(9, 11)).toBe(false)
    expect(r.covers(10, 20)).toBe(false)
    expect(r.covers(20, 30)).toBe(true)
    expect(r.covers(25, 31)).toBe(false)
    expect(r.covers(5, 5)).toBe(true)
    expect(r.prefixEnd()).toBe(10)
    const s = new RangeSet()
    s.add(3, 9)
    expect(s.prefixEnd()).toBe(0)
  })
})

function collect(doc: Y.Doc): Uint8Array[] {
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  return out
}

describe('RelayCoverage', () => {
  it('knows which updates the relay already has', () => {
    const a = new Y.Doc()
    const updates = collect(a)
    a.getMap('m').set('x', 1)
    a.getMap('m').set('y', 2)
    a.getArray('arr').insert(0, ['a', 'b', 'c'])
    const cov = new RelayCoverage()
    cov.add(updates[0])
    expect(cov.covers(updates[0])).toBe(true)
    expect(cov.covers(updates[1])).toBe(false)
    cov.add(updates[1])
    cov.add(updates[2])
    expect(cov.covers(Y.mergeUpdates(updates))).toBe(true)
    expect(cov.stateVector()).toEqual(Y.decodeStateVector(Y.encodeStateVector(a)))
  })

  it('tracks deletions separately from inserts', () => {
    const a = new Y.Doc()
    const updates = collect(a)
    a.getArray<string>('arr').insert(0, ['a', 'b', 'c'])
    a.getArray<string>('arr').delete(1, 1)
    const cov = new RelayCoverage()
    cov.add(updates[0])
    // A pure deletion creates no new ids but is still news to the relay.
    expect(cov.covers(updates[1])).toBe(false)
    cov.add(updates[1])
    expect(cov.covers(updates[1])).toBe(true)
  })

  it('learns everything from a full-state snapshot', () => {
    const a = new Y.Doc()
    const updates = collect(a)
    for (let i = 0; i < 10; i++) a.getMap('m').set(`k${i}`, i)
    a.getMap('m').delete('k3')
    const cov = new RelayCoverage()
    cov.add(Y.encodeStateAsUpdate(a))
    for (const u of updates) expect(cov.covers(u)).toBe(true)
  })

  it('accepts remembered state vectors and ignores garbage', () => {
    const a = new Y.Doc()
    const updates = collect(a)
    a.getMap('m').set('x', 1)
    const cov = new RelayCoverage()
    cov.addStateVector(Y.decodeStateVector(Y.encodeStateVector(a)))
    expect(cov.covers(updates[0])).toBe(true)
    cov.add(new Uint8Array([1, 2, 3, 255]))
    expect(cov.covers(new Uint8Array([7, 7, 7]))).toBe(false)
    cov.clear()
    expect(cov.covers(updates[0])).toBe(false)
  })
})

describe('state vector helpers', () => {
  it('merges and compares', () => {
    const a = new Map([
      [1, 5],
      [2, 3],
    ])
    const b = new Map([
      [2, 7],
      [3, 1],
    ])
    expect(mergeStateVectors(a, b)).toEqual(
      new Map([
        [1, 5],
        [2, 7],
        [3, 1],
      ]),
    )
    expect(exceeds(a, b)).toBe(true)
    expect(exceeds(new Map([[2, 7]]), b)).toBe(false)
    expect(exceeds(new Map(), b)).toBe(false)
  })
})
