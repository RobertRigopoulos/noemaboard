import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, initBoardDoc } from '../model/board'
import { newBoardId, newSecret } from '../model/ids'
import { docs } from './docs'
import { useLibrary } from './library'
import { MAX_LINKS_PER_BOARD } from './sync/scope'

beforeAll(() => {
  docs.memoryOnly = true
})
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const lib = () => useLibrary.getState()
/** Indexing runs 250 ms after changes. */
const indexed = () => vi.advanceTimersByTimeAsync(300)

describe('library indexing of board docs (untrusted content)', () => {
  it('clamps titles from cards and meta, and never learns another board\'s secret', async () => {
    const parent = newBoardId()
    const child = newBoardId()
    const sneaky = newBoardId()
    const other = newBoardId()
    const otherSecret = newSecret()
    lib().upsert({ id: other, secret: otherSecret, title: 'Other' })
    const h = docs.open(parent)
    initBoardDoc(h.doc, { id: parent, title: 'y'.repeat(6000) }, 'me')
    createCard(h.doc, 'board', { boardId: child, secret: newSecret(), title: 'x'.repeat(6000) }, 'peer')
    createCard(h.doc, 'board', { boardId: sneaky, secret: otherSecret, title: 'Sneaky' }, 'peer')
    await indexed()
    expect(lib().entries[child].title.length).toBeLessThanOrEqual(120)
    expect(lib().entries[child].secretFrom).toBe('card')
    expect(lib().entries[parent].title.length).toBeLessThanOrEqual(120)
    expect(lib().entries[sneaky]).toBeUndefined()
    h.release()
  })

  it('refreshes the cached title only on cards that carry the board\'s real secret', async () => {
    const x = newBoardId()
    const sx = newSecret()
    const shared = newBoardId()
    const mine = newBoardId()
    lib().upsert({ id: x, secret: sx, title: 'Private plan' })
    const hs = docs.open(shared)
    const hm = docs.open(mine)
    initBoardDoc(hs.doc, { id: shared, title: 'Shared' }, 'me')
    initBoardDoc(hm.doc, { id: mine, title: 'Mine' }, 'me')
    const planted = createCard(hs.doc, 'board', { boardId: x, secret: newSecret(), title: '?' }, 'mallory')
    const real = createCard(hm.doc, 'board', { boardId: x, secret: sx, title: 'old' }, 'me')
    await indexed()
    const hx = docs.open(x)
    initBoardDoc(hx.doc, { id: x, title: 'Private plan', icon: 'lock' }, 'me')
    await indexed()
    expect(getCards(hm.doc).get(real)!.get('title')).toBe('Private plan')
    expect(getCards(hs.doc).get(planted)!.get('title')).toBe('?')
    expect(getCards(hs.doc).get(planted)!.get('icon')).not.toBe('lock')
    for (const h of [hs, hm, hx]) h.release()
  })

  it('learns a bounded number of new boards per board and forgets unused ones whose card is gone', async () => {
    const parent = newBoardId()
    const h = docs.open(parent)
    initBoardDoc(h.doc, { id: parent, title: 'Flood' }, 'me')
    const ids: string[] = []
    const cardIds: string[] = []
    h.doc.transact(() => {
      for (let i = 0; i < MAX_LINKS_PER_BOARD + 50; i++) {
        const id = newBoardId()
        ids.push(id)
        cardIds.push(createCard(h.doc, 'board', { boardId: id, secret: newSecret() }, 'peer'))
      }
    })
    await indexed()
    expect(ids.filter((id) => lib().entries[id]).length).toBe(MAX_LINKS_PER_BOARD)
    // The cards are deleted outright: the never-opened boards learned from them are forgotten.
    h.doc.transact(() => cardIds.forEach((c) => getCards(h.doc).delete(c)))
    await indexed()
    expect(ids.filter((id) => lib().entries[id]).length).toBe(0)
    h.release()
  })
})

describe('DocRegistry', () => {
  it('a pending idle unload of a deleted board never touches the board opened again', async () => {
    const x = newBoardId()
    docs.open(x).release()
    await vi.advanceTimersByTimeAsync(10_000)
    await docs.destroyLocal(x)
    const again = docs.open(x)
    await vi.advanceTimersByTimeAsync(55_000)
    expect(docs.peek(x)).toBe(again.doc)
    expect(again.doc.isDestroyed).toBe(false)
    again.release()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(docs.peek(x)).toBeUndefined()
  })

  it('reports that local data was loaded', () => {
    const x = newBoardId()
    const h = docs.open(x)
    expect(docs.isLoaded(x)).toBe(true)
    expect(docs.isSaving(x)).toBe(true)
    expect(h.doc).toBeInstanceOf(Y.Doc)
    h.release()
  })
})
