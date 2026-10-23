import { describe, expect, it } from 'vitest'
import { alignRects, arrangeRects, clusterRows, distributeRects, tidyRects, type ARect } from './arrange'

const r = (id: string, x: number, y: number, w: number, h: number): ARect => ({ id, x, y, w, h })

// Union bbox: x 0..250, y 0..341.
const A = r('a', 0, 0, 100, 50)
const B = r('b', 200, 30, 50, 100)
const C = r('c', 90, 300, 61, 41)
const abc = [A, B, C]

describe('alignRects', () => {
  it('aligns left and right edges to the union', () => {
    expect(alignRects(abc, 'left')).toEqual({ b: { x: 0, y: 30 }, c: { x: 0, y: 300 } })
    expect(alignRects(abc, 'right')).toEqual({ a: { x: 150, y: 0 }, c: { x: 189, y: 300 } })
  })

  it('aligns top and bottom edges, leaving cards already there out', () => {
    expect(alignRects(abc, 'top')).toEqual({ b: { x: 200, y: 0 }, c: { x: 90, y: 0 } })
    // C already ends at the union bottom.
    expect(alignRects(abc, 'bottom')).toEqual({ a: { x: 0, y: 291 }, b: { x: 200, y: 241 } })
  })

  it('centres on the union and rounds to whole pixels', () => {
    // Centre x 125: C would sit at 94.5.
    expect(alignRects(abc, 'hcenter')).toEqual({ a: { x: 75, y: 0 }, b: { x: 100, y: 30 }, c: { x: 95, y: 300 } })
    // Centre y 170.5.
    expect(alignRects(abc, 'vmiddle')).toEqual({ a: { x: 0, y: 146 }, b: { x: 200, y: 121 }, c: { x: 90, y: 150 } })
  })

  it('returns no patches when nothing moves or for a single card', () => {
    expect(alignRects([r('a', 10, 0, 50, 50), r('b', 10, 90, 80, 20)], 'left')).toEqual({})
    expect(alignRects([A], 'right')).toEqual({})
  })
})

describe('distributeRects', () => {
  it('evens the gaps of three cards, keeping the outer ones', () => {
    const list = [r('a', 0, 0, 100, 10), r('m', 130, 50, 50, 10), r('z', 400, 20, 100, 10)]
    expect(distributeRects(list, 'h')).toEqual({ m: { x: 225, y: 50 } })
  })

  it('evens the gaps of four cards in any input order', () => {
    const list = [r('d', 500, 0, 100, 10), r('b', 110, 0, 20, 10), r('a', 0, 0, 100, 10), r('c', 150, 0, 40, 10)]
    // span 400, inner widths 60, gap 113.33
    expect(distributeRects(list, 'h')).toEqual({ b: { x: 213, y: 0 }, c: { x: 347, y: 0 } })
  })

  it('works vertically and allows negative gaps', () => {
    const list = [r('a', 0, 0, 10, 100), r('b', 0, 50, 10, 200), r('c', 0, 150, 10, 100)]
    expect(distributeRects(list, 'v')).toEqual({ b: { x: 0, y: 25 } })
  })

  it('needs at least three cards', () => {
    expect(distributeRects([A, B], 'h')).toEqual({})
    expect(distributeRects([], 'v')).toEqual({})
  })
})

describe('tidyRects', () => {
  // Two rough rows: A and B (B's centre is inside A's band), then C and D.
  const mixed = [r('a', 3, 5, 100, 60), r('b', 150, 20, 200, 80), r('c', 10, 120, 150, 40), r('d', 200, 130, 50, 50)]

  it('clusters rows by vertical centre and sorts each row by x', () => {
    const rows = clusterRows([r('b', 300, 30, 10, 100), r('c', 100, 20, 10, 40), r('a', 0, 0, 10, 100), r('d', 0, 200, 10, 50)])
    expect(rows.map((row) => row.map((x) => x.id))).toEqual([['a', 'c', 'b'], ['d']])
  })

  it('lays out a grid of column widths and row heights, snapped to the grid', () => {
    const grid20 = (v: number) => Math.round(v / 20) * 20
    expect(tidyRects(mixed, 20, grid20)).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 180, y: 0 },
      c: { x: 0, y: 100 },
      d: { x: 180, y: 100 },
    })
  })

  it('leaves cards already in place without a patch', () => {
    // Anchor (3, 5); columns 150 and 200 wide; rows 80 and 50 tall; gap 20.
    expect(tidyRects(mixed, 20, Math.round)).toEqual({ b: { x: 173, y: 5 }, c: { x: 3, y: 105 }, d: { x: 173, y: 105 } })
  })

  it('snaps with the default grid preference', () => {
    const out = tidyRects(mixed)
    for (const p of Object.values(out)) {
      expect(p.x % 10).toBe(0)
      expect(p.y % 10).toBe(0)
    }
  })
})

describe('arrangeRects', () => {
  it('dispatches every mode', () => {
    expect(arrangeRects(abc, 'left')).toEqual(alignRects(abc, 'left'))
    expect(arrangeRects(abc, 'distribute-h')).toEqual(distributeRects(abc, 'h'))
    expect(arrangeRects(abc, 'distribute-v')).toEqual(distributeRects(abc, 'v'))
    expect(arrangeRects(abc, 'tidy')).toEqual(tidyRects(abc))
  })
})
