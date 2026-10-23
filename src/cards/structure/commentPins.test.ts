import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCardMap, getCards, readCard, updateCard } from '../../model/board'
import { CardIndex } from '../../board/cardIndex'
import {
  attachmentTarget,
  groupPins,
  isAttachableType,
  isCollapsedThread,
  isPinnedComment,
  MARKER_GAP,
  MARKER_SIZE,
  markerPositions,
  markerScale,
  pinsOn,
  readAttachedTo,
} from './attach'
import { clearDraft, draftKey, editDraftKey, getDraft, hasUnsentText, MAX_DRAFTS, resetDrafts, setDraft, subscribeDraft } from './commentDrafts'

const U = 'user1'

function board() {
  const doc = new Y.Doc()
  const index = new CardIndex(doc)
  const lookup = (id: string) => index.get(id)
  return { doc, index, lookup }
}

function comment(doc: Y.Doc, attachedTo: unknown): string {
  return createCard(doc, 'comment', { attachedTo }, U)
}

describe('attachmentTarget', () => {
  it('returns the target of a comment pinned to an active card', () => {
    const { doc, index, lookup } = board()
    const note = createCard(doc, 'note', {}, U)
    const c = comment(doc, note)
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBe(note)
    expect(isPinnedComment(index.get(c)!, lookup)).toBe(true)
  })

  it('treats a comment whose target is missing as a free card', () => {
    const { doc, index, lookup } = board()
    const c = comment(doc, 'no-such-card')
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBeNull()
    expect(isPinnedComment(index.get(c)!, lookup)).toBe(false)
  })

  it('frees the comment when its target is trashed, and pins it again on restore', () => {
    const { doc, index, lookup } = board()
    const note = createCard(doc, 'note', {}, U)
    const c = comment(doc, note)
    // Deleting the target alone (not through expandSelection) as a peer's concurrent delete would.
    getCardMap(doc, note)!.set('trashedAt', Date.now())
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBeNull()
    // A lookup that still knows trashed cards (raw doc reads) is not fooled either.
    const raw = (id: string) => {
      const m = getCardMap(doc, id)
      return m ? { card: readCard(m) } : undefined
    }
    expect(attachmentTarget(index.get(c)!.card, raw)).toBeNull()
    getCardMap(doc, note)!.delete('trashedAt')
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBe(note)
  })

  it('trashes pinned comments together with their card', () => {
    const { doc, index } = board()
    const note = createCard(doc, 'note', {}, U)
    const c = comment(doc, note)
    deleteCards(doc, [note], U)
    expect(index.get(c)).toBeUndefined()
  })

  it('never pins to lines or other comments', () => {
    const { doc, index, lookup } = board()
    const line = createCard(doc, 'line', {}, U)
    const other = comment(doc, null)
    expect(attachmentTarget(index.get(comment(doc, line))!.card, lookup)).toBeNull()
    expect(attachmentTarget(index.get(comment(doc, other))!.card, lookup)).toBeNull()
    expect(isAttachableType('line')).toBe(false)
    expect(isAttachableType('comment')).toBe(false)
    expect(isAttachableType('note')).toBe(true)
    expect(isAttachableType('nonsense')).toBe(false)
  })

  it('does not pin to a card waiting in the Unsorted drawer', () => {
    const { doc, index, lookup } = board()
    const note = createCard(doc, 'note', { unsorted: true }, U)
    const c = comment(doc, note)
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBeNull()
    updateCard(doc, note, { unsorted: false }, U)
    expect(attachmentTarget(index.get(c)!.card, lookup)).toBe(note)
  })

  it('ignores malformed ids, self references and non-comment cards', () => {
    const { doc, index, lookup } = board()
    const note = createCard(doc, 'note', {}, U)
    for (const bad of [42, '', 'has space', 'x'.repeat(65), { id: note }, ['a']]) {
      const c = comment(doc, bad)
      expect(readAttachedTo(index.get(c)!.card)).toBeNull()
      expect(attachmentTarget(index.get(c)!.card, lookup)).toBeNull()
    }
    const self = comment(doc, null)
    updateCard(doc, self, { attachedTo: self }, U)
    expect(attachmentTarget(index.get(self)!.card, lookup)).toBeNull()
    const image = createCard(doc, 'image', { attachedTo: note }, U)
    expect(attachmentTarget(index.get(image)!.card, lookup)).toBeNull()
  })

  it('reads collapsed only when it is literally true', () => {
    const { doc, index } = board()
    const ids = [true, 'true', 1, null].map((v) => createCard(doc, 'comment', { collapsed: v }, U))
    expect(ids.map((id) => isCollapsedThread(index.get(id)!.card))).toEqual([true, false, false, false])
    expect(getCards(doc).size).toBe(4)
  })
})

