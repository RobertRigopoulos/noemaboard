import { describe, expect, it } from 'vitest'
import { MAX_ORIGINAL_BYTES, MAX_STORED_EDGE, MAX_STORED_PIXELS, storagePlan, thumbSize } from './image'

const MB = 1024 * 1024

describe('storagePlan', () => {
  it('keeps long full-page screenshots as they are', () => {
    expect(storagePlan(1440, 12000, 3 * MB)).toEqual({ reencode: false, scale: 1 })
    expect(storagePlan(1080, 20000, 4 * MB)).toEqual({ reencode: false, scale: 1 })
  })

  it('keeps ordinary photos', () => {
    expect(storagePlan(4032, 3024, 4 * MB)).toEqual({ reencode: false, scale: 1 })
  })

  it('downscales images over the short-edge or pixel limit', () => {
    const big = storagePlan(8000, 6000, 10 * MB)
    expect(big.reencode).toBe(true)
    expect(Math.round(6000 * big.scale)).toBeLessThanOrEqual(MAX_STORED_EDGE)
    expect(8000 * 6000 * big.scale ** 2).toBeLessThanOrEqual(MAX_STORED_PIXELS + 1)

    const tall = storagePlan(3000, 30000, 12 * MB)
    expect(tall.reencode).toBe(true)
    expect(3000 * 30000 * tall.scale ** 2).toBeLessThanOrEqual(MAX_STORED_PIXELS + 1)
    // Never wider/taller than a canvas can draw.
    expect(30000 * tall.scale).toBeLessThanOrEqual(16_384)
  })

  it('re-encodes (without shrinking) files that are too heavy', () => {
    expect(storagePlan(2000, 1500, MAX_ORIGINAL_BYTES + 1)).toEqual({ reencode: true, scale: 1 })
  })
})

describe('thumbSize', () => {
  it('makes an 800 px wide display copy of wide images', () => {
    expect(thumbSize(4032, 3024, 4 * MB)).toEqual({ w: 800, h: 600 })
  })

  it('limits the display copy of very tall images by height', () => {
    const t = thumbSize(1440, 12000, 3 * MB)!
    expect(t.h).toBeLessThanOrEqual(MAX_STORED_EDGE)
    expect(t.w).toBe(Math.round(1440 * (MAX_STORED_EDGE / 12000)))
    // Narrow but very tall (phone screenshots) also get one.
    expect(thumbSize(1080, 20000, 4 * MB)!.h).toBe(MAX_STORED_EDGE)
  })

  it('shows small images directly', () => {
    expect(thumbSize(1000, 800, 2 * MB)).toBeNull()
    expect(thumbSize(4000, 3000, 100 * 1024)).toBeNull()
  })
})
