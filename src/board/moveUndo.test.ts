import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { attachMoveUndo, trackMove } from './moveUndo'
import { docs } from '../collab/docs'
import { createTextNote, getCards, isTrashed, LOCAL_ORIGIN, moveCardsToBoard, xmlToText } from '../model/board'

const U = 'u1'

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('undo of a move into another board', () => {
  it('hides the copies on undo and shows them again on redo', async () => {
    const src = docs.open('srcBoard00001').doc
    const dst = docs.open('dstBoard00001').doc
    const undo = new Y.UndoManager([getCards(src)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 })
    const detach = attachMoveUndo(src, undo)
    const n = createTextNote(src, 'moving', {}, U)
    const [copy] = trackMove(src, dst, () => moveCardsToBoard(src, dst, [n], { x: 0, y: 0 }, U))
    expect(isTrashed(getCards(src).get(n)!)).toBe(true)

    undo.undo()
    await settle()
    expect(isTrashed(getCards(src).get(n)!)).toBe(false)
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(true) // no duplicate left in the child board

    undo.redo()
    await settle()
    expect(isTrashed(getCards(src).get(n)!)).toBe(true)
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(false)

    // and once more (meta carried over to the new stack items)
    undo.undo()
    await settle()
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(true)
    detach()
  })

  it('keeps a copy that someone edited after the move', async () => {
    const src = docs.open('srcBoard00002').doc
    const dst = docs.open('dstBoard00002').doc
    const undo = new Y.UndoManager([getCards(src)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 400 })
    const detach = attachMoveUndo(src, undo)
    const n = createTextNote(src, 'moving', {}, U)
    const [copy] = trackMove(src, dst, () => moveCardsToBoard(src, dst, [n], { x: 0, y: 0 }, U))
    const frag = getCards(dst).get(copy)!.get('content') as Y.XmlFragment
    dst.transact(() => (frag.get(0) as Y.XmlElement).insert(1, [new Y.XmlText('!')]))
    undo.undo()
    await settle()
    expect(isTrashed(getCards(dst).get(copy)!)).toBe(false)
    expect(xmlToText(frag)).toBe('moving!')
    detach()
  })
})
