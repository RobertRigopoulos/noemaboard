import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createCard,
  createTextNote,
  deleteCards,
  getCardMap,
  getCards,
  insertIntoColumn,
  isParked,
  isValidOrderKey,
  LOCAL_ORIGIN,
  maxZ,
  moveCardsToBoard,
  readCard,
  xmlToText,
} from './board'
import { addUnsortedNote, isUnsortedMap, moveToUnsorted, placeFromUnsorted, unsortedIds } from './unsorted'

const U = 'user1'
const board = (guid = 'b1') => new Y.Doc({ guid })
const field = (doc: Y.Doc, id: string, k: string) => getCardMap(doc, id)!.get(k)

describe('unsorted drawer', () => {
  it('only counts a literal true on a live top-level card', () => {
    const doc = board()
    const a = createCard(doc, 'note', { unsorted: true }, U)
    // Peers may write anything: only a literal true counts.
    const b = createCard(doc, 'note', {}, U)
    const c = createCard(doc, 'note', {}, U)
    doc.transact(() => {
      getCardMap(doc, b)!.set('unsorted', 'true')
      getCardMap(doc, c)!.set('unsorted', 1)
    })
    const col = createCard(doc, 'column', {}, U)
    const child = createCard(doc, 'note', { unsorted: true }, U)
    insertIntoColumn(doc, [child], col, 0, U)
    const gone = createCard(doc, 'note', { unsorted: true }, U)
    deleteCards(doc, [gone], U)
    const line = createCard(doc, 'line', { unsorted: true }, U)
    expect(isUnsortedMap(getCardMap(doc, a)!)).toBe(true)
    for (const id of [b, c, child, gone, line]) expect(isUnsortedMap(getCardMap(doc, id)!)).toBe(false)
    expect(unsortedIds(doc)).toEqual([a])
  })

  it('appends order keys after the drawer cards, in the given order, as one undo step', () => {
    const doc = board()
    const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => createCard(doc, 'note', { x: i * 400, y: 0 }, U))
    undo.clear()
    expect(moveToUnsorted(doc, [b, a], U)).toEqual([b, a])
    expect(unsortedIds(doc)).toEqual([b, a])
    // cards already in the drawer stay where they are
    expect(moveToUnsorted(doc, [a, d, c], U)).toEqual([d, c])
    expect(unsortedIds(doc)).toEqual([b, a, d, c])
    const keys = unsortedIds(doc).map((id) => field(doc, id, 'order') as string)
    expect(keys.every(isValidOrderKey)).toBe(true)
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(4)
    // x/y are kept for versions without the drawer
    expect(readCard(getCardMap(doc, c)!)).toMatchObject({ x: 800, y: 0, unsorted: true })
    undo.undo()
    expect(unsortedIds(doc)).toEqual([b, a])
  })

  it('takes a column child out of its column', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const child = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [child], col, 0, U)
    moveToUnsorted(doc, [child], U)
    expect(field(doc, child, 'parent')).toBeNull()
    expect(unsortedIds(doc)).toEqual([child])
  })

  it('appends after malformed keys from peers', () => {
    const doc = board()
    const a = createCard(doc, 'note', { unsorted: true, order: '!!garbage' }, U)
    const b = createCard(doc, 'note', {}, U)
    moveToUnsorted(doc, [b], U)
    expect(isValidOrderKey(field(doc, b, 'order'))).toBe(true)
    expect(unsortedIds(doc).sort()).toEqual([a, b].sort())
  })

  it('places drawer cards on the canvas, stacked from the drop point, above everything', () => {
    const doc = board()
    const top = createCard(doc, 'note', { z: 40 }, U)
    const a = createCard(doc, 'image', { unsorted: true, h: 200 }, U)
    const b = createCard(doc, 'note', { unsorted: true }, U)
    const free = createCard(doc, 'note', {}, U)
    const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
    expect(placeFromUnsorted(doc, [a, b, free], { x: 103, y: 47 }, U)).toEqual([a, b])
    expect(getCardMap(doc, a)!.has('unsorted')).toBe(false)
    expect(readCard(getCardMap(doc, a)!)).toMatchObject({ x: 100, y: 50, unsorted: false })
    // 200 high + one grid step
    expect(readCard(getCardMap(doc, b)!)).toMatchObject({ x: 100, y: 260 })
    expect(field(doc, a, 'z')).toBeGreaterThan(field(doc, top, 'z') as number)
    expect(field(doc, b, 'z')).toBe(maxZ(doc))
    expect(unsortedIds(doc)).toEqual([])
    undo.undo()
    expect(unsortedIds(doc).sort()).toEqual([a, b].sort())
  })

  it('uses a default height for cards without one', () => {
    const doc = board()
    const a = createCard(doc, 'note', { unsorted: true }, U)
    const b = createCard(doc, 'note', { unsorted: true }, U)
    placeFromUnsorted(doc, [a, b], { x: 0, y: 0 }, U)
    expect(field(doc, b, 'y')).toBe(130)
  })

  it('stacks by the heights the caller knows, then stored heights, then the default', () => {
    const doc = board()
    const a = createCard(doc, 'note', { unsorted: true }, U)
    const b = createCard(doc, 'image', { unsorted: true, h: 200 }, U)
    const c = createCard(doc, 'note', { unsorted: true }, U)
    const d = createCard(doc, 'note', { unsorted: true }, U)
    const known: Record<string, number> = { [a]: 340, [c]: NaN }
    placeFromUnsorted(doc, [a, b, c, d], { x: 0, y: 0 }, U, { heightOf: (id) => known[id] })
    expect([a, b, c, d].map((id) => field(doc, id, 'y'))).toEqual([0, 350, 560, 690])
  })

  it('keeps comments and lines with a drawer card or column, and brings them back with it', () => {
    const src = board()
    const dst = board('b2')
    const note = createCard(src, 'note', { x: 0, y: 0 }, U)
    const comment = createCard(src, 'comment', { attachedTo: note, x: 400, y: 0 }, U)
    const other = createCard(dst, 'note', { x: 900, y: 0 }, U)
    moveCardsToBoard(src, dst, [note], { x: 0, y: 0 }, U, { unsorted: true })
    expect(unsortedIds(dst)).toEqual([note])
    const line = createCard(dst, 'line', { from: { card: other, x: 0, y: 0 }, to: { card: note, x: 0, y: 0 } }, U)
    // Hidden with the card, not turned into a free comment on the canvas.
    expect(isParked(dst, comment)).toBe(true)
    expect(isParked(dst, line)).toBe(true)
    expect(isParked(dst, other)).toBe(false)
    placeFromUnsorted(dst, [note], { x: 0, y: 0 }, U)
    expect(field(dst, comment, 'attachedTo')).toBe(note)
    for (const id of [note, comment, line]) expect(isParked(dst, id)).toBe(false)

    const col = createCard(dst, 'column', {}, U)
    const child = createCard(dst, 'note', {}, U)
    insertIntoColumn(dst, [child], col, 0, U)
    const toChild = createCard(dst, 'line', { from: { card: other, x: 0, y: 0 }, to: { card: child, x: 0, y: 0 } }, U)
    moveToUnsorted(dst, [col], U)
    expect(isParked(dst, child)).toBe(true)
    expect(isParked(dst, toChild)).toBe(true)
  })

  it('adds a note at the end of the drawer, right of the content', () => {
    const doc = board()
    createCard(doc, 'note', { x: 0, y: 30, w: 300 }, U)
    const first = moveToUnsorted(doc, [createCard(doc, 'note', { x: 400, y: 100, w: 200 }, U)], U)[0]
    const id = addUnsortedNote(doc, 'remember\nthis', U)
    expect(unsortedIds(doc)).toEqual([first, id])
    expect(readCard(getCardMap(doc, id)!)).toMatchObject({ type: 'note', x: 640, y: 30, unsorted: true })
    expect(xmlToText(field(doc, id, 'content') as Y.XmlFragment)).toBe('remember\nthis')
  })

  it('moves cards into another board drawer: top-level cards only', () => {
    const src = board()
    const dst = board('b2')
    const existing = createTextNote(dst, 'already there', { unsorted: true }, U)
    const col = createCard(src, 'column', { x: 0, y: 0 }, U)
    const child = createCard(src, 'note', {}, U)
    insertIntoColumn(src, [child], col, 0, U)
    const low = createCard(src, 'note', { x: 0, y: 500 }, U)
    const comment = createCard(src, 'comment', { attachedTo: low }, U)
    const line = createCard(src, 'line', { from: { card: col, x: 0, y: 0 }, to: { card: low, x: 0, y: 0 } }, U)
    const out = moveCardsToBoard(src, dst, [col, low], { x: 1000, y: 0 }, U, { unsorted: true })
    expect(out.sort()).toEqual([col, child, low, comment, line].sort())
    // reading order, after the card that was there
    expect(unsortedIds(dst)).toEqual([existing, col, low])
    expect(field(dst, child, 'parent')).toBe(col)
    expect(getCardMap(dst, child)!.has('unsorted')).toBe(false)
    expect(getCardMap(dst, line)!.has('unsorted')).toBe(false)
    expect(getCardMap(dst, comment)!.has('unsorted')).toBe(false)
    expect(field(dst, comment, 'attachedTo')).toBe(low)
    expect(readCard(getCardMap(dst, line)!)).toMatchObject({ from: { card: col }, to: { card: low } })
    // without the option, nothing goes into the drawer
    const n = createCard(src, 'note', {}, U)
    const [plain] = moveCardsToBoard(src, dst, [n], { x: 0, y: 0 }, U)
    expect(getCardMap(dst, plain)!.has('unsorted')).toBe(false)
  })
})
