import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getMeta } from '../../model/board'
import { blobHashesIn } from './blobs'

const U = 'user1'
const hash = (c: string) => c.repeat(64)

describe('relay blob uploads', () => {
  it('cover every file the board refers to: thumbnails, favicons and covers too', () => {
    const doc = new Y.Doc({ guid: 'b1' })
    createCard(doc, 'image', { blob: hash('a'), thumb: hash('b') }, U)
    createCard(doc, 'link', { url: 'https://example.com', imageBlob: hash('c'), favicon: hash('d') }, U)
    // A board card's id and secret are not files; its cached cover is.
    createCard(doc, 'board', { boardId: hash('9'), secret: hash('8'), cover: hash('e') }, U)
    // Trashed cards can be restored: their files stay available.
    const gone = createCard(doc, 'file', { blob: hash('f') }, U)
    deleteCards(doc, [gone], U)
    getMeta(doc).set('cover', hash('1'))
    expect([...blobHashesIn(doc)].sort()).toEqual([hash('1'), hash('a'), hash('b'), hash('c'), hash('d'), hash('e'), hash('f')].sort())
  })
})
