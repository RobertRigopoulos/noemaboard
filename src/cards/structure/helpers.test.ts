import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, initBoardDoc, insertIntoColumn, columnChildren, removeCards, restoreTrashEntry } from '../../model/board'
import {
  avatarInitials,
  cardCountLabel,
  cleanTitle,
  columnChildIds,
  commentCountLabel,
  contentsLabel,
  countFreeCards,
  displayBoardTitle,
  insertionSlot,
  isBoardDocReady,
  pluralNoun,
  sameIds,
  sanitizeIcon,
  sortChildren,
  sortColumnEntries,
  truncate,
  type ChildCandidate,
  type ColumnSortMode,
  type SortEntry,
} from './helpers'
import { BOARD_ICONS } from '../../model/boardIcons'
import { BOARD_ICON_COMPONENT_IDS } from '../../ui/icons/BoardIcon'

const U = 'user1'

describe('sortChildren', () => {
  it('sorts by fractional order, then id', () => {
    const sorted = sortChildren([
      { id: 'c', order: 'a1' },
      { id: 'b', order: 'a0' },
      { id: 'a', order: 'a1' },
      { id: 'z', order: 'Zz' },
    ])
    expect(sorted.map((e) => e.id)).toEqual(['z', 'b', 'a', 'c'])
  })

  it('uses code-unit order, not locale order', () => {
    // 'B' (66) sorts before 'a' (97) in fractional-indexing keys.
    expect(sortChildren([{ id: '1', order: 'a' }, { id: '2', order: 'B' }]).map((e) => e.id)).toEqual(['2', '1'])
  })

  it('does not mutate the input', () => {
    const input = [
      { id: 'b', order: 'a1' },
      { id: 'a', order: 'a0' },
    ]
    sortChildren(input)
    expect(input[0].id).toBe('b')
  })

  it('matches the model ordering used for drops', () => {
    const doc = new Y.Doc()
    const col = createCard(doc, 'column', {}, U)
    const ids = [createCard(doc, 'note', {}, U), createCard(doc, 'todo', {}, U), createCard(doc, 'image', {}, U)]
    insertIntoColumn(doc, ids, col, 0, U)
    const extra = createCard(doc, 'note', {}, U)
    insertIntoColumn(doc, [extra], col, 1, U)
    const entries: ChildCandidate[] = []
    doc.getMap<Y.Map<unknown>>('cards').forEach((m, id) => {
      entries.push({ id, order: m.get('order') as string, parent: (m.get('parent') as string) ?? null, type: m.get('type') as ChildCandidate['type'] })
    })
    expect(columnChildIds(entries, col)).toEqual(columnChildren(doc, col))
    expect(columnChildIds(entries, col)[1]).toBe(extra)
  })
})

describe('columnChildIds', () => {
  it('ignores columns, lines and the column itself even if a peer parents them', () => {
    const entries: ChildCandidate[] = [
      { id: 'col', order: 'a0', parent: 'col', type: 'column' },
      { id: 'col2', order: 'a0', parent: 'col', type: 'column' },
      { id: 'line', order: 'a0', parent: 'col', type: 'line' },
      { id: 'n1', order: 'a2', parent: 'col', type: 'note' },
      { id: 'n2', order: 'a1', parent: 'col', type: 'board' },
      { id: 'n3', order: 'a0', parent: null, type: 'note' },
      { id: 'n4', order: 'a0', parent: 'other', type: 'note' },
    ]
    expect(columnChildIds(entries, 'col')).toEqual(['n2', 'n1'])
  })
})

