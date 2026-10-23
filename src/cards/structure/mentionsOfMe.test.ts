import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCardMap } from '../../model/board'
import type { UserProfile } from '../../model/types'
import { addComment, getThread } from './thread'
import { countRichMentions, findMentions, mentionNotice, newMentions, readSeen, seenKeysToStore, seenStorageKey } from './mentionsOfMe'

const me: UserProfile = { id: 'me-123', name: 'Mia', color: '#0090ff' }
const bob: UserProfile = { id: 'bob456', name: 'Bob', color: '#e5484d' }

/** A paragraph with text and mention chips, as the rich-text editor stores it. */
function paragraph(...parts: (string | { mention: string })[]): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  p.insert(
    0,
    parts.map((part) => {
      if (typeof part === 'string') {
        const t = new Y.XmlText()
        t.insert(0, part)
        return t
      }
      const m = new Y.XmlElement('mention')
      m.setAttribute('id', part.mention)
      m.setAttribute('label', 'someone')
      return m
    }),
  )
  return p
}

function fragmentOf(doc: Y.Doc, id: string, field: string): Y.XmlFragment {
  return getCardMap(doc, id)!.get(field) as Y.XmlFragment
}

describe('findMentions', () => {
  it('finds comment messages that mention me, but not my own messages', () => {
    const doc = new Y.Doc()
    const c = createCard(doc, 'comment', {}, bob.id)
    const map = getCardMap(doc, c)!
    const hit = addComment(doc, map, bob, 'Over to you @Mia', 1, [{ id: me.id, name: 'Mia' }])!
    addComment(doc, map, bob, 'No mention here', 2)
    addComment(doc, map, me, 'Note to self @Mia', 3, [{ id: me.id, name: 'Mia' }])
    expect(getThread(map)!.length).toBe(3)
    expect(findMentions(doc, me.id)).toEqual([{ key: `${c}:${hit}`, cardId: c }])
    expect(findMentions(doc, bob.id)).toEqual([])
  })

  it('counts mention chips in notes, to-dos, documents and captions', () => {
    const doc = new Y.Doc()
    const note = createCard(doc, 'note', {}, bob.id)
    fragmentOf(doc, note, 'content').insert(0, [paragraph('Hi ', { mention: me.id }, ' and ', { mention: bob.id }), paragraph({ mention: me.id })])
    const todo = createCard(doc, 'todo', {}, bob.id)
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    item.insert(0, [paragraph('Ask ', { mention: me.id })])
    list.insert(0, [item])
    fragmentOf(doc, todo, 'content').insert(0, [list])
    const image = createCard(doc, 'image', {}, bob.id)
    fragmentOf(doc, image, 'caption').insert(0, [paragraph('Shot by ', { mention: me.id })])
    const other = createCard(doc, 'note', {}, bob.id)
    fragmentOf(doc, other, 'content').insert(0, [paragraph({ mention: bob.id })])

    const hits = findMentions(doc, me.id)
    const keysOf = (id: string) => hits.filter((h) => h.cardId === id).map((h) => h.key)
    expect(keysOf(note)).toHaveLength(2)
    expect(new Set(keysOf(note)).size).toBe(2)
    expect(keysOf(todo)).toHaveLength(1)
    expect(keysOf(image)).toHaveLength(1)
    for (const h of hits) expect(h.key).toMatch(new RegExp(`^${h.cardId}:\\d+\\.\\d+$`))
    expect(hits.some((h) => h.cardId === other)).toBe(false)
    expect(countRichMentions(fragmentOf(doc, note, 'content'), bob.id)).toBe(1)
  })

  it('gives a mention that replaced another one a new key, and keeps the keys of the others', () => {
    const doc = new Y.Doc()
    const note = createCard(doc, 'note', {}, bob.id)
    const frag = fragmentOf(doc, note, 'content')
    frag.insert(0, [paragraph('First ', { mention: me.id }), paragraph('Second ', { mention: me.id })])
    const before = findMentions(doc, me.id).map((h) => h.key)
    expect(before).toHaveLength(2)

    // The first paragraph's chip is deleted and a new one is written in its place.
    const first = frag.get(0) as Y.XmlElement
    doc.transact(() => {
      first.delete(1, 1)
      const chip = new Y.XmlElement('mention')
      chip.setAttribute('id', me.id)
      first.insert(1, [chip])
    })
    const after = findMentions(doc, me.id).map((h) => h.key)
    expect(after).toHaveLength(2)
    expect(newMentions(after.map((key) => ({ key, cardId: note })), new Set(before))).toHaveLength(1)

    // Deleting the (new) first mention does not shift the key of the second one.
    doc.transact(() => first.delete(1, 1))
    const remaining = findMentions(doc, me.id).map((h) => h.key)
    expect(remaining).toHaveLength(1)
    expect(before).toContain(remaining[0])
  })

  it('ignores deleted cards and an empty user id', () => {
    const doc = new Y.Doc()
    const note = createCard(doc, 'note', {}, bob.id)
    fragmentOf(doc, note, 'content').insert(0, [paragraph({ mention: me.id })])
    expect(findMentions(doc, me.id)).toHaveLength(1)
    expect(findMentions(doc, '')).toEqual([])
    deleteCards(doc, [note], bob.id)
    expect(findMentions(doc, me.id)).toEqual([])
  })
})

describe('seen mentions', () => {
  const hits = [
    { key: 'a:1', cardId: 'a' },
    { key: 'b:m0', cardId: 'b' },
    { key: 'b:m0', cardId: 'b' },
  ]

  it('reports only mentions not seen before', () => {
    expect(newMentions(hits, new Set(['a:1']))).toEqual([{ key: 'b:m0', cardId: 'b' }, { key: 'b:m0', cardId: 'b' }])
    expect(newMentions(hits, new Set(['a:1', 'b:m0']))).toEqual([])
  })

  it('stores unique current keys, capped to the newest ones', () => {
    expect(seenKeysToStore(hits)).toEqual(['a:1', 'b:m0'])
    const many = Array.from({ length: 600 }, (_, i) => ({ key: `c:${i}`, cardId: 'c' }))
    const stored = seenKeysToStore(many, 500)
    expect(stored).toHaveLength(500)
    expect(stored[0]).toBe('c:100')
  })

  it('reads stored keys defensively', () => {
    expect(readSeen(['a:1', 5, null, 'x'.repeat(300), 'b:2'])).toEqual(new Set(['a:1', 'b:2']))
    expect(readSeen('a:1')).toEqual(new Set())
    expect(readSeen(null)).toEqual(new Set())
    expect(readSeen(Array.from({ length: 900 }, (_, i) => `k${i}`)).size).toBe(500)
    expect(seenStorageKey('board1')).toBe('mentionsSeen:board1')
  })

  it('words the notice', () => {
    expect(mentionNotice(1)).toBe('You were mentioned once on this board')
    expect(mentionNotice(3)).toBe('You were mentioned 3 times on this board')
  })
})
