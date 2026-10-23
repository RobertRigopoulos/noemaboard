import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { updateFirstSeen, purgeExpiredTrashLocally } from './trashClock'
import { createCard, deleteCards, getCards } from '../model/board'

describe('trash first-seen clock', () => {
  it('keeps known groups, adds new ones as seen now, and forgets groups that are gone', () => {
    expect(updateFirstSeen({ g1: 100, g2: 200, gone: 50 }, ['g1', 'g2', 'g3'], 1000)).toEqual({ g1: 100, g2: 200, g3: 1000 })
    // malformed or future values are reset to now
    expect(updateFirstSeen({ g1: 'x', g2: 5000 }, ['g1', 'g2'], 1000)).toEqual({ g1: 1000, g2: 1000 })
    expect(updateFirstSeen(null, ['g'], 7)).toEqual({ g: 7 })
  })

  it('does not purge a group this device has just seen, even if its trashedAt is very old', () => {
    const doc = new Y.Doc({ guid: 'b1' })
    const id = createCard(doc, 'note', {}, 'u')
    deleteCards(doc, [id], 'u')
    getCards(doc).get(id)!.set('trashedAt', Date.now() - 400 * 24 * 3600 * 1000)
    purgeExpiredTrashLocally(doc, 'b1')
    expect(getCards(doc).has(id)).toBe(true)
  })
})
