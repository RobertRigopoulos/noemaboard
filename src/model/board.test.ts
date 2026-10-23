import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  bringForward,
  bringToFront,
  cardsToPlainText,
  cloneCardsWithNewIds,
  columnChildren,
  copyBoardContent,
  createCard,
  createTextNote,
  deleteCards,
  deserializeCards,
  drawerCardOf,
  duplicateCards,
  expandSelection,
  getCardMap,
  getCards,
  getMeta,
  initBoardDoc,
  isParked,
  isTrashed,
  purgeExpiredTrash,
  purgeTrashEntry,
  insertClonedCards,
  insertIntoColumn,
  listTrash,
  moveCardsToBoard,
  placeOnCanvas,
  readCard,
  readMeta,
  restoreTrashEntry,
  sendBackward,
  sendToBack,
  serializeCards,
  updateCard,
  xmlToText,
  type CardRect,
} from './board'
import { boardBlobHashes } from './blobRefs'
import type { LineCard } from './types'

const U = 'user1'

function board() {
  return new Y.Doc({ guid: 'b1' })
}

describe('board model', () => {
  it('creates cards with defaults and nested types', () => {
    const doc = board()
    const id = createCard(doc, 'note', { x: 10, y: 20 }, U)
    const m = getCards(doc).get(id)!
    const c = readCard(m)
    expect(c).toMatchObject({ id, type: 'note', x: 10, y: 20, w: 300, parent: null, createdBy: U })
    expect(m.get('content')).toBeInstanceOf(Y.XmlFragment)
    const sketch = readCard(getCards(doc).get(createCard(doc, 'sketch', {}, U))!) as unknown as { vw: number; h: number }
    expect(sketch.vw).toBe(400)
    expect(sketch.h).toBe(300)
  })

  it('assigns increasing z', () => {
    const doc = board()
    const a = createCard(doc, 'note', {}, U)
    const b = createCard(doc, 'note', {}, U)
    expect(readCard(getCards(doc).get(b)!).z).toBeGreaterThan(readCard(getCards(doc).get(a)!).z)
  })

  it('deletes to trash with column children and attached lines, and restores', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const n1 = createCard(doc, 'note', {}, U)
    const n2 = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [n1], col, 0, U)
    const line = createCard(doc, 'line', { from: { card: col, x: 0, y: 0 }, to: { card: n2, x: 0, y: 0 } }, U)
    const entry = deleteCards(doc, [col], U)!
    // soft delete: cards stay in the map, flagged
    expect(isTrashed(getCards(doc).get(col)!)).toBe(true)
    expect(isTrashed(getCards(doc).get(n1)!)).toBe(true)
    expect(isTrashed(getCards(doc).get(line)!)).toBe(true)
    expect(isTrashed(getCards(doc).get(n2)!)).toBe(false)
    expect(columnChildren(doc, col)).toEqual([])
    expect(listTrash(doc)).toHaveLength(1)
    expect(listTrash(doc)[0].cards.map((c) => c.id).sort()).toEqual([col, n1, line].sort())
    const restored = restoreTrashEntry(doc, entry, U)
    expect(restored.sort()).toEqual([col, n1, line].sort())
    expect(readCard(getCards(doc).get(n1)!).parent).toBe(col)
    expect(listTrash(doc)).toHaveLength(0)
    // purge removes for good
    const again = deleteCards(doc, [n2], U)!
    purgeTrashEntry(doc, again)
    expect(getCards(doc).has(n2)).toBe(false)
  })

  it('keeps a concurrent edit by a teammate when a card is deleted', () => {
    const a = board()
    const b = new Y.Doc({ guid: 'b1' })
    const id = createTextNote(a, 'start', {}, U)
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // offline: A deletes, B types
    deleteCards(a, [id], U)
    const frag = getCards(b).get(id)!.get('content') as Y.XmlFragment
    b.transact(() => (frag.get(0) as Y.XmlElement).insert(1, [new Y.XmlText(' + edit')]))
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const entry = listTrash(a)[0].id
    restoreTrashEntry(a, entry, U)
    expect(xmlToText(getCards(a).get(id)!.get('content') as Y.XmlFragment)).toBe('start + edit')
  })

  it('purges expired trash only after the retention period', () => {
    const doc = board()
    const id = createCard(doc, 'note', {}, U)
    deleteCards(doc, [id], U)
    purgeExpiredTrash(doc, Date.now() + 10 * 24 * 3600 * 1000)
    expect(getCards(doc).has(id)).toBe(true)
    purgeExpiredTrash(doc, Date.now() + 100 * 24 * 3600 * 1000)
    expect(getCards(doc).has(id)).toBe(false)
  })

  it('orders column children with fractional keys', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const [a, b, c] = [0, 1, 2].map(() => createCard(doc, 'note', {}, U))
    insertIntoColumn(doc, [a], col, 0, U)
    insertIntoColumn(doc, [b], col, 1, U)
    insertIntoColumn(doc, [c], col, 1, U)
    expect(columnChildren(doc, col)).toEqual([a, c, b])
    insertIntoColumn(doc, [b], col, 0, U)
    expect(columnChildren(doc, col)).toEqual([b, a, c])
    // columns cannot be nested
    const col2 = createCard(doc, 'column', {}, U)
    insertIntoColumn(doc, [col2], col, 0, U)
    expect(readCard(getCards(doc).get(col2)!).parent).toBeNull()
  })

  it('duplicates groups with remapped references', () => {
    const doc = board()
    const col = createCard(doc, 'column', { x: 0, y: 0 }, U)
    const n = createTextNote(doc, 'hello\nworld', {}, U)
    insertIntoColumn(doc, [n], col, 0, U)
    const ids = duplicateCards(doc, [col], U)
    expect(ids).toHaveLength(2)
    const newCol = ids.find((id) => readCard(getCards(doc).get(id)!).type === 'column')!
    const newNote = ids.find((id) => id !== newCol)!
    expect(readCard(getCards(doc).get(newNote)!).parent).toBe(newCol)
    expect(xmlToText(getCards(doc).get(newNote)!.get('content') as Y.XmlFragment)).toBe('hello\nworld')
    expect(readCard(getCards(doc).get(newCol)!).x).toBe(30)
  })

  it('round-trips cards through the clipboard format', () => {
    const doc = board()
    const n = createTextNote(doc, 'copy me', { x: 100, y: 100 }, U)
    const data = serializeCards(doc, [n])
    const other = new Y.Doc({ guid: 'b2' })
    const ids = insertClonedCards(other, deserializeCards(data), { x: 5, y: 7 }, U)
    const c = readCard(getCards(other).get(ids[0])!)
    expect(c).toMatchObject({ x: 5, y: 7, type: 'note' })
    expect(ids[0]).not.toBe(n)
    expect(xmlToText(getCards(other).get(ids[0])!.get('content') as Y.XmlFragment)).toBe('copy me')
  })

  it('moves cards into another board', () => {
    const src = board()
    const dst = new Y.Doc({ guid: 'b2' })
    const n = createTextNote(src, 'moving', { x: 500, y: 500 }, U)
    const out = moveCardsToBoard(src, dst, [n], { x: 40, y: 40 }, U)
    expect(isTrashed(getCards(src).get(n)!)).toBe(true)
    expect(listTrash(src)).toHaveLength(0) // moved cards are not shown as deleted
    // moving it back re-ids instead of clobbering the hidden copy
    const back = moveCardsToBoard(dst, src, out, { x: 0, y: 0 }, U)
    expect(back[0]).not.toBe(n)
    expect(readCard(getCards(dst).get(out[0])!)).toMatchObject({ x: 40, y: 40 })
  })

  it('sanitises malformed peer data when reading', () => {
    const doc = board()
    const id = createCard(doc, 'note', {}, U)
    const m = getCards(doc).get(id)!
    m.set('x', 'evil' as unknown as number)
    m.set('w', -5)
    const c = readCard(m)
    expect(c.x).toBe(0)
    expect(c.w).toBe(1)
    updateCard(doc, id, { x: 42 }, U)
    expect(readCard(m).x).toBe(42)
  })

  it('syncs between two docs', () => {
    const a = board()
    const b = new Y.Doc({ guid: 'b1' })
    a.on('update', (u: Uint8Array) => Y.applyUpdate(b, u))
    const id = createTextNote(a, 'synced', {}, U)
    expect(xmlToText(getCards(b).get(id)!.get('content') as Y.XmlFragment)).toBe('synced')
  })
})

