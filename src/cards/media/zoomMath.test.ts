import { describe, expect, it } from 'vitest'
import { canPan, clampPan, fitScale, MAX_SCALE, scaleLimits, wheelFactor, zoomAround } from './zoomMath'

describe('zoomAround', () => {
  it('keeps the point under the pointer fixed', () => {
    const start = { scale: 0.5, x: 30, y: -20 }
    const point = { x: 120, y: 80 }
    const next = zoomAround(start, 2.5, point)
    // Picture coordinates under the point, before and after.
    const before = { x: (point.x - start.x) / start.scale, y: (point.y - start.y) / start.scale }
    const after = { x: (point.x - next.x) / next.scale, y: (point.y - next.y) / next.scale }
    expect(next.scale).toBeCloseTo(1.25)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
  })

  it('keeps the point fixed even when the scale is clamped', () => {
    const start = { scale: 6, x: 10, y: 10 }
    const point = { x: -200, y: 50 }
    const next = zoomAround(start, 10, point)
    expect(next.scale).toBe(MAX_SCALE)
    expect((point.x - next.x) / next.scale).toBeCloseTo((point.x - start.x) / start.scale)
  })

  it('clamps the scale to 0.1x-8x', () => {
    expect(zoomAround({ scale: 4, x: 0, y: 0 }, 10, { x: 0, y: 0 }).scale).toBe(MAX_SCALE)
    expect(zoomAround({ scale: 0.2, x: 0, y: 0 }, 0.01, { x: 0, y: 0 }).scale).toBe(0.1)
  })
})

describe('fit and pan', () => {
  it('fits without enlarging', () => {
    expect(fitScale({ w: 2000, h: 1000 }, { w: 1000, h: 1000 })).toBe(0.5)
    expect(fitScale({ w: 200, h: 100 }, { w: 1000, h: 1000 })).toBe(1)
    expect(scaleLimits(0.05).min).toBe(0.05)
    expect(scaleLimits(0.5).min).toBe(0.1)
  })

  it('centres small pictures and keeps large ones covering the stage', () => {
    expect(clampPan({ scale: 1, x: 50, y: 50 }, { w: 100, h: 100 }, { w: 500, h: 500 })).toEqual({ scale: 1, x: 0, y: 0 })
    expect(clampPan({ scale: 1, x: 900, y: -900 }, { w: 1000, h: 1000 }, { w: 500, h: 500 })).toEqual({ scale: 1, x: 250, y: -250 })
    expect(canPan({ scale: 1, x: 0, y: 0 }, { w: 1000, h: 100 }, { w: 500, h: 500 })).toBe(true)
    expect(canPan({ scale: 0.4, x: 0, y: 0 }, { w: 1000, h: 100 }, { w: 500, h: 500 })).toBe(false)
  })

  it('turns wheel deltas into factors', () => {
    expect(wheelFactor(-100)).toBeGreaterThan(1)
    expect(wheelFactor(100)).toBeLessThan(1)
    expect(wheelFactor(100) * wheelFactor(-100)).toBeCloseTo(1)
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48))
  })
})
