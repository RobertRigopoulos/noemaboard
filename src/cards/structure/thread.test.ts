import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, LOCAL_ORIGIN } from '../../model/board'
import type { CardMap, UserProfile } from '../../model/types'
import {
  addComment,
  COMMENT_MAX,
  deleteComment,
  editComment,
  foldThread,
  getThread,
  mentionedIds,
  MENTIONS_MAX,
  normalizeCommentText,
  readMentions,
  readThread,
  safeColor,
  showsMarker,
} from './thread'

const alice: UserProfile = { id: 'alice1', name: 'Alice Smith', color: '#e5484d' }
const bob: UserProfile = { id: 'bob123', name: 'Bob', color: '#0090ff' }

function setup() {
  const doc = new Y.Doc()
  const id = createCard(doc, 'comment', {}, alice.id)
  const map = getCards(doc).get(id) as CardMap
  return { doc, id, map }
}

describe('comment thread', () => {
  it('adds messages with author info in a LOCAL_ORIGIN transaction', () => {
    const { doc, map } = setup()
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const id = addComment(doc, map, alice, '  Hello\r\nteam  ', 1000)
    expect(id).toBeTruthy()
    expect(origins).toContain(LOCAL_ORIGIN)
    const msgs = readThread(getThread(map))
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      id,
      authorId: 'alice1',
      authorName: 'Alice Smith',
      authorColor: '#e5484d',
      text: 'Hello\nteam',
      createdAt: 1000,
      editedAt: null,
    })
    expect(map.get('updatedBy')).toBe('alice1')
  })

  it('refuses empty messages and caps long ones', () => {
    const { doc, map } = setup()
    expect(addComment(doc, map, alice, '   \n ')).toBeNull()
    addComment(doc, map, alice, 'x'.repeat(COMMENT_MAX + 100))
    expect(readThread(getThread(map))[0].text).toHaveLength(COMMENT_MAX)
  })

  it('creates the thread array when a malformed card lacks it', () => {
    const { doc, map } = setup()
    doc.transact(() => map.delete('thread'))
    expect(getThread(map)).toBeNull()
    addComment(doc, map, bob, 'hi')
    expect(readThread(getThread(map))).toHaveLength(1)
  })

  it('only lets authors edit or delete their own messages', () => {
    const { doc, map } = setup()
    const a = addComment(doc, map, alice, 'first', 1)!
    const b = addComment(doc, map, bob, 'second', 2)!
    expect(editComment(doc, map, b, alice.id, 'hijack')).toBe(false)
    expect(deleteComment(doc, map, b, alice.id)).toBe(false)
    expect(editComment(doc, map, a, alice.id, 'first, edited', 50)).toBe(true)
    expect(editComment(doc, map, a, alice.id, '   ')).toBe(false)
    let msgs = readThread(getThread(map))
    expect(msgs[0]).toMatchObject({ text: 'first, edited', editedAt: 50 })
    expect(msgs[1].text).toBe('second')
    expect(deleteComment(doc, map, a, alice.id)).toBe(true)
    msgs = readThread(getThread(map))
    expect(msgs.map((m) => m.id)).toEqual([b])
    expect(deleteComment(doc, map, 'missing', alice.id)).toBe(false)
  })

  it('edits and deletes are undoable with the board undo manager', () => {
    const { doc, map } = setup()
    const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const a = addComment(doc, map, alice, 'keep me')!
    undo.stopCapturing()
    deleteComment(doc, map, a, alice.id)
    expect(readThread(getThread(map))).toHaveLength(0)
    undo.undo()
    expect(readThread(getThread(map)).map((m) => m.text)).toEqual(['keep me'])
  })

  it('sanitises malformed peer entries', () => {
    const { doc, map } = setup()
    const arr = getThread(map)!
    doc.transact(() => {
      arr.push(['not a map'])
      const noText = new Y.Map<unknown>()
      noText.set('id', 'x1')
      arr.push([noText])
      const weird = new Y.Map<unknown>()
      weird.set('id', 'w1')
      weird.set('text', 'ok')
      weird.set('authorName', 42)
      weird.set('authorColor', 'red; background:url(evil)')
      weird.set('createdAt', 'yesterday')
      weird.set('editedAt', Number.NaN)
      arr.push([weird])
      const dup = new Y.Map<unknown>()
      dup.set('id', 'w1')
      dup.set('text', 'duplicate')
      arr.push([dup])
    })
    const msgs = readThread(arr)
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ id: 'w1', authorName: 'Someone', authorColor: '#8b8d98', createdAt: 0, editedAt: null })
  })

  it('removes direction overrides, zero-width and control characters from names and text', () => {
    const rlo = String.fromCharCode(0x202e)
    const zwsp = String.fromCharCode(0x200b)
    const isolate = String.fromCharCode(0x2066)
    const c1 = String.fromCharCode(0x85)
    const zwj = String.fromCharCode(0x200d)
    const { doc, map } = setup()
    // Written by this app: cleaned before it is stored.
    addComment(doc, map, { id: 'eve123', name: `Al${zwsp}ice${rlo} Smith`, color: '#000000' }, `see ${rlo}moc.live${zwsp} now\tok\nnext`)
    // Written by a peer: cleaned when read.
    doc.transact(() => {
      const raw = new Y.Map<unknown>()
      raw.set('id', 'peer1')
      raw.set('authorName', `B${zwsp}ob${rlo}`)
      raw.set('text', `a${isolate}b${c1}c${rlo}d${zwj}e`)
      const invisible = new Y.Map<unknown>()
      invisible.set('id', 'peer2')
      invisible.set('text', `${zwsp}${rlo}`)
      getThread(map)!.push([raw, invisible])
    })
    const msgs = readThread(getThread(map))
    expect(msgs.map((m) => m.id)).toEqual([msgs[0].id, 'peer1'])
    expect(msgs[0].authorName).toBe('Alice Smith')
    expect((getThread(map)!.get(0) as Y.Map<unknown>).get('authorName')).toBe('Alice Smith')
    expect(msgs[0].text).toBe('see moc.live now\tok\nnext')
    expect(msgs[1].authorName).toBe('Bob')
    // Joiners stay: emoji sequences and several scripts need them.
    expect(msgs[1].text).toBe(`abcd${zwj}e`)
    expect(addComment(doc, map, alice, `${zwsp}${rlo} `)).toBeNull()
  })
})