const zOf = (doc: Y.Doc, id: string) => getCardMap(doc, id)!.get('z') as number
/** Ids bottom to top (ties by id, like the model). */
const stack = (doc: Y.Doc, ids: string[]) => [...ids].sort((a, b) => zOf(doc, a) - zOf(doc, b) || (a < b ? -1 : 1))
function countUpdates(doc: Y.Doc): () => number {
  let n = 0
  doc.on('update', () => n++)
  return () => n
}

describe('new card fields', () => {
  it('reads unsorted only for a literal true', () => {
    const doc = board()
    const id = createCard(doc, 'note', {}, U)
    const m = getCards(doc).get(id)!
    expect(readCard(m).unsorted).toBe(false)
    for (const bad of ['true', 1, {}, null]) {
      m.set('unsorted', bad)
      expect(readCard(m).unsorted).toBe(false)
    }
    m.set('unsorted', true)
    expect(readCard(m).unsorted).toBe(true)
  })

  it('reads unsorted only on top-level cards that are not lines, and clears it on column moves', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const child = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [child], col, 0, U)
    // Merged concurrent edits ("move to drawer" + "drag into column") or any peer can leave the flag here.
    getCardMap(doc, child)!.set('unsorted', true)
    const line = createCard(doc, 'line', { unsorted: true }, U)
    expect(readCard(getCardMap(doc, child)!).unsorted).toBe(false)
    expect(readCard(getCardMap(doc, line)!).unsorted).toBe(false)
    // Leaving the column must not drop the card into the drawer.
    placeOnCanvas(doc, { [child]: { x: 5, y: 5 } }, U)
    expect(getCardMap(doc, child)!.has('unsorted')).toBe(false)
    expect(readCard(getCardMap(doc, child)!)).toMatchObject({ parent: null, unsorted: false, x: 5, y: 5 })
    const stale = createCard(doc, 'note', { unsorted: true }, U)
    insertIntoColumn(doc, [stale], col, 0, U)
    expect(getCardMap(doc, stale)!.has('unsorted')).toBe(false)
  })

  it('never copies locked or unsorted', () => {
    const doc = board()
    const id = createTextNote(doc, 'pinned', { locked: true, unsorted: true }, U)
    const [dup] = duplicateCards(doc, [id], U)
    expect(getCardMap(doc, dup)!.has('locked')).toBe(false)
    expect(getCardMap(doc, dup)!.has('unsorted')).toBe(false)
    const other = new Y.Doc({ guid: 'b2' })
    const [pasted] = insertClonedCards(other, deserializeCards(serializeCards(doc, [id])), { x: 0, y: 0 }, U)
    expect(readCard(getCardMap(other, pasted)!)).toMatchObject({ locked: false, unsorted: false })
    const dst = new Y.Doc({ guid: 'b3' })
    const [moved] = moveCardsToBoard(doc, dst, [id], { x: 0, y: 0 }, U)
    expect(getCardMap(dst, moved)!.has('locked')).toBe(false)
    expect(getCardMap(dst, moved)!.has('unsorted')).toBe(false)
  })

  it('remaps attachedTo when cloning, or frees the comment when its card stays behind', () => {
    const doc = board()
    const note = createCard(doc, 'note', {}, U)
    const comment = createCard(doc, 'comment', { attachedTo: note }, U)
    const both = cloneCardsWithNewIds([getCardMap(doc, note)!, getCardMap(doc, comment)!])
    const copyOfComment = both.cards.find((d) => d.data.type === 'comment')!
    expect(copyOfComment.data.attachedTo).toBe(both.idMap.get(note))
    const alone = cloneCardsWithNewIds([getCardMap(doc, comment)!])
    expect(alone.cards[0].data.attachedTo).toBeNull()
    const free = createCard(doc, 'comment', { attachedTo: null }, U)
    expect(cloneCardsWithNewIds([getCardMap(doc, free)!]).cards[0].data.attachedTo).toBeNull()
  })

  it('takes attached comments along (not trashed ones), and restoring keeps the link', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const child = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [child], col, 0, U)
    const note = createCard(doc, 'note', {}, U)
    const onNote = createCard(doc, 'comment', { attachedTo: note }, U)
    const onChild = createCard(doc, 'comment', { attachedTo: child }, U)
    const old = createCard(doc, 'comment', { attachedTo: note }, U)
    const free = createCard(doc, 'comment', {}, U)
    const line = createCard(doc, 'line', { from: { card: onNote, x: 0, y: 0 }, to: { card: null, x: 5, y: 5 } }, U)
    deleteCards(doc, [old], U)
    expect([...expandSelection(doc, [note])].sort()).toEqual([note, onNote, line].sort())
    expect([...expandSelection(doc, [col])].sort()).toEqual([col, child, onChild].sort())
    expect(expandSelection(doc, [onNote]).has(note)).toBe(false)
    expect(expandSelection(doc, [note]).has(free)).toBe(false)

    const entry = deleteCards(doc, [note], U)!
    expect(isTrashed(getCardMap(doc, onNote)!)).toBe(true)
    restoreTrashEntry(doc, entry, U)
    expect(isTrashed(getCardMap(doc, onNote)!)).toBe(false)
    expect(getCardMap(doc, onNote)!.get('attachedTo')).toBe(note)

    const ids = duplicateCards(doc, [note], U)
    const dupNote = ids.find((id) => getCardMap(doc, id)!.get('type') === 'note')!
    const dupComment = ids.find((id) => getCardMap(doc, id)!.get('type') === 'comment')!
    expect(getCardMap(doc, dupComment)!.get('attachedTo')).toBe(dupNote)
  })

  it('moves attached comments to another board with their card', () => {
    const src = board()
    const dst = new Y.Doc({ guid: 'b2' })
    const note = createCard(src, 'note', {}, U)
    const comment = createCard(src, 'comment', { attachedTo: note }, U)
    const second = createCard(src, 'comment', { attachedTo: note }, U)
    const out = moveCardsToBoard(src, dst, [note], { x: 0, y: 0 }, U)
    expect(out.sort()).toEqual([note, comment, second].sort())
    expect(getCardMap(dst, comment)!.get('attachedTo')).toBe(note)
    // a comment moved without its card becomes free on the other board
    const n2 = createCard(src, 'note', {}, U)
    const c2 = createCard(src, 'comment', { attachedTo: n2 }, U)
    const [moved] = moveCardsToBoard(src, dst, [c2], { x: 0, y: 0 }, U)
    expect(getCardMap(dst, moved)!.get('attachedTo')).toBeNull()
  })

  it('duplicates with an offset and keeps lines attached between the copies', () => {
    const doc = board()
    const a = createCard(doc, 'note', { x: 0, y: 0 }, U)
    const b = createCard(doc, 'note', { x: 400, y: 0 }, U)
    const outside = createCard(doc, 'note', { x: 0, y: 400 }, U)
    createCard(doc, 'line', { from: { card: a, x: 0, y: 0 }, to: { card: b, x: 0, y: 0 } }, U)
    createCard(doc, 'line', { from: { card: a, x: 0, y: 0 }, to: { card: outside, x: 0, y: 0 } }, U)
    const ids = duplicateCards(doc, [a, b], U, { x: 120, y: -40 })
    expect(ids).toHaveLength(3)
    const lines = ids.map((id) => readCard(getCardMap(doc, id)!)).filter((c): c is LineCard => c.type === 'line')
    expect(lines).toHaveLength(1)
    const notes = ids.filter((id) => getCardMap(doc, id)!.get('type') === 'note')
    expect([lines[0].from.card, lines[0].to.card].sort()).toEqual([...notes].sort())
    const copies = notes.map((id) => readCard(getCardMap(doc, id)!))
    expect(copies.map((c) => [c.x, c.y]).sort((p, q) => p[0] - q[0])).toEqual([
      [120, -40],
      [520, -40],
    ])
  })
})

