import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCardMap, initBoardDoc, insertIntoColumn } from '../../model/board'
import { topLevelCopies } from './topLevelCopies'

const U = 'user1'

function boardDoc() {
  const doc = new Y.Doc({ guid: 'board1' })
  initBoardDoc(doc, { id: 'board1', title: 'Target' }, U)
  return doc
}

describe('topLevelCopies', () => {
  it('leaves out comments pinned to another copy, column children and lines', () => {
    const doc = boardDoc()
    const image = createCard(doc, 'image', { x: 0, y: 0 }, U)
    const pinned = createCard(doc, 'comment', { x: 10, y: 10 }, U)
    getCardMap(doc, pinned)!.set('attachedTo', image)
    const column = createCard(doc, 'column', { x: 400, y: 0 }, U)
    const child = createCard(doc, 'note', { x: 0, y: 0 }, U)
    insertIntoColumn(doc, [child], column, 0, U)
    const line = createCard(doc, 'line', { x: 0, y: 0 }, U)
    expect(topLevelCopies(doc, [image, pinned, column, child, line])).toEqual([image, column])
  })

  it('keeps a comment pinned to a card that was not copied', () => {
    const doc = boardDoc()
    const comment = createCard(doc, 'comment', { x: 0, y: 0 }, U)
    getCardMap(doc, comment)!.set('attachedTo', 'elsewhere')
    expect(topLevelCopies(doc, [comment])).toEqual([comment])
  })

  it('orders the copies top to bottom, then left to right', () => {
    const doc = boardDoc()
    const low = createCard(doc, 'note', { x: 0, y: 300 }, U)
    const right = createCard(doc, 'note', { x: 400, y: 0 }, U)
    const left = createCard(doc, 'note', { x: 0, y: 0 }, U)
    expect(topLevelCopies(doc, [low, right, left])).toEqual([left, right, low])
  })
})
