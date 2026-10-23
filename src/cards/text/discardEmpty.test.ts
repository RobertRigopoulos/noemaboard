import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, getMeta, getTrash, isTrashed, LOCAL_ORIGIN, updateCard } from '../../model/board'
import { discardEmptyCard, FRESH_CARD_MS, isFreshCard, stepOnlyCreates } from './discardEmpty'

const U = 'user1'

function board() {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager([getCards(doc), getMeta(doc), getTrash(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 })
  return { doc, undo }
}

describe('discardEmptyCard', () => {
  it('undoes and forgets the creation step, so no undo or redo brings the empty card back', () => {
    const { doc, undo } = board()
    const other = createCard(doc, 'note', { x: 0 }, U)
    undo.stopCapturing()
    updateCard(doc, other, { x: 100 }, U)
    undo.stopCapturing()
    const id = createCard(doc, 'note', {}, U)
    expect(stepOnlyCreates(doc, undo.undoStack[undo.undoStack.length - 1], getCards(doc).get(id)!)).toBe(true)
    discardEmptyCard(doc, undo, id, U)
    expect(getCards(doc).has(id)).toBe(false)
    expect(undo.redoStack).toHaveLength(0)
    // The next Ctrl+Z undoes what came before (the move), not the empty card.
    undo.undo()
    expect(getCards(doc).get(other)!.get('x')).toBe(0)
    expect(getCards(doc).has(id)).toBe(false)
  })

  it('also unwinds text typed and erased again in the new card', () => {
    const { doc, undo } = board()
    const before = createCard(doc, 'note', {}, U)
    undo.stopCapturing()
    const id = createCard(doc, 'todo', {}, U)
    undo.stopCapturing()
    const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
    doc.transact(() => frag.insert(0, [new Y.XmlElement('paragraph')]), LOCAL_ORIGIN)
    undo.stopCapturing()
    updateCard(doc, id, { title: 'x' }, U)
    undo.stopCapturing()
    updateCard(doc, id, { title: '' }, U)
    undo.stopCapturing()
    doc.transact(() => frag.delete(0, frag.length), LOCAL_ORIGIN)
    discardEmptyCard(doc, undo, id, U)
    expect(getCards(doc).has(id)).toBe(false)
    expect(undo.redoStack).toHaveLength(0)
    expect(undo.undoStack).toHaveLength(1)
    expect(getCards(doc).has(before)).toBe(true)
  })

  it('never undoes a step that also changed other cards', () => {
    const { doc, undo } = board()
    const other = createCard(doc, 'note', { x: 0 }, U)
    undo.stopCapturing()
    // The double-click came right after a move: both land in one undo step.
    updateCard(doc, other, { x: 100 }, U)
    const id = createCard(doc, 'note', {}, U)
    expect(stepOnlyCreates(doc, undo.undoStack[undo.undoStack.length - 1], getCards(doc).get(id)!)).toBe(false)
    discardEmptyCard(doc, undo, id, U)
    // Hidden like a card moved away (not in the trash), and the move is untouched.
    const m = getCards(doc).get(id)!
    expect(isTrashed(m)).toBe(true)
    expect(m.get('movedTo')).toBeTruthy()
    expect(getCards(doc).get(other)!.get('x')).toBe(100)
  })

  it('hides the card when there is no history to use', () => {
    const { doc } = board()
    const id = createCard(doc, 'todo', {}, U)
    discardEmptyCard(doc, null, id, U)
    expect(isTrashed(getCards(doc).get(id)!)).toBe(true)
  })
})

describe('isFreshCard', () => {
  it('only counts cards this person just made', () => {
    const now = 5_000_000
    expect(isFreshCard({ createdBy: U, createdAt: now - 500 }, U, now)).toBe(true)
    expect(isFreshCard({ createdBy: 'peer', createdAt: now - 500 }, U, now)).toBe(false)
    expect(isFreshCard({ createdBy: U, createdAt: now - FRESH_CARD_MS - 1 }, U, now)).toBe(false)
    expect(isFreshCard({ createdBy: '', createdAt: now }, '', now)).toBe(false)
  })
})