describe('sameIds', () => {
  it('compares element-wise', () => {
    expect(sameIds(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameIds(['a'], ['a', 'b'])).toBe(false)
    expect(sameIds([], [])).toBe(true)
  })
})

describe('insertionSlot', () => {
  const kids = ['a', 'b', 'c']
  it('draws before the child at the index', () => {
    expect(insertionSlot(kids, new Set(), 0)).toEqual({ id: 'a', edge: 'before' })
    expect(insertionSlot(kids, new Set(), 2)).toEqual({ id: 'c', edge: 'before' })
  })
  it('draws after the last child at the end', () => {
    expect(insertionSlot(kids, new Set(), 3)).toEqual({ id: 'c', edge: 'after' })
    expect(insertionSlot(kids, new Set(), Number.MAX_SAFE_INTEGER)).toEqual({ id: 'c', edge: 'after' })
  })
  it('skips dragged children because drop indexes exclude them', () => {
    expect(insertionSlot(kids, new Set(['a']), 0)).toEqual({ id: 'b', edge: 'before' })
    expect(insertionSlot(kids, new Set(['b']), 1)).toEqual({ id: 'c', edge: 'before' })
    expect(insertionSlot(kids, new Set(['c']), 2)).toEqual({ id: 'b', edge: 'after' })
  })
  it('handles empty columns and inactive targets', () => {
    expect(insertionSlot([], new Set(), 0)).toBeNull()
    expect(insertionSlot(kids, new Set(), -1)).toBeNull()
    expect(insertionSlot(['a'], new Set(['a']), 0)).toEqual({ id: 'a', edge: 'before' })
  })
})

describe('titles and labels', () => {
  it('cleans titles to a single capped line', () => {
    expect(cleanTitle('  Hello\n\tworld  ', 100)).toBe('Hello world')
    expect(cleanTitle('x'.repeat(500), 200)).toHaveLength(200)
    expect(cleanTitle(42, 100)).toBe('')
    expect(cleanTitle(null, 100)).toBe('')
  })

  it('truncates without splitting emoji', () => {
    expect(truncate('ab🚀', 3)).toBe('ab')
    expect(truncate('ab🚀', 4)).toBe('ab🚀')
    expect(truncate('abc', 10)).toBe('abc')
    expect(cleanTitle('x'.repeat(199) + '🚀', 200)).toHaveLength(199)
  })

  it('builds avatar initials', () => {
    expect(avatarInitials('Alice Smith')).toBe('AS')
    expect(avatarInitials('  bob  ')).toBe('B')
    expect(avatarInitials('Ana María López')).toBe('AL')
    expect(avatarInitials('🦊 Fox')).toBe('🦊F')
    expect(avatarInitials('')).toBe('?')
  })

  it('pluralises counts', () => {
    expect(cardCountLabel(0)).toBe('0 cards')
    expect(cardCountLabel(1)).toBe('1 card')
    expect(cardCountLabel(12)).toBe('12 cards')
    expect(commentCountLabel(1)).toBe('1 comment')
    expect(commentCountLabel(3)).toBe('3 comments')
    expect(cardCountLabel(Number.NaN)).toBe('0 cards')
  })

  it('prefers the library title, then the cached card title', () => {
    expect(displayBoardTitle('Roadmap', 'Old')).toBe('Roadmap')
    expect(displayBoardTitle(undefined, 'Cached')).toBe('Cached')
    expect(displayBoardTitle('   ', 'Cached')).toBe('Cached')
    expect(displayBoardTitle(undefined, 7)).toBe('Untitled board')
  })

  it('accepts known icon ids only', () => {
    expect(sanitizeIcon('rocket')).toBe('rocket')
    // Emoji and free text are not board icons.
    expect(sanitizeIcon('🚀')).toBeNull()
    expect(sanitizeIcon('rocket ship')).toBeNull()
    expect(sanitizeIcon(' A ')).toBeNull()
    expect(sanitizeIcon('')).toBeNull()
    expect(sanitizeIcon('<img src=x>')).toBeNull()
    expect(sanitizeIcon('a very long string that is not an icon')).toBeNull()
    expect(sanitizeIcon(5)).toBeNull()
  })

  it('has unique board icons that all pass sanitisation and have a component', () => {
    const ids = BOARD_ICONS.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(sanitizeIcon(id)).toBe(id)
    expect(new Set(BOARD_ICON_COMPONENT_IDS)).toEqual(new Set(ids))
  })
})

describe('child board stats', () => {
  it('counts free cards, excluding column children and lines', () => {
    const doc = new Y.Doc({ guid: 'child' })
    expect(isBoardDocReady(doc)).toBe(false)
    initBoardDoc(doc, { id: 'child' }, U)
    expect(isBoardDocReady(doc)).toBe(true)
    expect(countFreeCards(doc)).toBe(0)
    const col = createCard(doc, 'column', {}, U)
    const a = createCard(doc, 'note', {}, U)
    createCard(doc, 'note', {}, U)
    createCard(doc, 'line', {}, U)
    expect(countFreeCards(doc)).toBe(3)
    insertIntoColumn(doc, [a], col, 0, U)
    expect(countFreeCards(doc)).toBe(2)
  })

  it('does not count deleted cards or copies hidden after a move to another board', () => {
    const doc = new Y.Doc({ guid: 'child2' })
    initBoardDoc(doc, { id: 'child2' }, U)
    const ids = Array.from({ length: 4 }, () => createCard(doc, 'note', {}, U))
    expect(countFreeCards(doc)).toBe(4)
    const group = deleteCards(doc, ids.slice(0, 2), U)
    expect(countFreeCards(doc)).toBe(2)
    removeCards(doc, [ids[2]], U, 'other-board')
    expect(countFreeCards(doc)).toBe(1)
    restoreTrashEntry(doc, group!, U)
    expect(countFreeCards(doc)).toBe(3)
  })

  it('does not count comments pinned to a card, but counts free and orphaned ones', () => {
    const doc = new Y.Doc({ guid: 'child3' })
    initBoardDoc(doc, { id: 'child3' }, U)
    const note = createCard(doc, 'note', {}, U)
    for (let i = 0; i < 3; i++) createCard(doc, 'comment', { attachedTo: note }, U)
    expect(countFreeCards(doc)).toBe(1)
    createCard(doc, 'comment', {}, U)
    createCard(doc, 'comment', { attachedTo: 'missingCard1' }, U)
    expect(countFreeCards(doc)).toBe(3)
    // Pinned to a card in the Unsorted drawer: not drawn as a marker, so it is a card of its own.
    const parked = createCard(doc, 'note', { unsorted: true }, U)
    createCard(doc, 'comment', { attachedTo: parked }, U)
    expect(countFreeCards(doc)).toBe(5)
    // Their card deleted, the pinned comments go with it.
    deleteCards(doc, [note], U)
    expect(countFreeCards(doc)).toBe(4)
  })
})

describe('contentsLabel', () => {
  const label = (t: string) => ({ note: 'Note', todo: 'To-do', board: 'Board', image: 'Image', sketch: 'Sketch', swatch: 'Color', box: 'Box' })[t] ?? ''

  it('counts each type in order of first appearance, with plurals', () => {
    expect(contentsLabel(['note', 'board', 'note', 'image', 'note', 'image'], label)).toBe('3 notes, 1 board, 2 images')
    expect(contentsLabel(['todo', 'todo', 'sketch', 'sketch', 'swatch'], label)).toBe('2 to-dos, 2 sketches, 1 color')
    expect(contentsLabel(['image'], label)).toBe('1 image')
  })

  it('says when a column is empty and falls back for unknown labels', () => {
    expect(contentsLabel([], label)).toBe('No cards')
    expect(contentsLabel(['file', 'file'], () => '')).toBe('2 cards')
  })

  it('pluralises nouns ending in s, x, z, ch and sh', () => {
    expect(pluralNoun('box')).toBe('boxes')
    expect(pluralNoun('sketch')).toBe('sketches')
    expect(pluralNoun('note')).toBe('notes')
  })
})

describe('sortColumnEntries', () => {
  const e = (id: string, key: string, createdAt = 0, type: SortEntry['type'] = 'note', unfinished = false): SortEntry => ({ id, type, key, createdAt, unfinished })
  const order = (list: SortEntry[], mode: ColumnSortMode) => sortColumnEntries(list, mode).map((x) => x.id)

  it('sorts titles A to Z and Z to A, ignoring case and accents, untitled cards last', () => {
    const list = [e('1', 'banana'), e('2', ''), e('3', 'Apple'), e('4', 'cherry'), e('5', 'Éclair')]
    expect(order(list, 'title-asc')).toEqual(['3', '1', '4', '5', '2'])
    expect(order(list, 'title-desc')).toEqual(['5', '4', '1', '3', '2'])
  })

  it('compares numbers inside titles by value', () => {
    const list = [e('a', 'Item 10'), e('b', 'Item 2'), e('c', 'Item 1')]
    expect(order(list, 'title-asc')).toEqual(['c', 'b', 'a'])
  })

  it('is stable: equal keys keep their current order', () => {
    const list = [e('x', 'same'), e('y', 'Same'), e('z', 'SAME'), e('w', '')]
    expect(order(list, 'title-asc')).toEqual(['x', 'y', 'z', 'w'])
    expect(order(list, 'title-desc')).toEqual(['x', 'y', 'z', 'w'])
    expect(order([e('p', '', 5), e('q', '', 5), e('r', '', 1)], 'newest')).toEqual(['p', 'q', 'r'])
  })

  it('sorts by creation time both ways', () => {
    const list = [e('mid', '', 20), e('old', '', 10), e('new', '', 30), e('bad', '', Number.NaN)]
    expect(order(list, 'newest')).toEqual(['new', 'mid', 'old', 'bad'])
    expect(order(list, 'oldest')).toEqual(['bad', 'old', 'mid', 'new'])
  })

  it('groups by type in a fixed order', () => {
    const list = [e('i', '', 0, 'image'), e('n1', '', 0, 'note'), e('b', '', 0, 'board'), e('t', '', 0, 'todo'), e('n2', '', 0, 'note')]
    expect(order(list, 'type')).toEqual(['n1', 'n2', 't', 'i', 'b'])
  })

  it('puts unfinished to-dos first and keeps everything else in place', () => {
    const list = [e('n', ''), e('done', '', 0, 'todo'), e('open1', '', 0, 'todo', true), e('img', '', 0, 'image'), e('open2', '', 0, 'todo', true)]
    expect(order(list, 'unfinished')).toEqual(['open1', 'open2', 'n', 'done', 'img'])
  })

  it('does not mutate its input', () => {
    const list = [e('b', 'b'), e('a', 'a')]
    sortColumnEntries(list, 'title-asc')
    expect(list.map((x) => x.id)).toEqual(['b', 'a'])
  })
})

describe('columnChildIds keep filter', () => {
  it('drops entries the filter rejects', () => {
    const entries: ChildCandidate[] = [
      { id: 'a', order: 'a0', parent: 'col', type: 'note' },
      { id: 'c', order: 'a1', parent: 'col', type: 'comment' },
    ]
    expect(columnChildIds(entries, 'col', (x) => x.type !== 'comment')).toEqual(['a'])
    expect(columnChildIds(entries, 'col')).toEqual(['a', 'c'])
  })
})