describe('helpers', () => {
  it('normalizes text', () => {
    expect(normalizeCommentText('a\r\nb\rc')).toBe('a\nb\nc')
    expect(normalizeCommentText('\u0007bell\u0000')).toBe('bell')
    expect(normalizeCommentText('tab\tkept')).toBe('tab\tkept')
    expect(normalizeCommentText(`line${String.fromCharCode(0x2028)}break`)).toBe('line\nbreak')
  })

  it('shows a marker for an empty thread only to the person who started it', () => {
    const { doc, map } = setup()
    expect(showsMarker(map, alice.id)).toBe(true)
    expect(showsMarker(map, bob.id)).toBe(false)
    expect(showsMarker(map, '')).toBe(false)
    addComment(doc, map, alice, 'first')
    expect(showsMarker(map, bob.id)).toBe(true)
  })

  it('validates colors', () => {
    expect(safeColor('#abc')).toBe('#abc')
    expect(safeColor('#a1b2c3')).toBe('#a1b2c3')
    expect(safeColor('url(x)')).toBe('#8b8d98')
    expect(safeColor(null)).toBe('#8b8d98')
  })

  it('folds long threads to the first message and the latest replies', () => {
    const msgs = [1, 2, 3, 4, 5, 6, 7, 8, 9]
    expect(foldThread(msgs)).toEqual({ head: [1], hidden: 6, tail: [8, 9] })
    expect(foldThread([1, 2, 3])).toEqual({ head: [1, 2, 3], hidden: 0, tail: [] })
  })
})

