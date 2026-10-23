import { describe, expect, it } from 'vitest'
import { computeDropIndex } from './dropIndex'

const rects = [
  { y: 0, h: 100 },
  { y: 110, h: 40 },
  { y: 160, h: 200 },
]

describe('computeDropIndex', () => {
  it('inserts before the first child whose midpoint is below the pointer', () => {
    expect(computeDropIndex(rects, -20)).toBe(0)
    expect(computeDropIndex(rects, 49)).toBe(0)
    expect(computeDropIndex(rects, 50)).toBe(1)
    expect(computeDropIndex(rects, 129)).toBe(1)
    expect(computeDropIndex(rects, 131)).toBe(2)
    expect(computeDropIndex(rects, 259)).toBe(2)
  })

  it('appends below the last midpoint and in empty columns', () => {
    expect(computeDropIndex(rects, 260)).toBe(3)
    expect(computeDropIndex(rects, 10_000)).toBe(3)
    expect(computeDropIndex([], 0)).toBe(0)
  })

  it('skips children that are not rendered', () => {
    expect(computeDropIndex([null, { y: 100, h: 100 }], 120)).toBe(1)
    expect(computeDropIndex([null, null], 0)).toBe(2)
  })
})