describe('z order', () => {
  it('sends to back keeping the group order, ignoring trashed cards, and skips no-ops', () => {
    const doc = board()
    const [a, b, c, d] = [0, 1, 2, 3].map(() => createCard(doc, 'note', {}, U))
    const gone = createCard(doc, 'note', { z: -50 }, U)
    deleteCards(doc, [gone], U)
    // c is below d; passed in the other order
    sendToBack(doc, [d, c], U)
    expect(stack(doc, [a, b, c, d])).toEqual([c, d, a, b])
    expect(zOf(doc, c)).toBe(zOf(doc, a) - 2)
    // Cards stay above the lines layer (z-index 0).
    for (const id of [a, b, c, d]) expect(zOf(doc, id)).toBeGreaterThanOrEqual(1)
    const updates = countUpdates(doc)
    sendToBack(doc, [c, d], U)
    sendToBack(doc, [c], U)
    expect(updates()).toBe(0)
    sendToBack(doc, [d], U)
    expect(updates()).toBe(1)
    expect(stack(doc, [a, b, c, d])).toEqual([d, c, a, b])
    for (const id of [a, b, c, d]) expect(zOf(doc, id)).toBeGreaterThanOrEqual(1)
  })

  it('sends to back below the lowest card when there is room, else makes room in the same step', () => {
    const doc = board()
    const [a, b, c] = [0, 1, 2].map((i) => createCard(doc, 'note', { z: 10 + i }, U))
    sendToBack(doc, [c], U)
    expect([zOf(doc, c), zOf(doc, a), zOf(doc, b)]).toEqual([9, 10, 11])
    // Peer data below 1 is lifted too, keeping the order.
    updateCard(doc, a, { z: -3 }, U)
    updateCard(doc, b, { z: 0 }, U)
    const updates = countUpdates(doc)
    sendToBack(doc, [c], U)
    expect(updates()).toBe(1)
    expect(stack(doc, [a, b, c])).toEqual([c, a, b])
    expect(zOf(doc, c)).toBe(1)
    for (const id of [a, b]) expect(zOf(doc, id)).toBeGreaterThan(1)
  })

  it('brings to front keeping the group order, and skips no-ops even under trashed cards', () => {
    const doc = board()
    const [a, b, c, d] = [0, 1, 2, 3].map(() => createCard(doc, 'note', {}, U))
    bringToFront(doc, [b, a], U)
    expect(stack(doc, [a, b, c, d])).toEqual([c, d, a, b])
    const gone = createCard(doc, 'note', {}, U)
    deleteCards(doc, [gone], U)
    const updates = countUpdates(doc)
    bringToFront(doc, [a, b], U)
    bringToFront(doc, [b], U)
    bringToFront(doc, [gone, 'missing'], U)
    expect(updates()).toBe(0)
    bringToFront(doc, [a], U)
    expect(updates()).toBe(1)
    expect(stack(doc, [a, b, c, d])).toEqual([c, d, b, a])
    expect(zOf(doc, a)).toBeGreaterThan(zOf(doc, gone))
  })

  /** Notes with the given rects; rectOf reads them back from the doc. */
  function layout(rects: CardRect[]) {
    const doc = board()
    const ids = rects.map((r) => createCard(doc, 'note', { x: r.x, y: r.y, w: r.w, h: r.h }, U))
    const rectOf = (id: string): CardRect | null => {
      const c = readCard(getCardMap(doc, id)!)
      return { x: c.x, y: c.y, w: c.w, h: c.h ?? 100 }
    }
    return { doc, ids, rectOf }
  }

  it('brings a card forward just past the nearest overlapping card', () => {
    // a overlaps c and d; b overlaps nothing
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 500, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
      { x: 60, y: 60, w: 100, h: 100 },
    ])
    const [a, b, c, d] = ids
    const zd = zOf(doc, d)
    bringForward(doc, [a], U, rectOf)
    expect(stack(doc, ids)).toEqual([b, c, a, d])
    expect(zOf(doc, d)).toBe(zd)
    bringForward(doc, [a], U, rectOf)
    expect(stack(doc, ids)).toEqual([b, c, d, a])
    // nothing overlapping above any more: no write
    const updates = countUpdates(doc)
    bringForward(doc, [a], U, rectOf)
    bringForward(doc, [b], U, rectOf)
    expect(updates()).toBe(0)
  })

  it('swaps z with an adjacent overlapping neighbour', () => {
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ])
    const [a, b] = ids
    const [za, zb] = [zOf(doc, a), zOf(doc, b)]
    bringForward(doc, [a], U, rectOf)
    expect([zOf(doc, a), zOf(doc, b)]).toEqual([zb, za])
    sendBackward(doc, [a], U, rectOf)
    expect([zOf(doc, a), zOf(doc, b)]).toEqual([za, zb])
  })

  it('sends backward past the nearest overlapping card below, and stays without one', () => {
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 500, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ])
    const [a, b, c] = ids
    sendBackward(doc, [c], U, rectOf)
    expect(stack(doc, ids)).toEqual([c, a, b])
    const updates = countUpdates(doc)
    sendBackward(doc, [c], U, rectOf)
    sendBackward(doc, [b], U, rectOf)
    expect(updates()).toBe(0)
    expect(stack(doc, ids)).toEqual([c, a, b])
  })

  it('keeps several selected cards in their relative order', () => {
    // a and b sit under n; x is far away
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 10, y: 10, w: 100, h: 100 },
      { x: 900, y: 900, w: 10, h: 10 },
      { x: 20, y: 20, w: 100, h: 100 },
    ])
    const [a, b, x, n] = ids
    bringForward(doc, [b, a], U, rectOf)
    expect(stack(doc, ids)).toEqual([x, n, a, b])
    for (const id of ids) expect(Number.isInteger(zOf(doc, id))).toBe(true)
    sendBackward(doc, [a, b], U, rectOf)
    expect(stack(doc, ids)).toEqual([x, a, b, n])
  })

  it('never lets a selected card overtake another selected card', () => {
    // a overlaps n; b (between them) overlaps nothing and is selected too
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 500, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ])
    const [a, b, n] = ids
    const updates = countUpdates(doc)
    bringForward(doc, [a, b], U, rectOf)
    expect(stack(doc, ids)).toEqual([a, b, n])
    expect(updates()).toBe(0)
  })

  it('makes tied z values from peers strict, bumping cards above only as needed', () => {
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
      { x: 500, y: 500, w: 100, h: 100 },
    ])
    const [a, b, c] = ids
    updateCard(doc, a, { z: 5 }, U)
    updateCard(doc, b, { z: 5 }, U)
    updateCard(doc, c, { z: 6 }, U)
    const [lo, hi] = stack(doc, [a, b])
    bringForward(doc, [lo], U, rectOf)
    expect(stack(doc, ids)).toEqual([hi, lo, c])
    expect(zOf(doc, lo)).toBeGreaterThan(zOf(doc, hi))
    expect(zOf(doc, c)).toBeGreaterThan(zOf(doc, lo))
  })

  it('steps past cards only: lines and pinned comments are not stacked with them', () => {
    // A line drawn first, a comment pinned to a, then a card overlapping a: all above a.
    const { doc, ids, rectOf } = layout([{ x: 0, y: 0, w: 100, h: 100 }])
    const [a] = ids
    const line = createCard(doc, 'line', { from: { card: null, x: 0, y: 0 }, to: { card: null, x: 90, y: 90 } }, U)
    const pin = createCard(doc, 'comment', { x: 10, y: 10, attachedTo: a }, U)
    const b = createCard(doc, 'note', { x: 50, y: 50, w: 100, h: 100 }, U)
    bringForward(doc, [a], U, rectOf)
    expect(stack(doc, [a, line, pin, b])).toEqual([line, pin, b, a])
    sendBackward(doc, [a], U, rectOf)
    expect(stack(doc, [a, b])).toEqual([a, b])
    // A comment pinned to a card in the drawer is hidden: not a neighbour either.
    const parked = createCard(doc, 'note', { x: 500, y: 0, unsorted: true }, U)
    const hidden = createCard(doc, 'comment', { x: 0, y: 0, attachedTo: parked }, U)
    const updates = countUpdates(doc)
    sendBackward(doc, [hidden], U, rectOf)
    bringForward(doc, [b], U, rectOf)
    expect(updates()).toBe(0)
  })

  it('ignores trashed cards and cards without a rect', () => {
    const { doc, ids, rectOf } = layout([
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 50, y: 50, w: 100, h: 100 },
    ])
    const [a, b] = ids
    deleteCards(doc, [b], U)
    const updates = countUpdates(doc)
    bringForward(doc, [a], U, rectOf)
    bringForward(doc, [a], U, () => null)
    expect(updates()).toBe(0)
  })
})