describe('mentions', () => {
  it('reads a plain array of valid, unique ids, at most 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => `user${i}`)
    expect(readMentions(many)).toEqual(many.slice(0, MENTIONS_MAX))
    expect(MENTIONS_MAX).toBe(20)
    expect(readMentions(['ok-1', 'ok-1', 'bad id', '', 'x'.repeat(65), 7, null, { id: 'a' }, 'ok_2'])).toEqual(['ok-1', 'ok_2'])
    expect(readMentions('alice1')).toEqual([])
    expect(readMentions(undefined)).toEqual([])
    expect(readMentions({ 0: 'alice1', length: 1 })).toEqual([])
  })

  it('stores picked people only while their @Name is in the text', () => {
    const { doc, map } = setup()
    const picked = [
      { id: bob.id, name: 'Bob' },
      { id: 'carol1', name: 'Carol' },
    ]
    addComment(doc, map, alice, 'Thanks @Bob!', 1, picked)
    const [msg] = readThread(getThread(map))
    expect(msg.text).toBe('Thanks @Bob!')
    expect(msg.mentions).toEqual([bob.id])
    expect(getThread(map)!.get(0)).toBeInstanceOf(Y.Map)
    expect(Array.isArray((getThread(map)!.get(0) as Y.Map<unknown>).get('mentions'))).toBe(true)
  })

  it('does not count a name glued to other text as a mention', () => {
    expect(mentionedIds('mail@Bobby.com', [{ id: bob.id, name: 'Bob' }])).toEqual([])
    expect(mentionedIds('hi @Bobby', [{ id: bob.id, name: 'Bob' }])).toEqual([])
    expect(mentionedIds('(@Bob)', [{ id: bob.id, name: 'Bob' }])).toEqual([bob.id])
    // A person whose name is not known here cannot be checked and is kept.
    expect(mentionedIds('hi', [{ id: 'ghost1' }])).toEqual(['ghost1'])
    expect(mentionedIds('@Bob', [{ id: 'not valid', name: 'Bob' }])).toEqual([])
  })

  it('drops mentions whose @Name was edited away, and keeps them otherwise', () => {
    const { doc, map } = setup()
    const msg = addComment(doc, map, alice, '@Bob and @Carol', 1, [
      { id: bob.id, name: 'Bob' },
      { id: 'carol1', name: 'Carol' },
    ])!
    const current = [
      { id: bob.id, name: 'Bob' },
      { id: 'carol1', name: 'Carol' },
    ]
    expect(editComment(doc, map, msg, alice.id, 'Only @Carol now', 2, current)).toBe(true)
    expect(readThread(getThread(map))[0].mentions).toEqual(['carol1'])
    expect(editComment(doc, map, msg, alice.id, 'Nobody', 3, current)).toBe(true)
    expect(readThread(getThread(map))[0].mentions).toEqual([])
    expect((getThread(map)!.get(0) as Y.Map<unknown>).has('mentions')).toBe(false)
    // Without a list the stored mentions stay as they are.
    addComment(doc, map, bob, 'Hey @Alice Smith', 4, [{ id: alice.id, name: 'Alice Smith' }])
    const second = readThread(getThread(map))[1]
    expect(editComment(doc, map, second.id, bob.id, 'Hey @Alice Smith, see this', 5)).toBe(true)
    expect(readThread(getThread(map))[1].mentions).toEqual([alice.id])
  })

  it('caps a peer message mentioning more than 20 people', () => {
    const { doc, map } = setup()
    const arr = getThread(map)!
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'm1')
      m.set('authorId', bob.id)
      m.set('text', 'everyone')
      m.set('mentions', [...Array.from({ length: 25 }, (_, i) => `p${i}`), '<script>'])
      arr.push([m])
    })
    const [msg] = readThread(arr)
    expect(msg.mentions).toHaveLength(20)
    expect(msg.mentions).not.toContain('<script>')
  })
})

describe('peer text', () => {
  it('strips control characters from message text and author names', () => {
    const { doc, map } = setup()
    const arr = getThread(map)!
    doc.transact(() => {
      const m = new Y.Map<unknown>()
      m.set('id', 'm1')
      m.set('authorId', bob.id)
      m.set('authorName', 'Bo\u0007b')
      m.set('text', 'line 1\nline\u0000 2\u001b')
      arr.push([m])
    })
    const [msg] = readThread(arr)
    expect(msg.text).toBe('line 1\nline 2')
    expect(msg.authorName).toBe('Bob')
  })
})
