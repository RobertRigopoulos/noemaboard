import { describe, expect, it } from 'vitest'
import type { IndexedCard } from './cardIndex'
import { allFreeCards, cullCards, cullHeight } from './culling'
import type { Card } from '../model/types'

function card(id: string, fields: Partial<IndexedCard> & { collapsed?: boolean } = {}): IndexedCard {
  const type = fields.type ?? 'note'
  const c = { id, type, x: 0, y: 0, w: 300, h: undefined, z: 0, parent: null, order: 'a0', unsorted: false, ...fields }
  return { ...c, card: { ...c, collapsed: fields.collapsed ?? false } as unknown as Card }
}

const area = { x: 0, y: 2000, w: 1000, h: 800 }

describe('culling', () => {
  it('renders an unmeasured tall column whose top is above the view (returning to a scrolled-down column)', () => {
    const col = card('col', { type: 'column', y: 0 })
    const kids = Array.from({ length: 25 }, (_, i) => card(`k${i}`, { parent: 'col' }))
    const all = [col, ...kids]
    const lookup = (id: string) => all.find((c) => c.id === id)
    expect(cullCards(all, area, lookup, () => undefined)).toEqual(['col'])
  })

  it('culls measured cards by their real height and keeps column children out of the free list', () => {
    const col = card('col', { type: 'column', y: 0 })
    const kid = card('k', { parent: 'col' })
    const note = card('n', { y: 0 })
    const all = [col, kid, note]
    const sizes: Record<string, { h: number }> = { col: { h: 3000 }, k: { h: 2900 }, n: { h: 100 } }
    const lookup = (id: string) => all.find((c) => c.id === id)
    expect(cullCards(all, area, lookup, (id) => sizes[id])).toEqual(['col'])
  })

  it('estimates a measured column from its children, which may have grown while it was culled', () => {
    const col = card('col', { type: 'column' })
    const kids = [card('a', { parent: 'col' }), card('b', { parent: 'col' })]
    const sizes: Record<string, { h: number }> = { col: { h: 100 }, a: { h: 1000 }, b: { h: 1000 } }
    expect(cullHeight(col, (id) => sizes[id], kids)).toBeGreaterThanOrEqual(2000)
    // an unmeasured child makes the height unknown
    expect(cullHeight(col, (id) => (id === 'b' ? undefined : sizes[id]), kids)).toBe(Infinity)
    // collapsed columns only show their header
    expect(cullHeight(card('c2', { type: 'column', collapsed: true }), () => ({ h: 48 }), kids)).toBe(48)
    // stored heights win
    expect(cullHeight(card('s', { type: 'swatch', h: 160 }), () => undefined, undefined)).toBe(160)
  })

  it('skips cards far below or beside the view', () => {
    const below = card('below', { y: 5000 })
    const beside = card('beside', { x: 5000, y: 0 })
    const all = [below, beside]
    expect(cullCards(all, area, (id) => all.find((c) => c.id === id), () => undefined)).toEqual([])
  })

  it('leaves cards in the Unsorted drawer off the canvas', () => {
    const parked = card('parked', { y: 2100, unsorted: true })
    const shown = card('shown', { y: 2100 })
    const line = card('line', { type: 'line', y: 2100 })
    const all = [parked, shown, line]
    const lookup = (id: string) => all.find((c) => c.id === id)
    expect(cullCards(all, area, lookup, () => ({ h: 100 }))).toEqual(['shown'])
    expect(allFreeCards(all, lookup)).toEqual(['shown'])
  })

  it('renders every free card when culling is off, still without column children', () => {
    const col = card('col', { type: 'column', y: 9000 })
    const kid = card('kid', { parent: 'col' })
    const far = card('far', { x: -9000, y: -9000 })
    const all = [col, kid, far]
    expect(allFreeCards(all, (id) => all.find((c) => c.id === id))).toEqual(['col', 'far'])
  })
})
