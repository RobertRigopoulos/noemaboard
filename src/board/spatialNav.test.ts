import { describe, expect, it } from 'vitest'
import { insideInset, nextInDirection, readingOrder, tabStep, type NavCandidate, type ReadingItem } from './spatialNav'

const rect = (x: number, y: number, w = 100, h = 100) => ({ x, y, w, h })
const cand = (id: string, x: number, y: number, w = 100, h = 100): NavCandidate => ({ id, rect: rect(x, y, w, h) })

// Centre (50, 50).
const from = rect(0, 0)

describe('nextInDirection', () => {
  it('keeps only candidates inside the 90 degree cone', () => {
    const right = cand('right', 200, 0)
    const steep = cand('steep', 200, -300) // dx 200, dy -300: outside the right cone
    const left = cand('left', -300, 0)
    expect(nextInDirection(from, [steep, left, right], 'right')).toBe('right')
    expect(nextInDirection(from, [steep, left, right], 'left')).toBe('left')
    expect(nextInDirection(from, [steep, left, right], 'up')).toBe('steep')
    expect(nextInDirection(from, [steep, left, right], 'down')).toBeNull()
  })

  it('prefers a card straight ahead over a closer diagonal one', () => {
    const aligned = cand('aligned', 300, 0) // primary 300, offset 0
    const diagonal = cand('diagonal', 150, 100) // primary 150, offset 100: score 350
    expect(nextInDirection(from, [diagonal, aligned], 'right')).toBe('aligned')
    // Straight ahead and nearer still wins over farther straight ahead.
    expect(nextInDirection(from, [aligned, cand('near', 150, 0)], 'right')).toBe('near')
  })

  it('works vertically', () => {
    expect(nextInDirection(from, [cand('below', 10, 400), cand('above', 0, -200)], 'down')).toBe('below')
    expect(nextInDirection(from, [cand('below', 10, 400), cand('above', 0, -200)], 'up')).toBe('above')
  })

  it('returns null without candidates', () => {
    expect(nextInDirection(from, [], 'left')).toBeNull()
    // A card at the same centre is in no direction.
    expect(nextInDirection(from, [cand('same', 0, 0)], 'right')).toBeNull()
  })
})

const item = (id: string, x: number, y: number, h = 100, parent: string | null = null, order?: string): ReadingItem => ({
  id,
  rect: rect(x, y, 100, h),
  parent,
  order,
})

describe('readingOrder', () => {
  it('reads rows top to bottom, each left to right, with some vertical tolerance', () => {
    const items = [item('b', 300, 30), item('d', 0, 200, 50), item('c', 100, 20, 40), item('a', 0, 0)]
    expect(readingOrder(items)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('starts a new row when a centre falls below the band', () => {
    const items = [item('a', 200, 0, 50), item('b', 0, 60, 50)]
    expect(readingOrder(items)).toEqual(['a', 'b'])
  })

  it('lists column children right after their column, in column order', () => {
    const items = [
      item('k2', 500, 300, 50, 'col', 'a2'),
      item('note', 0, 0),
      item('k1', 500, 100, 50, 'col', 'a1'),
      item('col', 500, 0, 400),
      item('right', 700, 0),
    ]
    expect(readingOrder(items)).toEqual(['note', 'col', 'k1', 'k2', 'right'])
  })

  it('treats children of a column that is not listed as free cards', () => {
    expect(readingOrder([item('orphan', 0, 0, 100, 'gone', 'a0')])).toEqual(['orphan'])
  })
})

describe('tabStep', () => {
  const order = ['a', 'b', 'c']
  it('steps forward and back, and starts at the first card without a current card', () => {
    expect(tabStep(order, 'a', false)).toBe(1)
    expect(tabStep(order, 'c', true)).toBe(1)
    expect(tabStep(order, null, false)).toBe(0)
    expect(tabStep(order, 'gone', false)).toBe(0)
  })

  it('lets Shift+Tab leave the canvas before any card is reached', () => {
    expect(tabStep(order, null, true)).toBeNull()
    expect(tabStep(order, 'gone', true)).toBeNull()
  })

  it('returns null past either end so focus can leave the canvas', () => {
    expect(tabStep(order, 'c', false)).toBeNull()
    expect(tabStep(order, 'a', true)).toBeNull()
    expect(tabStep([], null, false)).toBeNull()
  })
})

describe('insideInset', () => {
  it('requires the rect to fit inside the shrunk area', () => {
    const view = rect(0, 0, 1000, 800)
    expect(insideInset(rect(40, 40, 100, 100), view, 40)).toBe(true)
    expect(insideInset(rect(39, 40, 100, 100), view, 40)).toBe(false)
    expect(insideInset(rect(900, 40, 100, 100), view, 40)).toBe(false)
  })
})
