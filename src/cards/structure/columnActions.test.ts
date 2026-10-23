import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import {
  columnChildren,
  createCard,
  createTextNote,
  forEachActiveCard,
  getCardMap,
  getCards,
  getMeta,
  getTrash,
  insertIntoColumn,
  isTrashed,
  listTrash,
  LOCAL_ORIGIN,
  setFragmentText,
  updateCard,
} from '../../model/board'
import type { BoardContextValue } from '../../board/BoardContext'
import { CardIndex } from '../../board/cardIndex'
import { attachMoveUndo } from '../../board/moveUndo'
import { docs } from '../../collab/docs'
import { getLibraryEntry, useLibrary } from '../../collab/library'
import { addComment } from './thread'
import {
  convertColumnToBoard,
  isUnfinishedTodo,
  orderKeysAroundLocked,
  sortColumn,
  sortEntriesFor,
  sortKeyOf,
  visibleColumnChildren,
} from './columnActions'

const U = 'user1'

function todoWith(doc: Y.Doc, items: { text: string; checked: boolean }[], fields: Record<string, unknown> = {}): string {
  const id = createCard(doc, 'todo', fields, U)
  const frag = getCardMap(doc, id)!.get('content') as Y.XmlFragment
  const list = new Y.XmlElement('taskList')
  list.insert(
    0,
    items.map((it) => {
      const item = new Y.XmlElement('taskItem')
      item.setAttribute('checked', it.checked as unknown as string)
      const p = new Y.XmlElement('paragraph')
      const t = new Y.XmlText()
      t.insert(0, it.text)
      p.insert(0, [t])
      item.insert(0, [p])
      return item
    }),
  )
  frag.insert(0, [list])
  return id
}

