import { describe, expect, it } from 'vitest'
import { fitAspect, fractionRatio, moveCrop, nudgeFor, resizeCrop } from './cropMath'
import type { Crop } from './transform'

const free = { ratio: null, minW: 0.05, minH: 0.05 }
const close = (a: Crop, b: Crop) => {
  expect(a.x).toBeCloseTo(b.x)
  expect(a.y).toBeCloseTo(b.y)
  expect(a.w).toBeCloseTo(b.w)
  expect(a.h).toBeCloseTo(b.h)
}

describe('moveCrop', () => {
  it('moves the box and keeps it inside the picture', () => {
    close(moveCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 0.1, -0.1), { x: 0.3, y: 0.1, w: 0.5, h: 0.5 })
    close(moveCrop({ x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, 1, -1), { x: 0.5, y: 0, w: 0.5, h: 0.5 })
  })
})

describe('resizeCrop', () => {
  const box = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }

  it('moves only the dragged edges of a free box', () => {
    close(resizeCrop(box, 'se', 0.1, 0.2, free), { x: 0.2, y: 0.2, w: 0.5, h: 0.6 })
    close(resizeCrop(box, 'nw', -0.1, 0.1, free), { x: 0.1, y: 0.3, w: 0.5, h: 0.3 })
    close(resizeCrop(box, 'e', 0.1, 0.3, free), { x: 0.2, y: 0.2, w: 0.5, h: 0.4 })
    close(resizeCrop(box, 'n', 0.3, -0.5, free), { x: 0.2, y: 0, w: 0.4, h: 0.6 })
  })

  it('stops at the picture edges and the minimum size', () => {
    close(resizeCrop(box, 'se', 5, 5, free), { x: 0.2, y: 0.2, w: 0.8, h: 0.8 })
    close(resizeCrop(box, 'w', 5, 0, free), { x: 0.55, y: 0.2, w: 0.05, h: 0.4 })
  })

  it('keeps the ratio while one is locked', () => {
    const locked = { ratio: 2, minW: 0.05, minH: 0.05 }
    const start = { x: 0.1, y: 0.1, w: 0.4, h: 0.2 }
    const corner = resizeCrop(start, 'se', 0.2, 0, locked)
    expect(corner.w / corner.h).toBeCloseTo(2)
    close(corner, { x: 0.1, y: 0.1, w: 0.6, h: 0.3 })
    const side = resizeCrop(start, 'e', 0.2, 0, locked)
    expect(side.w / side.h).toBeCloseTo(2)
    // The height follows around the old centre (0.2).
    expect(side.y + side.h / 2).toBeCloseTo(0.2)
    const top = resizeCrop(start, 'n', 0, -0.05, locked)
    expect(top.w / top.h).toBeCloseTo(2)
    expect(top.y + top.h).toBeCloseTo(0.3)
    // A mostly horizontal drag inwards shrinks the box too.
    const shrunk = resizeCrop(start, 'se', -0.2, 0.01, locked)
    close(shrunk, { x: 0.1, y: 0.1, w: 0.2, h: 0.1 })
    // Clamped by the picture while keeping the ratio.
    const big = resizeCrop(start, 'se', 5, 5, locked)
    expect(big.w / big.h).toBeCloseTo(2)
    expect(big.x + big.w).toBeLessThanOrEqual(1 + 1e-9)
    expect(big.y + big.h).toBeLessThanOrEqual(1 + 1e-9)
  })
})

describe('fitAspect', () => {
  it('fits the largest box of the ratio centred in the current box', () => {
    close(fitAspect({ x: 0, y: 0, w: 1, h: 1 }, 2), { x: 0, y: 0.25, w: 1, h: 0.5 })
    close(fitAspect({ x: 0, y: 0, w: 1, h: 1 }, 0.5), { x: 0.25, y: 0, w: 0.5, h: 1 })
  })

  it('converts pixel aspects to fraction ratios', () => {
    // 1:1 on a 400x200 picture is half as wide as tall in fractions.
    expect(fractionRatio(1, 400, 200)).toBeCloseTo(0.5)
    // "Original" is always 1 in fractions.
    expect(fractionRatio(400 / 200, 400, 200)).toBeCloseTo(1)
  })
})

describe('nudgeFor', () => {
  it('moves only the axes a handle can move', () => {
    expect(nudgeFor('n', 'ArrowLeft', 0.01)).toBeNull()
    expect(nudgeFor('n', 'ArrowUp', 0.01)).toEqual({ du: 0, dv: -0.01 })
    expect(nudgeFor('se', 'ArrowRight', 0.1)).toEqual({ du: 0.1, dv: 0 })
    expect(nudgeFor('box', 'ArrowDown', 0.01)).toEqual({ du: 0, dv: 0.01 })
    expect(nudgeFor('box', 'Enter', 0.01)).toBeNull()
  })
})
