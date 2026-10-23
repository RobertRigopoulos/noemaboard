import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCardMap, getCards, initBoardDoc, updateMeta } from './board'
import { boardBlobHashes, cardBlobHashes, isBlobHash } from './blobRefs'

const hash = (c: string) => c.repeat(64)

function card(type: Parameters<typeof createCard>[1], fields: Record<string, unknown>) {
  const doc = new Y.Doc({ guid: 'b1' })
  return getCardMap(doc, createCard(doc, type, fields, 'u'))!
}

describe('cardBlobHashes', () => {
  it("finds an image's blob and thumbnail", () => {
    const m = card('image', { blob: hash('a'), thumb: hash('b'), mime: 'image/png' })
    expect(cardBlobHashes(m).sort()).toEqual([hash('a'), hash('b')])
  })

  it("finds a link's preview image and favicon, once each", () => {
    const m = card('link', { url: 'https://example.com', imageBlob: hash('c'), favicon: hash('d'), cover: hash('c') })
    expect(cardBlobHashes(m).sort()).toEqual([hash('c'), hash('d')])
  })

  it("never returns a board card's secret or board id", () => {
    const m = card('board', { boardId: hash('e'), secret: hash('f'), cover: hash('1') })
    expect(cardBlobHashes(m)).toEqual([hash('1')])
  })

  it('ignores nested objects, uppercase hex and wrong lengths', () => {
    const m = card('note', {
      nested: { blob: hash('2') },
      list: [hash('3')],
      upper: hash('A'),
      short: hash('4').slice(1),
      long: hash('5') + '5',
    })
    expect(cardBlobHashes(m)).toEqual([])
    expect(isBlobHash(hash('9'))).toBe(true)
    expect(isBlobHash(42)).toBe(false)
  })
})

describe('boardBlobHashes', () => {
  it("covers every card (trashed ones too) and the board's own cover, once each", () => {
    const doc = new Y.Doc({ guid: 'b1' })
    initBoardDoc(doc, { id: 'b1' }, 'u')
    updateMeta(doc, { cover: hash('a') })
    createCard(doc, 'image', { blob: hash('a'), thumb: hash('b') }, 'u')
    const gone = createCard(doc, 'file', { blob: hash('c') }, 'u')
    deleteCards(doc, [gone], 'u')
    createCard(doc, 'board', { boardId: hash('d'), secret: hash('e') }, 'u')
    // a peer wrote something that is not a card map
    getCards(doc).set('junk', hash('f') as unknown as Y.Map<unknown>)
    expect([...boardBlobHashes(doc)].sort()).toEqual([hash('a'), hash('b'), hash('c')])
  })
})
