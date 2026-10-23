import { describe, expect, it } from 'vitest'
import {
  chooseLandscape,
  exportBounds,
  fitPageZoom,
  fitScale,
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  MAX_FIT_ZOOM,
  pageContentPx,
  parseUnicodeRange,
  rangeCovers,
  tileGrid,
} from './raster'

describe('exportBounds', () => {
  it('unions the rects and pads them', () => {
    expect(exportBounds([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: -20, w: 10, h: 10 }], 40)).toEqual({ x: -40, y: -60, w: 290, h: 150 })
  })

  it('ignores missing and non-finite rects, and is null when nothing is left', () => {
    expect(exportBounds([null, undefined, { x: Number.NaN, y: 0, w: 1, h: 1 }])).toBeNull()
    expect(exportBounds([])).toBeNull()
    expect(exportBounds([null, { x: 10, y: 10, w: 0, h: 0 }], 5)).toEqual({ x: 5, y: 5, w: 10, h: 10 })
  })

  it('rounds outwards to whole pixels', () => {
    expect(exportBounds([{ x: 0.4, y: 0.6, w: 10.2, h: 10.2 }], 0)).toEqual({ x: 0, y: 0, w: 11, h: 11 })
  })
})

describe('fitScale', () => {
  it('keeps the requested scale when the image fits', () => {
    expect(fitScale(1000, 800, 2)).toEqual({ scale: 2, limited: false })
  })

  it('reduces the scale to the side limit', () => {
    const r = fitScale(10_000, 500, 2)
    expect(r.limited).toBe(true)
    expect(Math.ceil(10_000 * r.scale)).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
    expect(r.scale).toBeGreaterThan(1.6)
  })

  it('reduces the scale to the pixel limit', () => {
    // Both sides are within the side limit, but together they are too many pixels.
    const r = fitScale(16_384, 16_384, 1)
    expect(r.limited).toBe(true)
    expect(Math.ceil(16_384 * r.scale) ** 2).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
    expect(Math.ceil(16_384 * r.scale)).toBeLessThanOrEqual(MAX_CANVAS_SIDE)
    const wide = fitScale(12_000, 12_000, 2)
    expect(Math.ceil(12_000 * wide.scale) ** 2).toBeLessThanOrEqual(MAX_CANVAS_PIXELS)
  })

  it('respects custom limits and rejects empty sizes', () => {
    expect(fitScale(100, 100, 2, { maxSide: 150, maxPixels: 1e9 }).scale).toBeLessThanOrEqual(1.5)
    expect(fitScale(0, 100, 2)).toEqual({ scale: 0, limited: false })
  })
})

describe('pages', () => {
  it('chooses landscape for wide content', () => {
    expect(chooseLandscape({ w: 300, h: 200 })).toBe(true)
    expect(chooseLandscape({ w: 200, h: 300 })).toBe(false)
  })

  it('computes the printable area per paper and orientation', () => {
    const a4 = pageContentPx('A4', false)
    const a4l = pageContentPx('A4', true)
    expect(a4.w).toBeLessThan(a4.h)
    expect(a4l.w).toBeGreaterThan(a4l.h)
    // 210mm - 2 x 10mm margin - 1mm slack = 189mm.
    expect(a4.w).toBe(Math.floor(189 * (96 / 25.4)))
    expect(pageContentPx('A3', false).w).toBeGreaterThan(a4.w)
  })

  it('fits content on one page without enlarging small content too much', () => {
    expect(fitPageZoom({ w: 2000, h: 1000 }, { w: 1000, h: 1000 })).toBe(0.5)
    expect(fitPageZoom({ w: 100, h: 100 }, { w: 1000, h: 800 })).toBe(MAX_FIT_ZOOM)
  })
})

describe('tileGrid', () => {
  it('splits the bounds into page-sized tiles, row by row', () => {
    const g = tileGrid({ x: 10, y: 20, w: 250, h: 150 }, { w: 100, h: 100 }, 1)
    expect([g.cols, g.rows, g.zoom]).toEqual([3, 2, 1])
    expect(g.tiles).toHaveLength(6)
    expect(g.tiles[0]).toEqual({ x: 10, y: 20, w: 100, h: 100 })
    expect(g.tiles[2]).toEqual({ x: 210, y: 20, w: 100, h: 100 })
    expect(g.tiles[3]).toEqual({ x: 10, y: 120, w: 100, h: 100 })
  })

  it('uses one page when the content fits exactly', () => {
    const g = tileGrid({ x: 0, y: 0, w: 200, h: 100 }, { w: 200, h: 100 })
    expect([g.cols, g.rows]).toEqual([1, 1])
  })

  it('scales tiles with the zoom', () => {
    const g = tileGrid({ x: 0, y: 0, w: 400, h: 100 }, { w: 100, h: 100 }, 0.5)
    expect([g.cols, g.rows]).toEqual([2, 1])
    expect(g.tiles[1]).toEqual({ x: 200, y: 0, w: 200, h: 200 })
  })

  it('shrinks the zoom until the page count is within the limit', () => {
    const g = tileGrid({ x: 0, y: 0, w: 10_000, h: 10_000 }, { w: 100, h: 100 }, 1, 16)
    expect(g.cols * g.rows).toBeLessThanOrEqual(16)
    expect(g.zoom).toBeLessThan(1)
    // The tiles still cover everything.
    expect(g.cols * g.tiles[0].w).toBeGreaterThanOrEqual(10_000)
    expect(g.rows * g.tiles[0].h).toBeGreaterThanOrEqual(10_000)
  })
})

describe('unicode ranges', () => {
  it('parses single code points, ranges and wildcards', () => {
    expect(parseUnicodeRange('U+0000-00FF, U+0131, u+02??')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x200, 0x2ff],
    ])
    expect(parseUnicodeRange('garbage')).toEqual([])
  })

  it('tells whether text needs a range', () => {
    const latin = parseUnicodeRange('U+0000-00FF')
    expect(rangeCovers(latin, 'Hello')).toBe(true)
    expect(rangeCovers(parseUnicodeRange('U+0400-045F'), 'Hello')).toBe(false)
    expect(rangeCovers(parseUnicodeRange('U+0400-045F'), 'Привет')).toBe(true)
    expect(rangeCovers([], 'anything')).toBe(true)
  })
})
