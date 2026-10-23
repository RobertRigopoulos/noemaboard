import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, initBoardDoc, updateCard, updateMeta } from '../../model/board'
import { newBoardId, newSecret } from '../../model/ids'
import { acceptLink, acceptedChildren, computeScope, observeBoardDoc, readBlobRefs, readBoardLinks, readShared } from './scope'

describe('computeScope', () => {
  const graph: Record<string, string[]> = { a: ['b', 'c'], b: ['d', 'a'], c: ['d'], d: ['e'] }

  it('walks board links breadth-first and survives cycles', () => {
    expect([...computeScope('a', (id) => graph[id])].sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect([...computeScope('c', (id) => graph[id])].sort()).toEqual(['c', 'd', 'e'])
  })

  it('stops at boards that are not loaded yet', () => {
    expect([...computeScope('a', (id) => (id === 'a' ? graph.a : undefined))].sort()).toEqual(['a', 'b', 'c'])
  })

  it('caps the number of boards', () => {
    const wide = (id: string) => (id === 'root' ? Array.from({ length: 50 }, (_, i) => `k${i}`) : [])
    expect(computeScope('root', wide, 10).size).toBe(10)
  })
})

describe('board links', () => {
  it('reads valid board cards only', () => {
    const doc = new Y.Doc({ guid: newBoardId() })
    initBoardDoc(doc, { id: doc.guid }, 'u')
    const child = newBoardId()
    const secret = newSecret()
    createCard(doc, 'board', { boardId: child, secret }, 'u')
    createCard(doc, 'board', { boardId: 'home', secret }, 'u')
    createCard(doc, 'board', { boardId: 'bad id!', secret }, 'u')
    createCard(doc, 'board', { boardId: newBoardId(), secret: '' }, 'u')
    createCard(doc, 'board', { boardId: doc.guid, secret }, 'u')
    createCard(doc, 'note', { boardId: newBoardId(), secret }, 'u')
    expect([...readBoardLinks(doc, 'home')]).toEqual([[child, [secret]]])
  })

  it('only follows a card when its secret matches the one we know', () => {
    const id = newBoardId()
    expect(acceptLink(id, ['s1'], undefined, 'home')).toBe(true)
    expect(acceptLink(id, ['s1'], 's1', 'home')).toBe(true)
    expect(acceptLink(id, ['forged'], 's1', 'home')).toBe(false)
    expect(acceptLink(id, ['forged', 's1'], 's1', 'home')).toBe(true)
    expect(acceptLink('home', ['s1'], undefined, 'home')).toBe(false)
  })

  it('notices link and shared changes but not text edits', () => {
    const doc = new Y.Doc({ guid: newBoardId() })
    initBoardDoc(doc, { id: doc.guid }, 'u')
    const onLinks = vi.fn()
    const onShared = vi.fn()
    const note = createCard(doc, 'note', {}, 'u')
    const off = observeBoardDoc(doc, onLinks, onShared)
    const frag = getCards(doc).get(note)!.get('content') as Y.XmlFragment
    doc.transact(() => frag.insert(0, [new Y.XmlText('hello')]))
    updateCard(doc, note, { x: 50 }, 'u')
    expect(onLinks).not.toHaveBeenCalled()
    const b = createCard(doc, 'board', { boardId: newBoardId(), secret: newSecret() }, 'u')
    expect(onLinks).toHaveBeenCalledTimes(1)
    updateCard(doc, b, { boardId: newBoardId() }, 'u')
    expect(onLinks).toHaveBeenCalledTimes(2)
    expect(readShared(doc)).toBe(false)
    updateMeta(doc, { shared: true })
    expect(onShared).toHaveBeenCalledTimes(1)
    expect(readShared(doc)).toBe(true)
    off()
    createCard(doc, 'board', { boardId: newBoardId(), secret: newSecret() }, 'u')
    expect(onLinks).toHaveBeenCalledTimes(2)
  })
})

describe('acceptedChildren', () => {
  it('prefers known boards, caps the count and ignores secrets that belong to another board', () => {
    const known = newBoardId()
    const kSecret = newSecret()
    const taken = newSecret()
    const links = new Map<string, string[]>()
    for (let i = 0; i < 10; i++) links.set(newBoardId(), [newSecret()])
    const reuse = newBoardId()
    links.set(reuse, [taken])
    links.set(known, [kSecret])
    const secretOf = (id: string) => (id === known ? kSecret : undefined)
    const ownerOf = (s: string) => (s === taken ? 'another1' : s === kSecret ? known : undefined)
    const out = acceptedChildren(links, secretOf, ownerOf, 'home', 5)
    expect(out).toHaveLength(5)
    expect(out[0]).toBe(known)
    expect(acceptedChildren(links, secretOf, ownerOf, 'home', 100)).not.toContain(reuse)
  })
})

describe('readBlobRefs', () => {
  it('collects every file hash the cards refer to', () => {
    const doc = new Y.Doc({ guid: newBoardId() })
    const h1 = 'a'.repeat(64)
    const h2 = 'b'.repeat(64)
    createCard(doc, 'image', { blob: h1, thumb: h2 }, 'u')
    createCard(doc, 'note', {}, 'u')
    expect([...readBlobRefs(doc)].sort()).toEqual([h1, h2])
  })

  it('includes favicons, covers and trashed cards, but never board secrets', () => {
    const doc = new Y.Doc({ guid: newBoardId() })
    const [fav, cover, gone, secret] = ['c', 'd', 'e', 'f'].map((c) => c.repeat(64))
    createCard(doc, 'link', { favicon: fav }, 'u')
    createCard(doc, 'board', { boardId: newBoardId(), secret, cover }, 'u')
    const img = createCard(doc, 'image', { blob: gone }, 'u')
    updateCard(doc, img, { trashedAt: 1 }, 'u')
    expect([...readBlobRefs(doc)].sort()).toEqual([fav, cover, gone])
  })

  it("includes the board's own cover, and reports meta changes so cached refs are dropped", () => {
    const doc = new Y.Doc({ guid: newBoardId() })
    initBoardDoc(doc, { id: doc.guid }, 'u')
    const onContent = vi.fn()
    const off = observeBoardDoc(doc, () => {}, () => {}, onContent)
    const cover = '0'.repeat(64)
    updateMeta(doc, { cover })
    expect(onContent).toHaveBeenCalledTimes(1)
    expect([...readBlobRefs(doc)]).toEqual([cover])
    createCard(doc, 'note', {}, 'u')
    expect(onContent).toHaveBeenCalledTimes(2)
    off()
    updateMeta(doc, { cover: null })
    expect(onContent).toHaveBeenCalledTimes(2)
    expect(readBlobRefs(doc).size).toBe(0)
  })
})
