import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  bringToFront,
  cardContentState,
  columnChildren,
  copyBoardContent,
  createCard,
  createTextNote,
  deleteCards,
  deserializeCards,
  duplicateCards,
  EDITED_GROUP_SUFFIX,
  findEditedMovedCards,
  forkBoardCards,
  getCardMap,
  getCards,
  hideMovedCopies,
  initBoardDoc,
  insertClonedCards,
  insertIntoColumn,
  isTrashed,
  isValidOrderKey,
  listTrash,
  moveCardsToBoard,
  orderKeyAt,
  purgeExpiredTrash,
  readCard,
  readMeta,
  removeCards,
  restoreTrashEntry,
  sendToBack,
  serializeCards,
  SYSTEM_ORIGIN,
  unhideMovedCopies,
  updateCard,
  watchMovedCards,
  xmlToText,
  type BoardFork,
} from './board'

const U = 'user1'
const DAY = 24 * 3600 * 1000

const board = (guid = 'b1') => new Y.Doc({ guid })
const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)))
const text = (doc: Y.Doc, id: string) => xmlToText(getCards(doc).get(id)!.get('content') as Y.XmlFragment)
function appendText(doc: Y.Doc, id: string, s: string) {
  const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
  const p = frag.get(0) as Y.XmlElement
  doc.transact(() => p.insert(p.length, [new Y.XmlText(s)]))
}

// ---------------------------------------------------------------------------
// Moving cards to another board: edits that land after the move, lines left behind, undo