describe('parked with the Unsorted drawer', () => {
  it('hides what belongs to a drawer card or column, and nothing else', () => {
    const doc = board()
    const drawer = createCard(doc, 'note', { unsorted: true }, U)
    const col = createCard(doc, 'column', { unsorted: true }, U)
    const child = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [child], col, 0, U)
    const free = createCard(doc, 'note', {}, U)
    const onDrawer = createCard(doc, 'comment', { attachedTo: drawer }, U)
    const onChild = createCard(doc, 'comment', { attachedTo: child }, U)
    const onFree = createCard(doc, 'comment', { attachedTo: free }, U)
    const toDrawer = createCard(doc, 'line', { from: { card: free, x: 0, y: 0 }, to: { card: drawer, x: 0, y: 0 } }, U)
    const toPin = createCard(doc, 'line', { from: { card: free, x: 0, y: 0 }, to: { card: onChild, x: 0, y: 0 } }, U)
    const kept = createCard(doc, 'line', { from: { card: free, x: 0, y: 0 }, to: { card: onFree, x: 0, y: 0 } }, U)
    const parked = [drawer, col, child, onDrawer, onChild, toDrawer, toPin]
    const shown = [free, onFree, kept, 'missing']
    for (const id of parked) expect(isParked(doc, id)).toBe(true)
    for (const id of shown) expect(isParked(doc, id)).toBe(false)
    // The same answers through an index-like lookup (what the canvas passes).
    const lookup = (id: string) => {
      const m = getCardMap(doc, id)
      if (!m || isTrashed(m)) return undefined
      const card = readCard(m)
      return { type: card.type, parent: card.parent, unsorted: card.unsorted === true, card }
    }
    for (const id of [...parked, ...shown]) expect(isParked(lookup, id)).toBe(isParked(doc, id))
    // The drawer row each one is hidden with.
    expect([child, onChild, toPin, onDrawer, toDrawer].map((id) => drawerCardOf(doc, id))).toEqual([col, col, col, drawer, drawer])
    expect(drawerCardOf(lookup, free)).toBeNull()
  })

  it('does not park on stale flags, trashed columns or comments pinned to themselves', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const child = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [child], col, 0, U)
    getCardMap(doc, child)!.set('unsorted', true)
    const line = createCard(doc, 'line', { unsorted: true }, U)
    const self = createCard(doc, 'comment', {}, U)
    getCardMap(doc, self)!.set('attachedTo', self)
    for (const id of [child, line, self]) expect(isParked(doc, id)).toBe(false)
    const gone = createCard(doc, 'column', { unsorted: true }, U)
    const orphan = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [orphan], gone, 0, U)
    getCardMap(doc, gone)!.set('trashedAt', Date.now())
    expect(isParked(doc, orphan)).toBe(false)
  })
})