describe('markers', () => {
  const rect = { x: 100, y: 50, w: 300, h: 120 }

  it('puts the first marker on the top-right corner of the card', () => {
    expect(markerPositions(rect, 1, 1)).toEqual([{ x: 100 + 300 - 14, y: 50 - 14 }])
    expect(MARKER_SIZE).toBe(28)
  })

  it('stacks further markers to the left, spaced by their scaled size', () => {
    const [a, b, c] = markerPositions(rect, 3, 1)
    expect(a.x - b.x).toBe(MARKER_SIZE + MARKER_GAP)
    expect(b.x - c.x).toBe(MARKER_SIZE + MARKER_GAP)
    expect(new Set([a.y, b.y, c.y]).size).toBe(1)
    const [p, q] = markerPositions(rect, 2, 1.5)
    expect(p.x - q.x).toBe((MARKER_SIZE + MARKER_GAP) * 1.5)
    // Scaling happens around the marker centre, so the first one stays centred on the corner.
    expect(p).toEqual(a)
  })

  it('returns nothing for no markers', () => {
    expect(markerPositions(rect, 0, 1)).toEqual([])
  })

  it('scales markers by 1/zoom within limits', () => {
    expect(markerScale(1)).toBe(1)
    expect(markerScale(0.8)).toBeCloseTo(1.25)
    expect(markerScale(0.1)).toBe(1.5)
    expect(markerScale(4)).toBe(0.6)
    expect(markerScale(0)).toBe(1)
    expect(markerScale(Number.NaN)).toBe(1)
  })

  it('groups pins per card, oldest first, with ties broken by id', () => {
    const groups = groupPins([
      { id: 'c3', target: 'a', createdAt: 30 },
      { id: 'c1', target: 'a', createdAt: 10 },
      { id: 'c2', target: 'b', createdAt: 5 },
      { id: 'c0', target: 'a', createdAt: 10 },
    ])
    expect(Array.from(groups.entries())).toEqual([
      ['b', ['c2']],
      ['a', ['c0', 'c1', 'c3']],
    ])
  })

  it('lists the comments pinned to one card, oldest first', () => {
    const { doc, index, lookup } = board()
    const note = createCard(doc, 'note', {}, U)
    const other = createCard(doc, 'note', {}, U)
    const second = createCard(doc, 'comment', { attachedTo: note, createdAt: 20 }, U)
    const first = createCard(doc, 'comment', { attachedTo: note, createdAt: 10 }, U)
    createCard(doc, 'comment', { attachedTo: other }, U)
    createCard(doc, 'comment', {}, U)
    expect(pinsOn(index.getSnapshot(), lookup, note)).toEqual([first, second])
    deleteCards(doc, [first], U)
    expect(pinsOn(index.getSnapshot(), lookup, note)).toEqual([second])
    expect(pinsOn(index.getSnapshot(), lookup, 'missing')).toEqual([])
  })
})

describe('comment drafts', () => {
  afterEach(() => resetDrafts())

  it('keys reply drafts by board and card, and message edits below them', () => {
    expect(draftKey('board1', 'card1')).toBe('board1:card1')
    expect(editDraftKey('board1', 'card1', 'msg1')).toBe('board1:card1:edit:msg1')
    expect(draftKey('board1', 'card1')).not.toBe(draftKey('board2', 'card1'))
  })

  it('keeps drafts outside components and notifies subscribers', () => {
    const key = draftKey('b', 'c')
    let calls = 0
    const off = subscribeDraft(key, () => calls++)
    setDraft(key, { text: 'Hello @Ana', mentions: [{ id: 'ana', name: 'Ana' }] })
    expect(getDraft(key)?.text).toBe('Hello @Ana')
    expect(hasUnsentText(key)).toBe(true)
    expect(calls).toBe(1)
    setDraft(key, { text: '   ', mentions: [] })
    expect(hasUnsentText(key)).toBe(false)
    clearDraft(key)
    expect(getDraft(key)).toBeUndefined()
    expect(calls).toBe(3)
    off()
    setDraft(key, { text: 'again', mentions: [] })
    expect(calls).toBe(3)
  })

  it('forgets the oldest drafts beyond the limit', () => {
    for (let i = 0; i <= MAX_DRAFTS; i++) setDraft(draftKey('b', `c${i}`), { text: `t${i}`, mentions: [] })
    expect(getDraft(draftKey('b', 'c0'))).toBeUndefined()
    expect(getDraft(draftKey('b', `c${MAX_DRAFTS}`))?.text).toBe(`t${MAX_DRAFTS}`)
  })
})