describe('moved-away cards', () => {
  it('records the target card id and keeps unedited moved cards hidden', () => {
    const src = board()
    const dst = board('b2')
    const n = createTextNote(src, 'hello', {}, U)
    const [copy] = moveCardsToBoard(src, dst, [n], { x: 0, y: 0 }, U)
    const m = getCards(src).get(n)!
    expect(m.get('movedTo')).toBe('b2')
    expect(m.get('movedId')).toBe(copy)
    expect(findEditedMovedCards(src)).toEqual([])
    // unrelated edits elsewhere and layout changes do not count as edits
    createCard(src, 'note', {}, U)
    updateCard(src, n, { x: 999, z: 50 }, U)
    expect(findEditedMovedCards(src)).toEqual([])
    expect(listTrash(src)).toHaveLength(0)
  })

  it("rescues a teammate's offline edit into the trash on both sides, and restoring keeps it", () => {
    const a = board()
    const b = board()
    const dst = board('b2')
    const n = createTextNote(a, 'start', {}, U)
    sync(a, b)
    const stopA = watchMovedCards(a)
    const stopB = watchMovedCards(b)
    // offline: Bob types, Alice moves the card into a sub-board
    appendText(b, n, ' + bob')
    moveCardsToBoard(a, dst, [n], { x: 0, y: 0 }, U)
    expect(text(dst, n)).toBe('start') // the copy cannot have Bob's edit
    expect(listTrash(a)).toHaveLength(0)
    // reconnect
    sync(b, a)
    sync(a, b)
    sync(b, a)
    for (const doc of [a, b]) {
      const entries = listTrash(doc)
      expect(entries).toHaveLength(1)
      expect(entries[0].id.endsWith(EDITED_GROUP_SUFFIX)).toBe(true)
      expect(getCards(doc).get(n)!.get('editedAfterMove')).toBe('b2')
      expect(getCards(doc).get(n)!.get('movedTo')).toBeUndefined()
    }
    expect(listTrash(a)[0].id).toBe(listTrash(b)[0].id) // peers agree on the entry
    restoreTrashEntry(a, listTrash(a)[0].id, U)
    expect(text(a, n)).toBe('start + bob')
    expect(isTrashed(getCards(a).get(n)!)).toBe(false)
    stopA()
    stopB()
  })

  it('detects edits deterministically, without a watcher (updates applied while the board was closed)', () => {
    const a = board()
    const b = board()
    const dst = board('b2')
    const n = createTextNote(a, 'one two', {}, U)
    sync(a, b)
    moveCardsToBoard(a, dst, [n], { x: 0, y: 0 }, U)
    // Bob only deletes text (no new items): still an edit after the move
    const frag = getCards(b).get(n)!.get('content') as Y.XmlFragment
    b.transact(() => ((frag.get(0) as Y.XmlElement).get(0) as Y.XmlText).delete(3, 4))
    sync(b, a)
    expect(findEditedMovedCards(a)).toEqual([n])
    // a watcher started later (board opened) rescues it right away
    const stop = watchMovedCards(a)
    expect(listTrash(a)).toHaveLength(1)
    stop()
  })

  it('does not flag edits the mover already had, on any peer', () => {
    const a = board()
    const b = board()
    const dst = board('b2')
    const n = createTextNote(a, 'start', {}, U)
    sync(a, b)
    appendText(b, n, ' + seen') // Alice receives this before moving
    sync(b, a)
    const stopB = watchMovedCards(b)
    moveCardsToBoard(a, dst, [n], { x: 0, y: 0 }, U)
    expect(text(dst, n)).toBe('start + seen')
    sync(a, b)
    expect(listTrash(b)).toHaveLength(0)
    expect(findEditedMovedCards(a)).toEqual([])
    stopB()
  })

  it('rescues cards hidden before fingerprints existed when their content changes', () => {
    const doc = board()
    const n = createTextNote(doc, 'old', {}, U)
    const layoutOnly = createTextNote(doc, 'old', {}, U)
    removeCards(doc, [n, layoutOnly], U, 'b2')
    for (const id of [n, layoutOnly]) getCards(doc).get(id)!.delete('movedState')
    const stop = watchMovedCards(doc)
    updateCard(doc, layoutOnly, { x: 40 }, U)
    expect(listTrash(doc)).toHaveLength(0)
    appendText(doc, n, ' edit')
    expect(listTrash(doc).map((e) => e.cards.map((c) => c.id))).toEqual([[n]])
    stop()
  })

  it('does not treat cached/derived fields as edits', () => {
    const src = board()
    const dst = board('b2')
    const id = createCard(src, 'board', { boardId: 'child000001', secret: 's', title: 'Old' }, U)
    moveCardsToBoard(src, dst, [id], { x: 0, y: 0 }, U)
    // collab/docs refreshes cached titles on board cards (moved ones included)
    src.transact(() => getCards(src).get(id)!.set('title', 'New'), SYSTEM_ORIGIN)
    expect(findEditedMovedCards(src)).toEqual([])
  })

  it('moves lines to a card that stays into the trash instead of hiding them', () => {
    const src = board()
    const dst = board('b2')
    const moved = createCard(src, 'note', {}, U)
    const stays = createCard(src, 'note', {}, U)
    const line = createCard(src, 'line', { from: { card: moved, x: 0, y: 0 }, to: { card: stays, x: 0, y: 0 } }, U)
    moveCardsToBoard(src, dst, [moved], { x: 0, y: 0 }, U)
    expect(getCards(src).get(line)!.get('movedTo')).toBeUndefined()
    expect(listTrash(src).map((e) => e.cards.map((c) => c.id))).toEqual([[line]])
    expect(getCards(dst).has(line)).toBe(false)
  })

  it('stacks cards that leave a column at the drop position instead of their stale x/y', () => {
    const src = board()
    const dst = board('b2')
    const col = createCard(src, 'column', { x: 1000, y: 1000 }, U)
    const a1 = createCard(src, 'note', { x: 5, y: 5 }, U)
    const a2 = createCard(src, 'note', { x: -400, y: 900 }, U)
    insertIntoColumn(src, [a1, a2], col, 0, U)
    const out = moveCardsToBoard(src, dst, [a1, a2], { x: 200, y: 300 }, U, { heightOf: (id) => (id === a1 ? 50 : undefined) })
    const placed = out.map((id) => readCard(getCards(dst).get(id)!)).sort((p, q) => p.y - q.y)
    expect(placed.map((c) => [c.id, c.x, c.y, c.parent])).toEqual([
      [a1, 200, 300, null],
      [a2, 200, 360, null],
    ])
  })

  it('undo helpers hide unchanged copies and show them again', () => {
    const src = board()
    const dst = board('b2')
    const n = createTextNote(src, 'x', {}, U)
    const [copy] = moveCardsToBoard(src, dst, [n], { x: 0, y: 0 }, U)
    const base = { [copy]: cardContentState(getCards(dst).get(copy)!) }
    const hidden = hideMovedCopies(dst, base, 'b1', U)!
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(true)
    expect(listTrash(dst)).toHaveLength(0)
    expect(unhideMovedCopies(dst, hidden)).toEqual([copy])
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(false)
    // edited meanwhile: undo leaves the copy visible
    appendText(dst, copy, '!')
    expect(hideMovedCopies(dst, base, 'b1', U)).toBeNull()
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(false)
  })

  it('restoring a trash entry never brings back hidden moved copies of the same group', () => {
    const doc = board()
    const a1 = createCard(doc, 'note', {}, U)
    const a2 = createCard(doc, 'note', {}, U)
    const g = deleteCards(doc, [a1, a2], U)!
    getCards(doc).get(a2)!.set('movedTo', 'elsewhere')
    expect(restoreTrashEntry(doc, g, U)).toEqual([a1])
    expect(isTrashed(getCards(doc).get(a2)!)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Duplicate / paste / nested boards

describe('copies', () => {
  it('duplicates a column child into the same column, right after the original', () => {
    const doc = board()
    const col = createCard(doc, 'column', { x: 1000, y: 1000 }, U)
    const a = createTextNote(doc, 'a', { x: 5, y: 5 }, U)
    const b = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [a, b], col, 0, U)
    const [copy] = duplicateCards(doc, [a], U)
    expect(readCard(getCards(doc).get(copy)!).parent).toBe(col)
    expect(columnChildren(doc, col)).toEqual([a, copy, b])
    expect(text(doc, copy)).toBe('a')
  })

  it('pastes column children (without their column) as a stack at the target', () => {
    const doc = board()
    const col = createCard(doc, 'column', { x: 1000, y: 1000 }, U)
    const a = createCard(doc, 'note', { x: 5, y: 5 }, U)
    const b = createCard(doc, 'note', { x: -300, y: 700 }, U)
    insertIntoColumn(doc, [a, b], col, 0, U)
    const other = board('b2')
    const ids = insertClonedCards(other, deserializeCards(serializeCards(doc, [a, b])), { x: 40, y: 50 }, U)
    const pasted = ids.map((id) => readCard(getCards(other).get(id)!)).sort((p, q) => p.y - q.y)
    expect(pasted.map((c) => [c.x, c.y])).toEqual([
      [40, 50],
      [40, 180],
    ])
  })

  it('keeps the displayed position of a card whose column was deleted', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const a = createCard(doc, 'note', { x: 70, y: 80 }, U)
    insertIntoColumn(doc, [a], col, 0, U)
    getCards(doc).get(col)!.set('trashedAt', Date.now()) // column deleted concurrently: `a` shows free at x/y
    const [copy] = duplicateCards(doc, [a], U)
    expect(readCard(getCards(doc).get(copy)!)).toMatchObject({ x: 100, y: 110, parent: null })
  })

  it('strips internal fields and unknown card types from pasted data', () => {
    const scratch = new Y.Doc()
    const cards = scratch.getMap<Y.Map<unknown>>('cards')
    const evil = new Y.Map<unknown>()
    const fields = { id: 'e1', type: 'note', trashedAt: 1, trashGroup: 'g', movedTo: 'x', previewBy: 'me', createdBy: 'attacker' }
    for (const [k, v] of Object.entries(fields)) evil.set(k, v)
    const weird = new Y.Map<unknown>()
    weird.set('id', 'w1')
    weird.set('type', 'script')
    cards.set('e1', evil)
    cards.set('w1', weird)
    const group = deserializeCards(Y.encodeStateAsUpdate(scratch))
    expect(group).toHaveLength(1)
    for (const k of ['trashedAt', 'trashGroup', 'movedTo', 'previewBy', 'createdBy']) expect(group[0].data[k]).toBeUndefined()
    const doc = board()
    const [id] = insertClonedCards(doc, group, { x: 0, y: 0 }, U)
    expect(isTrashed(getCards(doc).get(id)!)).toBe(false)
    expect(readCard(getCards(doc).get(id)!).createdBy).toBe(U)
  })

  it('gives duplicated and pasted board cards their own new child board', () => {
    const doc = board()
    const id = createCard(doc, 'board', { boardId: 'child000001', secret: 'secret-a', title: 'Plans' }, U)
    const forks: BoardFork[] = []
    const [copy] = duplicateCards(doc, [id], U, undefined, { forks })
    const c = readCard(getCards(doc).get(copy)!) as unknown as { boardId: string; secret: string }
    expect(c.boardId).not.toBe('child000001')
    expect(c.secret).not.toBe('secret-a')
    expect(forks).toEqual([{ from: 'child000001', to: c.boardId, secret: c.secret, title: 'Plans' }])
    // paste: forkBoardCards rewrites the detached group before insertion
    const group = deserializeCards(serializeCards(doc, [id]))
    expect(group[0].data.secret).toBeUndefined() // the clipboard never carries a board secret
    const pasteForks = forkBoardCards(group)
    expect(pasteForks[0].from).toBe('child000001')
    expect(group[0].data.boardId).toBe(pasteForks[0].to)
    expect(group[0].data.secret).toBe(pasteForks[0].secret)
  })

  it("copies a nested board's content into the new board, forking boards nested deeper", () => {
    const child = board('child000001')
    initBoardDoc(child, { id: 'child000001', title: 'Plans', parentId: 'b1' }, U)
    const note = createTextNote(child, 'inside', { x: 7, y: 8 }, U)
    const gone = createCard(child, 'note', {}, U)
    deleteCards(child, [gone], U)
    const grand = createCard(child, 'board', { boardId: 'grand000001', secret: 'secret-g', title: 'Deeper' }, U)
    const copy = board('copy0000001')
    const forks = copyBoardContent(child, copy, { parentId: 'b9', userId: U })
    expect(readMeta(copy)).toMatchObject({ id: 'copy0000001', title: 'Plans', parentId: 'b9', shared: false })
    expect(text(copy, note)).toBe('inside')
    expect(readCard(getCards(copy).get(note)!)).toMatchObject({ x: 7, y: 8 })
    expect(getCards(copy).has(gone)).toBe(false) // trash is not copied
    const g = readCard(getCards(copy).get(grand)!) as unknown as { boardId: string; secret: string }
    expect(forks).toEqual([{ from: 'grand000001', to: g.boardId, secret: g.secret, title: 'Deeper' }])
    expect(g.boardId).not.toBe('grand000001')
    // never fills a board twice
    expect(copyBoardContent(child, copy, { parentId: 'b9', userId: U })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Malformed peer data, clocks

describe('robustness against malformed peer data', () => {
  it('ignores non-map entries in the cards map', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const n = createCard(doc, 'note', {}, U)
    const raw = getCards(doc) as unknown as Y.Map<unknown>
    raw.set('junk', 5)
    raw.set('text', new Y.Text('x'))
    expect(() => createCard(doc, 'note', {}, U)).not.toThrow()
    expect(() => insertIntoColumn(doc, [n, 'junk'], col, 0, U)).not.toThrow()
    expect(columnChildren(doc, col)).toEqual([n])
    expect(() => sendToBack(doc, [n], U)).not.toThrow()
    expect(() => bringToFront(doc, [n, 'junk'], U)).not.toThrow()
    expect(() => duplicateCards(doc, [n, 'junk'], U)).not.toThrow()
    const g = deleteCards(doc, [n, 'junk'], U)!
    expect(() => restoreTrashEntry(doc, g, U)).not.toThrow()
    expect(() => serializeCards(doc, [n, 'junk'])).not.toThrow()
    expect(getCardMap(doc, 'junk')).toBeUndefined()
  })

  it('inserts into a column whose children have malformed order keys (re-keying them)', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const [a, b, c] = [0, 1, 2].map(() => createCard(doc, 'note', {}, U))
    insertIntoColumn(doc, [a, b], col, 0, U)
    getCards(doc).get(a)!.set('order', 'a00') // invalid: trailing zero
    expect(isValidOrderKey('a00')).toBe(false)
    expect(() => insertIntoColumn(doc, [c], col, 1, U)).not.toThrow()
    expect(columnChildren(doc, col)).toEqual([a, c, b])
    for (const id of [a, b, c]) expect(isValidOrderKey(getCards(doc).get(id)!.get('order'))).toBe(true)
    expect(() => orderKeyAt(doc, [a, b], 1)).not.toThrow()
  })

  it("does not trust the deleting device's clock when purging", () => {
    const doc = board()
    const id = createCard(doc, 'note', {}, U)
    const now = Date.now()
    deleteCards(doc, [id], U)
    // the deleter's clock was a year behind
    getCards(doc).get(id)!.set('trashedAt', now - 365 * DAY)
    purgeExpiredTrash(doc, now, () => now) // first seen on this device just now
    expect(getCards(doc).has(id)).toBe(true)
    purgeExpiredTrash(doc, now + 100 * DAY, () => now)
    expect(getCards(doc).has(id)).toBe(false)
    // a timestamp in the future counts as now
    const later = createCard(doc, 'note', {}, U)
    deleteCards(doc, [later], U)
    getCards(doc).get(later)!.set('trashedAt', now + 3650 * DAY)
    purgeExpiredTrash(doc, now + 100 * DAY)
    expect(getCards(doc).has(later)).toBe(true)
  })
})