describe('board meta', () => {
  it('reads a valid cover only, and copies it with the board', () => {
    const cover = 'a'.repeat(64)
    const src = new Y.Doc({ guid: 'src00000001' })
    initBoardDoc(src, { id: 'src00000001', title: 'Moodboard', cover }, U)
    expect(readMeta(src).cover).toBe(cover)
    getMeta(src).set('cover', 'not-a-hash')
    expect(readMeta(src).cover).toBeNull()
    getMeta(src).set('cover', cover)
    const dst = new Y.Doc({ guid: 'dst00000001' })
    copyBoardContent(src, dst, { parentId: null, userId: U })
    expect(readMeta(dst).cover).toBe(cover)
    expect(boardBlobHashes(dst).has(cover)).toBe(true)
    const plain = new Y.Doc({ guid: 'plain000001' })
    initBoardDoc(plain, { id: 'plain000001', cover: 'x' }, U)
    expect(getMeta(plain).has('cover')).toBe(false)
  })
})

describe('copying to other apps', () => {
  it('leaves out comment threads that only came along with the copied card', () => {
    const doc = board()
    const note = createTextNote(doc, 'shopping list', {}, U)
    const pin = createCard(doc, 'comment', { attachedTo: note }, U)
    doc.transact(() => {
      const msg = new Y.Map<unknown>()
      msg.set('text', 'private remark')
      ;(getCardMap(doc, pin)!.get('thread') as Y.Array<Y.Map<unknown>>).push([msg])
    })
    expect(cardsToPlainText(doc, [note])).toBe('shopping list')
    expect(cardsToPlainText(doc, [note, pin])).toContain('private remark')
    // The app's own snapshot keeps the thread with its card, like duplicate and move.
    expect(deserializeCards(serializeCards(doc, [note]))).toHaveLength(2)
  })
})