function setup() {
  const doc = new Y.Doc()
  const index = new CardIndex(doc)
  const undo = new Y.UndoManager([getCards(doc), getMeta(doc), getTrash(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
  const ctx = { boardId: 'b1', doc, cards: getCards(doc), index, undo, readOnly: false, isHome: false } as unknown as BoardContextValue
  return { doc, index, undo, ctx }
}

describe('sort keys', () => {
  it('uses the title or name, then the first line of text, then the link or colour', () => {
    const doc = new Y.Doc()
    const note = createCard(doc, 'note', {}, U)
    setFragmentText(getCardMap(doc, note)!.get('content') as Y.XmlFragment, '\n  Groceries  \nmilk')
    const board = createCard(doc, 'board', { title: '  Trip   plans ' }, U)
    const file = createCard(doc, 'file', { name: 'report.pdf' }, U)
    const link = createCard(doc, 'link', { url: 'https://example.com', title: '' }, U)
    const swatch = createCard(doc, 'swatch', { hex: '#ff0000', name: '' }, U)
    const todo = todoWith(doc, [{ text: 'Buy milk', checked: false }])
    const comment = createCard(doc, 'comment', {}, U)
    addComment(doc, getCardMap(doc, comment)!, { id: U, name: 'U', color: '#000000' }, 'First thought', 1)
    const empty = createCard(doc, 'note', {}, U)
    const key = (id: string) => sortKeyOf(getCardMap(doc, id)!)
    expect(key(note)).toBe('Groceries')
    expect(key(board)).toBe('Trip plans')
    expect(key(file)).toBe('report.pdf')
    expect(key(link)).toBe('https://example.com')
    expect(key(swatch)).toBe('#ff0000')
    expect(key(todo)).toBe('Buy milk')
    expect(key(comment)).toBe('First thought')
    expect(key(empty)).toBe('')
  })

  it('knows which to-do lists have unchecked tasks', () => {
    const doc = new Y.Doc()
    const open = todoWith(doc, [{ text: 'a', checked: true }, { text: 'b', checked: false }])
    const done = todoWith(doc, [{ text: 'a', checked: true }])
    const empty = todoWith(doc, [])
    const note = createCard(doc, 'note', {}, U)
    expect(isUnfinishedTodo(getCardMap(doc, open)!)).toBe(true)
    expect(isUnfinishedTodo(getCardMap(doc, done)!)).toBe(false)
    expect(isUnfinishedTodo(getCardMap(doc, empty)!)).toBe(false)
    expect(isUnfinishedTodo(getCardMap(doc, note)!)).toBe(false)
    expect(sortEntriesFor(doc, [open, done, 'missing']).map((e) => [e.id, e.unfinished])).toEqual([
      [open, true],
      [done, false],
    ])
  })
})

describe('sortColumn', () => {
  it('writes new order keys in one undo step', () => {
    const { doc, ctx, undo } = setup()
    const col = createCard(doc, 'column', {}, U)
    const ids = ['Cherry', 'apple', 'Banana'].map((title) => createCard(doc, 'board', { title }, U))
    insertIntoColumn(doc, ids, col, 0, U)
    undo.clear()
    const before = columnChildren(doc, col)
    expect(sortColumn(ctx, col, 'title-asc')).toBe(true)
    expect(columnChildren(doc, col)).toEqual([ids[1], ids[2], ids[0]])
    expect(undo.undoStack).toHaveLength(1)
    undo.undo()
    expect(columnChildren(doc, col)).toEqual(before)
  })

  it('does nothing when the order would not change or the column is too small', () => {
    const { doc, ctx, undo } = setup()
    const col = createCard(doc, 'column', {}, U)
    const ids = ['a', 'b'].map((title) => createCard(doc, 'board', { title }, U))
    insertIntoColumn(doc, ids, col, 0, U)
    undo.clear()
    expect(sortColumn(ctx, col, 'title-asc')).toBe(false)
    expect(undo.undoStack).toHaveLength(0)
    const single = createCard(doc, 'column', {}, U)
    insertIntoColumn(doc, [createCard(doc, 'note', {}, U)], single, 0, U)
    expect(sortColumn(ctx, single, 'title-desc')).toBe(false)
  })
})

describe('visibleColumnChildren', () => {
  it('leaves out comments pinned to a card', () => {
    const { doc, index } = setup()
    const col = createCard(doc, 'column', {}, U)
    const note = createCard(doc, 'note', {}, U)
    const free = createCard(doc, 'comment', {}, U)
    const pinned = createCard(doc, 'comment', { attachedTo: note }, U)
    insertIntoColumn(doc, [note, free, pinned], col, 0, U)
    expect(visibleColumnChildren(index.getSnapshot(), col, (id) => index.get(id))).toEqual([note, free])
  })
})

describe('sortColumn with locks', () => {
  it('keeps locked cards in their places and sorts the others around them', () => {
    const { doc, ctx, undo } = setup()
    const col = createCard(doc, 'column', {}, U)
    const ids = ['Cherry', 'apple', 'Banana', 'Date'].map((title) => createCard(doc, 'board', { title }, U))
    insertIntoColumn(doc, ids, col, 0, U)
    updateCard(doc, ids[2], { locked: true }, U)
    const lockedKey = getCardMap(doc, ids[2])!.get('order')
    undo.clear()
    expect(sortColumn(ctx, col, 'title-asc')).toBe(true)
    expect(columnChildren(doc, col)).toEqual([ids[1], ids[0], ids[2], ids[3]])
    expect(getCardMap(doc, ids[2])!.get('order')).toBe(lockedKey)
    expect(undo.undoStack).toHaveLength(1)
  })

  it('does not sort a locked column', () => {
    const { doc, ctx, undo } = setup()
    const col = createCard(doc, 'column', { locked: true }, U)
    const ids = ['b', 'a'].map((title) => createCard(doc, 'board', { title }, U))
    insertIntoColumn(doc, ids, col, 0, U)
    undo.clear()
    expect(sortColumn(ctx, col, 'title-asc')).toBe(false)
    expect(columnChildren(doc, col)).toEqual(ids)
    expect(undo.undoStack).toHaveLength(0)
  })

  it('gives each run of unlocked cards keys between the locked ones', () => {
    const keys = orderKeysAroundLocked([
      { id: 'a', locked: false, order: 'zz' },
      { id: 'L', locked: true, order: 'a5' },
      { id: 'b', locked: false, order: 'a0' },
      { id: 'c', locked: false, order: 'a1' },
    ])!
    expect(keys.a < 'a5').toBe(true)
    expect('a5' < keys.b && keys.b < keys.c).toBe(true)
    expect(keys.L).toBeUndefined()
    // A locked card whose key cannot bound a run.
    expect(orderKeysAroundLocked([{ id: 'L', locked: true, order: 42 }, { id: 'a', locked: false, order: 'a0' }])).toBeNull()
    expect(
      orderKeysAroundLocked([
        { id: 'L1', locked: true, order: 'a5' },
        { id: 'a', locked: false, order: 'a0' },
        { id: 'L2', locked: true, order: 'a5' },
      ]),
    ).toBeNull()
  })
})

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

/** Active cards of a board, read from its loaded doc. */
async function activeCards(boardId: string): Promise<{ id: string; type: unknown; parent: unknown }[]> {
  return docs.withDoc(boardId, (d) => {
    const out: { id: string; type: unknown; parent: unknown }[] = []
    forEachActiveCard(d, (m, id) => out.push({ id, type: m.get('type'), parent: m.get('parent') ?? null }))
    return out
  })
}

describe('convertColumnToBoard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function convertSetup() {
    const s = setup()
    const detach = attachMoveUndo(s.doc, s.undo)
    const col = createCard(s.doc, 'column', { title: 'Ideas', color: 'red', x: 120, y: 240 }, U)
    const notes = ['one', 'two'].map((t) => createTextNote(s.doc, t, {}, U))
    insertIntoColumn(s.doc, notes, col, 0, U)
    return { ...s, detach, col, notes }
  }

  it('moves the cards into a new board in one undo step, and one undo brings the column back', async () => {
    const { doc, ctx, undo, detach, col, notes } = convertSetup()
    undo.clear()
    const boardCard = await convertColumnToBoard(ctx, col)
    expect(boardCard).toBeTruthy()
    const bm = getCardMap(doc, boardCard!)!
    expect([bm.get('title'), bm.get('color'), bm.get('x'), bm.get('y')]).toEqual(['Ideas', 'red', 120, 240])
    const boardId = bm.get('boardId') as string
    expect(getLibraryEntry(boardId)?.secret).toBe(bm.get('secret'))
    expect(isTrashed(getCardMap(doc, col)!)).toBe(true)
    for (const n of notes) expect(isTrashed(getCardMap(doc, n)!)).toBe(true)
    const moved = await activeCards(boardId)
    expect(moved).toHaveLength(2)
    expect(moved.every((c) => c.type === 'note' && c.parent === null)).toBe(true)
    // Only the (now empty) column is in the trash.
    expect(listTrash(doc).flatMap((e) => e.cards.map((c) => c.id))).toEqual([col])
    expect(undo.undoStack).toHaveLength(1)

    undo.undo()
    await settle()
    expect(getCardMap(doc, boardCard!)).toBeUndefined()
    expect(isTrashed(getCardMap(doc, col)!)).toBe(false)
    expect(columnChildren(doc, col)).toEqual(notes)
    expect(await activeCards(boardId)).toEqual([])
    detach()
  })

  it('keeps comments that are pinned elsewhere but still name the column as parent', async () => {
    const { doc, ctx, detach, col, notes } = convertSetup()
    const outside = createTextNote(doc, 'outside', {}, U)
    const elsewhere = createCard(doc, 'comment', { attachedTo: outside }, U)
    const onColumn = createCard(doc, 'comment', { attachedTo: col }, U)
    insertIntoColumn(doc, [elsewhere, onColumn], col, 2, U)
    expect(visibleColumnChildren(ctx.index.getSnapshot(), col, (id) => ctx.index.get(id))).toEqual(notes)
    const boardCard = await convertColumnToBoard(ctx, col)
    expect(boardCard).toBeTruthy()
    const e = getCardMap(doc, elsewhere)!
    expect(isTrashed(e)).toBe(false)
    expect([e.get('attachedTo'), e.get('parent'), e.has('order')]).toEqual([outside, null, false])
    const c = getCardMap(doc, onColumn)!
    expect(isTrashed(c)).toBe(false)
    expect([c.get('attachedTo'), c.get('parent')]).toEqual([boardCard, null])
    expect(listTrash(doc).flatMap((t) => t.cards.map((x) => x.id))).toEqual([col])
    detach()
  })

  it('refuses a locked column', async () => {
    const { doc, ctx, undo, detach, col, notes } = convertSetup()
    updateCard(doc, col, { locked: true }, U)
    undo.clear()
    const before = Object.keys(useLibrary.getState().entries).length
    expect(await convertColumnToBoard(ctx, col)).toBeNull()
    expect(isTrashed(getCardMap(doc, col)!)).toBe(false)
    expect(columnChildren(doc, col)).toEqual(notes)
    expect(Object.keys(useLibrary.getState().entries)).toHaveLength(before)
    expect(undo.undoStack).toHaveLength(0)
    detach()
  })

  it('leaves no board, trash entry or undo step behind when the new board cannot be opened', async () => {
    const { doc, ctx, undo, detach, col, notes } = convertSetup()
    undo.clear()
    const before = Object.keys(useLibrary.getState().entries).length
    vi.spyOn(docs, 'withDoc').mockRejectedValueOnce(new Error('storage failed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await convertColumnToBoard(ctx, col)).toBeNull()
    expect(isTrashed(getCardMap(doc, col)!)).toBe(false)
    expect(columnChildren(doc, col)).toEqual(notes)
    let boards = 0
    forEachActiveCard(doc, (m) => void (m.get('type') === 'board' && boards++))
    expect(boards).toBe(0)
    expect(listTrash(doc)).toEqual([])
    expect(undo.undoStack).toHaveLength(0)
    expect(Object.keys(useLibrary.getState().entries)).toHaveLength(before)
    detach()
  })
})
