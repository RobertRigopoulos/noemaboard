import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCards, getMeta, getTrash, LOCAL_ORIGIN, updateCard } from '../../model/board'
import { newId } from '../../model/ids'
import { childImageChoices, cleanAppearance, MAX_COVER_CHOICES, readCover, syncAppearanceOnUndo } from './boardAppearance'
import { readChildCount } from './helpers'

const U = 'user1'

function parentBoard() {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager([getCards(doc), getMeta(doc), getTrash(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
  const pushed: { boardId: string; clean: Record<string, unknown> }[] = []
  syncAppearanceOnUndo(doc, (boardId, clean) => pushed.push({ boardId, clean }))
  const boardId = newId()
  const card = createCard(doc, 'board', { boardId, secret: 's', title: 'Ideas', icon: null, color: null }, U)
  undo.clear()
  return { doc, undo, pushed, boardId, card }
}

describe('board appearance undo', () => {
  it('pushes the restored title, icon and color to the library and child board', () => {
    const { doc, undo, pushed, boardId, card } = parentBoard()
    updateCard(doc, card, { title: 'Q3 plans' }, U)
    undo.stopCapturing()
    updateCard(doc, card, { icon: 'rocket', color: 'red' }, U)
    expect(pushed).toEqual([])

    undo.undo()
    expect(pushed).toEqual([{ boardId, clean: { icon: null, color: null } }])
    undo.undo()
    expect(pushed[1]).toEqual({ boardId, clean: { title: 'Ideas' } })
    undo.redo()
    expect(pushed[2]).toEqual({ boardId, clean: { title: 'Q3 plans' } })
  })

  it('ignores ordinary edits, remote changes and other cards', () => {
    const { doc, undo, pushed, card } = parentBoard()
    updateCard(doc, card, { title: 'Local' }, U)
    doc.transact(() => getCards(doc).get(card)!.set('title', 'Remote'), 'remote-peer')
    const note = createCard(doc, 'note', {}, U)
    undo.stopCapturing()
    updateCard(doc, note, { color: 'blue' }, U)
    undo.undo()
    updateCard(doc, card, { x: 50 }, U)
    undo.stopCapturing()
    undo.undo()
    expect(pushed).toEqual([])
  })
})

describe('board card fields', () => {
  const HASH = 'a'.repeat(64)

  it('accepts a cached child count only as an integer from 0 to 100000', () => {
    expect(readChildCount(0)).toBe(0)
    expect(readChildCount(42)).toBe(42)
    expect(readChildCount(100_000)).toBe(100_000)
    for (const bad of [-1, 100_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '3', null, undefined, true]) expect(readChildCount(bad)).toBeNull()
  })

  it('cleans covers: lower-case 64-hex hashes only, null removes', () => {
    expect(cleanAppearance({ cover: HASH })).toEqual({ cover: HASH })
    expect(cleanAppearance({ cover: HASH.toUpperCase() })).toEqual({})
    expect(cleanAppearance({ cover: 'a'.repeat(63) })).toEqual({})
    expect(cleanAppearance({ cover: `${HASH} ` })).toEqual({})
    expect(cleanAppearance({ cover: 'https://example.com/x.png' })).toEqual({})
    expect(cleanAppearance({ cover: null })).toEqual({ cover: null })
    expect(cleanAppearance({})).toEqual({})
    expect(cleanAppearance({ title: '  Trip ', cover: HASH, color: 'blue' })).toEqual({ title: 'Trip', cover: HASH, color: 'blue' })
    expect(readCover(HASH)).toBe(HASH)
    expect(readCover(42)).toBeNull()
  })

  it('reverts a cover change on undo in the library and child board too', () => {
    const { doc, undo, pushed, boardId, card } = parentBoard()
    updateCard(doc, card, { cover: HASH }, U)
    undo.undo()
    expect(pushed).toEqual([{ boardId, clean: { cover: null } }])
    undo.redo()
    expect(pushed[1]).toEqual({ boardId, clean: { cover: HASH } })
  })

  it('offers the images of a board as covers, display copies first, without duplicates', () => {
    const child = new Y.Doc()
    const thumb = 'b'.repeat(64)
    createCard(child, 'image', { blob: HASH, thumb }, U)
    createCard(child, 'image', { blob: HASH, thumb: null, alt: 'Beach' }, U)
    createCard(child, 'image', { blob: HASH, thumb: null }, U)
    createCard(child, 'image', { blob: 'not a hash', thumb: null }, U)
    createCard(child, 'note', { blob: HASH }, U)
    const gone = createCard(child, 'image', { blob: 'c'.repeat(64) }, U)
    deleteCards(child, [gone], U)
    expect(childImageChoices(child)).toEqual([
      { hash: thumb, name: 'image' },
      { hash: HASH, name: 'Beach' },
    ])
    for (let i = 0; i < 30; i++) createCard(child, 'image', { blob: i.toString(16).padStart(64, '0') }, U)
    expect(childImageChoices(child)).toHaveLength(MAX_COVER_CHOICES)
  })
})
