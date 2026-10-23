import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  columnChildren,
  createCard,
  deleteCards,
  getCards,
  insertIntoColumn,
  isTrashed,
  listTrash,
  readCard,
} from '../../model/board'
import { boundsTopLeft, groupableCards, groupIntoColumn, stackLayout, ungroupColumn, visualOrder } from './grouping'

const U = 'user1'
const doc = () => new Y.Doc({ guid: 'g1' })

describe('visualOrder', () => {
  it('sorts top to bottom, then left to right', () => {
    const items = [
      { id: 'c', x: 0, y: 300 },
      { id: 'b', x: 400, y: 10 },
      { id: 'a', x: 0, y: 10 },
      { id: 'd', x: -50, y: 120 },
    ]
    expect(visualOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'd', 'c'])
  })

  it('is stable for identical positions (by id) and does not mutate the input', () => {
    const items = [
      { id: 'z', x: 0, y: 0 },
      { id: 'y', x: 0, y: 0 },
    ]
    expect(visualOrder(items).map((i) => i.id)).toEqual(['y', 'z'])
    expect(items[0].id).toBe('z')
  })
})

describe('groupIntoColumn', () => {
  it('creates a column at the top-left of the bounds with children in visual order', () => {
    const d = doc()
    const low = createCard(d, 'note', { x: 100, y: 400 }, U)
    const high = createCard(d, 'todo', { x: 300, y: 50 }, U)
    const mid = createCard(d, 'image', { x: 60, y: 200 }, U)
    const col = groupIntoColumn(d, [low, high, mid], U)!
    expect(col).toBeTruthy()
    const c = readCard(getCards(d).get(col)!)
    expect(c.type).toBe('column')
    expect({ x: c.x, y: c.y }).toEqual({ x: 60, y: 50 })
    expect(columnChildren(d, col)).toEqual([high, mid, low])
  })

  it('ignores lines, columns and cards already in a column', () => {
    const d = doc()
    const existing = createCard(d, 'column', { x: 0, y: 0 }, U)
    const inside = createCard(d, 'note', { x: 0, y: 0 }, U)
    insertIntoColumn(d, [inside], existing, 0, U)
    const line = createCard(d, 'line', {}, U)
    const free = createCard(d, 'note', { x: 500, y: 500 }, U)
    expect(groupableCards(d, [existing, inside, line, free]).map((c) => c.id)).toEqual([free])
    const col = groupIntoColumn(d, [existing, inside, line, free], U)!
    expect(columnChildren(d, col)).toEqual([free])
    expect(columnChildren(d, existing)).toEqual([inside])
  })

  it('returns null when nothing can be grouped', () => {
    const d = doc()
    const line = createCard(d, 'line', {}, U)
    expect(groupIntoColumn(d, [line, 'missing'], U)).toBeNull()
    expect(getCards(d).size).toBe(1)
  })

  it('is a single undo step', () => {
    const d = doc()
    const a = createCard(d, 'note', { x: 0, y: 0 }, U)
    const b = createCard(d, 'note', { x: 0, y: 200 }, U)
    const undo = new Y.UndoManager(getCards(d), { trackedOrigins: new Set(['local-canvas']) })
    groupIntoColumn(d, [a, b], U)
    expect(getCards(d).size).toBe(3)
    undo.undo()
    expect(getCards(d).size).toBe(2)
    expect(readCard(getCards(d).get(a)!).parent).toBeNull()
  })
})

describe('ungroupColumn', () => {
  it('stacks children from the column top-left when they are not rendered', () => {
    const d = doc()
    const col = createCard(d, 'column', { x: 100, y: 100 }, U)
    const a = createCard(d, 'note', {}, U)
    const b = createCard(d, 'swatch', {}, U)
    insertIntoColumn(d, [a, b], col, 0, U)
    const out = ungroupColumn(d, col, U)
    expect(out).toEqual([a, b])
    expect(isTrashed(getCards(d).get(col)!)).toBe(true)
    // The emptied column is hidden, not listed in the trash.
    expect(listTrash(d)).toEqual([])
    const ca = readCard(getCards(d).get(a)!)
    const cb = readCard(getCards(d).get(b)!)
    expect(ca.parent).toBeNull()
    expect(cb.parent).toBeNull()
    expect({ x: ca.x, y: ca.y }).toEqual({ x: 100, y: 100 })
    // note has no stored height -> 100 fallback + 20 gap
    expect({ x: cb.x, y: cb.y }).toEqual({ x: 100, y: 220 })
  })

  it('keeps children where they appear when every child is measured', () => {
    const d = doc()
    const col = createCard(d, 'column', { x: 0, y: 0 }, U)
    const a = createCard(d, 'note', {}, U)
    insertIntoColumn(d, [a], col, 0, U)
    ungroupColumn(d, col, U, (id) => (id === a ? { x: 12, y: 48, w: 300, h: 80 } : null))
    const ca = readCard(getCards(d).get(a)!)
    expect({ x: ca.x, y: ca.y }).toEqual({ x: 10, y: 50 })
  })

  it('turns lines attached to the column into free ends', () => {
    const d = doc()
    const col = createCard(d, 'column', { x: 0, y: 0, w: 320 }, U)
    const other = createCard(d, 'note', { x: 900, y: 0 }, U)
    const line = createCard(d, 'line', { from: { card: col, x: 0, y: 0 }, to: { card: other, x: 900, y: 0 } }, U)
    ungroupColumn(d, col, U)
    const l = readCard(getCards(d).get(line)!)
    expect(l.type).toBe('line')
    if (l.type !== 'line') return
    expect(l.from).toEqual({ card: null, x: 160, y: 0 })
    expect(l.to.card).toBe(other)
  })

  it('ignores non-columns and trashed columns', () => {
    const d = doc()
    const n = createCard(d, 'note', {}, U)
    expect(ungroupColumn(d, n, U)).toEqual([])
    expect(isTrashed(getCards(d).get(n)!)).toBe(false)
    const col = createCard(d, 'column', {}, U)
    deleteCards(d, [col], U)
    expect(ungroupColumn(d, col, U)).toEqual([])
  })

  it('ignores trashed cards when grouping', () => {
    const d = doc()
    const a = createCard(d, 'note', { x: 0, y: 0 }, U)
    const b = createCard(d, 'note', { x: 0, y: 100 }, U)
    deleteCards(d, [b], U)
    expect(groupableCards(d, [a, b]).map((c) => c.id)).toEqual([a])
  })
})

describe('layout helpers', () => {
  it('stackLayout snaps and spaces items', () => {
    expect(stackLayout({ x: 13, y: 7 }, [{ id: 'a', h: 55 }, { id: 'b', h: 30 }], 20)).toEqual({
      a: { x: 10, y: 10 },
      b: { x: 10, y: 80 },
    })
  })

  it('boundsTopLeft skips column children and uses line points', () => {
    const d = doc()
    const a = createCard(d, 'note', { x: 50, y: 80 }, U)
    const l = createCard(d, 'line', { from: { card: null, x: 10, y: 300 }, to: { card: null, x: 400, y: 90 } }, U)
    const cards = [a, l].map((id) => readCard(getCards(d).get(id)!))
    expect(boundsTopLeft(cards)).toEqual({ x: 10, y: 80 })
    expect(boundsTopLeft([])).toBeNull()
  })
})
