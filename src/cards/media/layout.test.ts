import { describe, expect, it } from 'vitest'
import { centerGroup, gridLayout, imageCardHeight, imageCardWidth } from './layout'

describe('centerGroup', () => {
  it('centres the laid-out group on a point', () => {
    const boxes = [
      { w: 300, h: 100 },
      { w: 300, h: 100 },
    ]
    const pos = centerGroup(gridLayout(boxes, { x: 0, y: 0 }), boxes, { x: 1000, y: 500 })
    // group is 620 x 100 -> top-left at (690, 450)
    expect(pos).toEqual([
      { x: 690, y: 450 },
      { x: 1010, y: 450 },
    ])
    expect(centerGroup([], [], { x: 0, y: 0 })).toEqual([])
  })
})

describe('gridLayout', () => {
  it('returns nothing for no boxes', () => {
    expect(gridLayout([], { x: 0, y: 0 })).toEqual([])
  })

  it('places a single box at the (snapped) drop point', () => {
    expect(gridLayout([{ w: 300, h: 200 }], { x: 103, y: 47 })).toEqual([{ x: 100, y: 50 }])
  })

  it('fills three columns left to right with 20px gaps', () => {
    const boxes = Array.from({ length: 6 }, () => ({ w: 300, h: 100 }))
    expect(gridLayout(boxes, { x: 0, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 640, y: 0 },
      { x: 0, y: 120 },
      { x: 320, y: 120 },
      { x: 640, y: 120 },
    ])
  })

  it('packs mixed heights masonry-style into the shortest column', () => {
    const boxes = [
      { w: 300, h: 400 }, // col 0 -> 420
      { w: 300, h: 100 }, // col 1 -> 120
      { w: 300, h: 200 }, // col 2 -> 220
      { w: 300, h: 100 }, // shortest is col 1 (120)
      { w: 300, h: 100 }, // col 1 is 240 now, col 2 is 220 -> col 2
    ]
    expect(gridLayout(boxes, { x: 0, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 320, y: 0 },
      { x: 640, y: 0 },
      { x: 320, y: 120 },
      { x: 640, y: 220 },
    ])
  })

  it('never overlaps boxes, even with heights that are not grid multiples', () => {
    const boxes = [
      { w: 300, h: 133 },
      { w: 300, h: 77 },
      { w: 300, h: 251 },
      { w: 300, h: 19 },
      { w: 300, h: 88 },
      { w: 300, h: 141 },
      { w: 300, h: 300 },
    ]
    const pos = gridLayout(boxes, { x: 15, y: 15 })
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = { ...pos[i], ...boxes[i] }
        const b = { ...pos[j], ...boxes[j] }
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(overlap, `${i} overlaps ${j}`).toBe(false)
      }
    }
    for (const p of pos) {
      expect(p.x % 10).toBe(0)
      expect(p.y % 10).toBe(0)
    }
  })

  it('uses the widest box as column width and honours options', () => {
    const pos = gridLayout(
      [
        { w: 200, h: 50 },
        { w: 300, h: 50 },
        { w: 100, h: 50 },
      ],
      { x: 0, y: 0 },
      { columns: 2, gap: 40 },
    )
    expect(pos).toEqual([
      { x: 0, y: 0 },
      { x: 340, y: 0 },
      { x: 0, y: 90 },
    ])
  })

  it('tolerates bad sizes', () => {
    const pos = gridLayout(
      [
        { w: NaN, h: NaN },
        { w: 300, h: -5 },
      ],
      { x: 0, y: 0 },
      { columns: 1 },
    )
    expect(pos).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 120 },
    ])
  })
})

describe('image card size', () => {
  it('uses the natural width up to 300, snapped, at least 60', () => {
    expect(imageCardWidth(1920)).toBe(300)
    expect(imageCardWidth(300)).toBe(300)
    expect(imageCardWidth(214)).toBe(210)
    expect(imageCardWidth(16)).toBe(60)
    expect(imageCardWidth(0)).toBe(300)
    expect(imageCardWidth(NaN)).toBe(300)
  })

  it('derives height from the aspect ratio', () => {
    expect(imageCardHeight(300, 1920, 1080)).toBe(169)
    expect(imageCardHeight(300, 1000, 2000)).toBe(600)
    expect(imageCardHeight(300, 0, 0)).toBe(225)
  })

  it('follows the crop and rotation', () => {
    expect(imageCardHeight(300, 1920, 1080, { crop: null, rotation: 90, flipH: false, flipV: false })).toBe(533)
    expect(imageCardHeight(300, 1000, 1000, { crop: { x: 0, y: 0, w: 1, h: 0.5 }, rotation: 0, flipH: true, flipV: false })).toBe(150)
  })
})
