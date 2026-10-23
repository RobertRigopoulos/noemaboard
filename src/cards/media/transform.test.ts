import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, readCard, updateCard } from '../../model/board'
import {
  applyMatrix,
  clampCrop,
  displayAspect,
  flipCrop,
  flipTransform,
  IDENTITY,
  isIdentity,
  orientedSize,
  readImageTransform,
  rotateCrop,
  rotateTransform,
  transformFields,
  transformMatrix,
  transformStyle,
  type Crop,
  type ImageTransform,
} from './transform'

const crop = (x: number, y: number, w: number, h: number): Crop => ({ x, y, w, h })
const t = (patch: Partial<ImageTransform>): ImageTransform => ({ ...IDENTITY, ...patch })

describe('readImageTransform', () => {
  it('returns the identity for missing or malformed cards', () => {
    expect(readImageTransform(null, 100, 100)).toEqual(IDENTITY)
    expect(readImageTransform('nope', 100, 100)).toEqual(IDENTITY)
    expect(readImageTransform({}, 100, 100)).toEqual(IDENTITY)
    expect(isIdentity(readImageTransform({}, 100, 100))).toBe(true)
  })

  it('accepts only quarter turns', () => {
    expect(readImageTransform({ rotation: 90 }, 100, 100).rotation).toBe(90)
    expect(readImageTransform({ rotation: 270 }, 100, 100).rotation).toBe(270)
    expect(readImageTransform({ rotation: 45 }, 100, 100).rotation).toBe(0)
    expect(readImageTransform({ rotation: -90 }, 100, 100).rotation).toBe(0)
    expect(readImageTransform({ rotation: '90' }, 100, 100).rotation).toBe(0)
    expect(readImageTransform({ rotation: 360 }, 100, 100).rotation).toBe(0)
  })

  it('counts flips only when they are literally true', () => {
    expect(readImageTransform({ flipH: true, flipV: true }, 100, 100)).toMatchObject({ flipH: true, flipV: true })
    expect(readImageTransform({ flipH: 'true', flipV: 1 }, 100, 100)).toMatchObject({ flipH: false, flipV: false })
  })

  it('drops crops that are not four finite numbers', () => {
    expect(readImageTransform({ crop: { x: NaN, y: 0, w: 0.5, h: 0.5 } }, 100, 100).crop).toBeNull()
    expect(readImageTransform({ crop: { x: 0, y: 0, w: Infinity, h: 0.5 } }, 100, 100).crop).toBeNull()
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 0.5 } }, 100, 100).crop).toBeNull()
    expect(readImageTransform({ crop: { x: '0', y: 0, w: 0.5, h: 0.5 } }, 100, 100).crop).toBeNull()
    expect(readImageTransform({ crop: [0, 0, 0.5, 0.5] }, 100, 100).crop).toBeNull()
    expect(readImageTransform({ crop: 'x' }, 100, 100).crop).toBeNull()
  })

  it('clamps crop values into the image', () => {
    expect(readImageTransform({ crop: { x: -0.5, y: -1, w: 0.5, h: 0.4 } }, 1000, 1000).crop).toEqual(crop(0, 0, 0.5, 0.4))
    // Past the right/bottom edge: shifted back inside first.
    expect(readImageTransform({ crop: { x: 0.8, y: 0.9, w: 0.5, h: 0.5 } }, 1000, 1000).crop).toEqual(crop(0.5, 0.5, 0.5, 0.5))
    // Values above 1 are clamped; a box that ends up covering everything is no crop at all.
    expect(readImageTransform({ crop: { x: 2, y: 0, w: 5, h: 0.5 } }, 1000, 1000).crop).toEqual(crop(0, 0, 1, 0.5))
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 5, h: 7 } }, 1000, 1000).crop).toBeNull()
  })

  it('treats a crop of practically the whole image as none', () => {
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 0.9995, h: 1 } }, 1000, 1000).crop).toBeNull()
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 0.99, h: 1 } }, 1000, 1000).crop).not.toBeNull()
  })

  it('enforces a minimum crop size of 2% and 8 pixels', () => {
    // Large image: 2% wins.
    expect(readImageTransform({ crop: { x: 0.5, y: 0.5, w: 0, h: -3 } }, 1000, 1000).crop).toEqual(crop(0.5, 0.5, 0.02, 0.02))
    // Small image: 8 pixels wins (8 / 100 = 0.08).
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 0.01, h: 0.01 } }, 100, 200).crop).toEqual(crop(0, 0, 0.08, 0.04))
    // The minimum follows the oriented size: rotated, the 100px side is the height.
    expect(readImageTransform({ crop: { x: 0, y: 0, w: 0.01, h: 0.01 }, rotation: 90 }, 100, 200).crop).toEqual(crop(0, 0, 0.04, 0.08))
    // A minimum pushed past the edge shifts the box inside.
    expect(readImageTransform({ crop: { x: 1, y: 1, w: 0, h: 0 } }, 1000, 1000).crop).toEqual(crop(0.98, 0.98, 0.02, 0.02))
  })
})

describe('the combined transform field', () => {
  it('is read in preference to the separate fields of older cards', () => {
    const card = { rotation: 90, crop: { x: 0, y: 0, w: 0.5, h: 0.5 }, transform: { crop: null, rotation: 180, flipH: true, flipV: false } }
    expect(readImageTransform(card, 1000, 1000)).toEqual({ crop: null, rotation: 180, flipH: true, flipV: false })
    // Older cards: the separate fields still count.
    expect(readImageTransform({ rotation: 270, flipV: true }, 1000, 1000)).toEqual({ crop: null, rotation: 270, flipH: false, flipV: true })
  })

  it('is validated like the separate fields', () => {
    expect(readImageTransform({ transform: { rotation: 45, flipH: 'yes', crop: { x: NaN } } }, 100, 100)).toEqual(IDENTITY)
    expect(readImageTransform({ transform: { crop: { x: 0.9, y: 0, w: 0.5, h: 0.5 } } }, 1000, 1000).crop).toEqual(crop(0.5, 0, 0.5, 0.5))
    // Not an object: the card is read as before the field existed.
    expect(readImageTransform({ transform: [90], rotation: 90 }, 100, 100).rotation).toBe(90)
    expect(readImageTransform({ transform: 'x' }, 100, 100)).toEqual(IDENTITY)
  })

  it('is written whole, removing the separate fields', () => {
    const fields = transformFields(t({ crop: crop(0.1, 0.2, 0.3, 0.4), rotation: 90, flipV: true }))
    expect(fields).toEqual({
      transform: { crop: crop(0.1, 0.2, 0.3, 0.4), rotation: 90, flipH: false, flipV: true },
      crop: undefined,
      rotation: undefined,
      flipH: undefined,
      flipV: undefined,
    })
    expect(Object.keys(fields)).toContain('rotation')
    // The identity removes it.
    expect(transformFields(IDENTITY).transform).toBeUndefined()
    // What is written reads back the same.
    const back = readImageTransform({ ...fields }, 1000, 1000)
    expect(back).toEqual({ crop: crop(0.1, 0.2, 0.3, 0.4), rotation: 90, flipH: false, flipV: true })
  })

  it('never pairs one person’s crop with another person’s concurrent rotation', () => {
    const a = new Y.Doc()
    const b = new Y.Doc()
    // Edited before the combined field existed: the separate fields hold the untouched values.
    const id = createCard(a, 'image', { x: 0, y: 0, w: 300, iw: 2000, ih: 1000, crop: null, rotation: 0, flipH: false, flipV: false }, 'ua')
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    // A crops the unrotated picture; B, at the same time, turns it a quarter.
    const cropped = t({ crop: crop(0, 0, 0.25, 1) })
    updateCard(a, id, transformFields(cropped), 'ua')
    updateCard(b, id, transformFields(rotateTransform(IDENTITY, 'cw')), 'ub')
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
    const seen = [a, b].map((d) => readImageTransform(readCard(getCards(d).get(id)!), 2000, 1000))
    expect(seen[0]).toEqual(seen[1])
    // Whoever won, it is one person's whole edit.
    expect([cropped, t({ rotation: 90 })]).toContainEqual(seen[0])
  })
})

describe('clampCrop', () => {
  it('shifts before it shrinks', () => {
    expect(clampCrop(crop(0.7, 0.2, 0.6, 0.3), 1000, 1000, 0)).toEqual(crop(0.4, 0.2, 0.6, 0.3))
  })
})

describe('orientedSize and displayAspect', () => {
  it('swaps the sides on quarter turns', () => {
    expect(orientedSize(400, 300, 0)).toEqual({ w: 400, h: 300 })
    expect(orientedSize(400, 300, 90)).toEqual({ w: 300, h: 400 })
    expect(orientedSize(400, 300, 180)).toEqual({ w: 400, h: 300 })
    expect(orientedSize(400, 300, 270)).toEqual({ w: 300, h: 400 })
  })

  it('is the aspect of the cropped, rotated picture', () => {
    expect(displayAspect(t({}), 400, 300)).toBeCloseTo(4 / 3)
    expect(displayAspect(t({ rotation: 90 }), 400, 300)).toBeCloseTo(3 / 4)
    expect(displayAspect(t({ rotation: 180 }), 400, 300)).toBeCloseTo(4 / 3)
    expect(displayAspect(t({ rotation: 270 }), 400, 300)).toBeCloseTo(3 / 4)
    // Half the width of a 400x300 picture: 200x300.
    expect(displayAspect(t({ crop: crop(0, 0, 0.5, 1) }), 400, 300)).toBeCloseTo(2 / 3)
    // Rotated 90: oriented 300x400; half the width = 150x400.
    expect(displayAspect(t({ rotation: 90, crop: crop(0, 0, 0.5, 1) }), 400, 300)).toBeCloseTo(150 / 400)
  })

  it('is clamped to 1:40 .. 40:1 and falls back to 4:3 without a size', () => {
    expect(displayAspect(t({}), 10000, 10)).toBe(40)
    expect(displayAspect(t({}), 10, 10000)).toBe(1 / 40)
    expect(displayAspect(t({}), 0, 0)).toBeCloseTo(4 / 3)
    expect(displayAspect(t({ rotation: 90 }), 0, 0)).toBeCloseTo(3 / 4)
  })
})

describe('transformStyle', () => {
  it('sizes and offsets the picture for a rotated crop', () => {
    // 200x100 image turned 90 degrees: oriented 100x200.
    const s = transformStyle(t({ rotation: 90, crop: crop(0.25, 0.1, 0.5, 0.8) }), 200, 100)
    expect(s.inner).toMatchObject({ position: 'absolute', width: '200%', height: '125%', left: '-50%', top: '-12.5%' })
    // Unrotated element is as wide as the oriented height and as tall as the oriented width.
    expect(s.img).toMatchObject({ width: '200%', height: '50%', left: '50%', top: '50%' })
    expect(s.img.transform).toBe('translate(-50%, -50%) scale(1, 1) rotate(90deg)')
  })

  it('fills the frame without a crop and mirrors with flips', () => {
    const s = transformStyle(t({ flipH: true }), 400, 300)
    expect(s.inner).toMatchObject({ width: '100%', height: '100%', left: '0%', top: '0%' })
    expect(s.img).toMatchObject({ width: '100%', height: '100%' })
    expect(s.img.transform).toBe('translate(-50%, -50%) scale(-1, 1) rotate(0deg)')
  })
})

describe('rotateCrop and flipCrop', () => {
  const c = crop(0.1, 0.2, 0.3, 0.4)

  it('come back to the start after four turns or two flips', () => {
    let r: Crop | null = c
    for (let i = 0; i < 4; i++) r = rotateCrop(r, 'cw')
    expect(r!.x).toBeCloseTo(c.x)
    expect(r!.y).toBeCloseTo(c.y)
    expect(r!.w).toBeCloseTo(c.w)
    expect(r!.h).toBeCloseTo(c.h)
    r = c
    for (let i = 0; i < 4; i++) r = rotateCrop(r, 'ccw')
    expect(r!.x).toBeCloseTo(c.x)
    expect(r!.y).toBeCloseTo(c.y)
    expect(flipCrop(flipCrop(c, 'h'), 'h')).toEqual(c)
    expect(flipCrop(flipCrop(c, 'v'), 'v')).toEqual(c)
  })

  it('a clockwise and a counter-clockwise turn cancel out', () => {
    const r = rotateCrop(rotateCrop(c, 'cw'), 'ccw')!
    expect(r.x).toBeCloseTo(c.x)
    expect(r.y).toBeCloseTo(c.y)
  })

  it('keeps the same region selected', () => {
    // Top-left region, turned clockwise, is at the top right.
    expect(rotateCrop(crop(0, 0, 0.5, 0.25), 'cw')).toEqual(crop(0.75, 0, 0.25, 0.5))
    expect(flipCrop(crop(0, 0, 0.5, 0.25), 'h')).toEqual(crop(0.5, 0, 0.5, 0.25))
    expect(flipCrop(crop(0, 0, 0.5, 0.25), 'v')).toEqual(crop(0, 0.75, 0.5, 0.25))
    expect(rotateCrop(null, 'cw')).toBeNull()
  })

  it('turning a mirrored picture swaps the mirror axis', () => {
    const r = rotateTransform(t({ flipH: true }), 'cw')
    expect(r).toMatchObject({ rotation: 90, flipH: false, flipV: true })
    expect(rotateTransform(t({ rotation: 0 }), 'ccw').rotation).toBe(270)
    expect(flipTransform(flipTransform(t({ crop: c }), 'h'), 'h')).toEqual(t({ crop: c }))
  })
})

describe('transformMatrix', () => {
  it('outputs the cropped, rotated size', () => {
    expect(transformMatrix(t({}), 400, 300)).toMatchObject({ width: 400, height: 300 })
    expect(transformMatrix(t({ rotation: 90 }), 400, 300)).toMatchObject({ width: 300, height: 400 })
    expect(transformMatrix(t({ rotation: 270, crop: crop(0, 0, 0.5, 0.25) }), 400, 300)).toMatchObject({ width: 150, height: 100 })
  })

  it('scales the long edge down to maxEdge', () => {
    const m = transformMatrix(t({}), 10000, 5000, 8192)
    expect(m.width).toBe(8192)
    expect(m.height).toBe(4096)
  })

  it('maps original corners to the right output corners', () => {
    // 90 clockwise: the original top-left lands at the top-right.
    const m = transformMatrix(t({ rotation: 90 }), 400, 300).matrix
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 300, y: 0 })
    expect(applyMatrix(m, 400, 300)).toEqual({ x: 0, y: 400 })
    // Mirrored horizontally: the top-left lands at the top-right.
    const f = transformMatrix(t({ flipH: true }), 400, 300).matrix
    expect(applyMatrix(f, 0, 0)).toEqual({ x: 400, y: 0 })
    // Cropped to the right half: the original's middle top is the output's origin.
    const c = transformMatrix(t({ crop: crop(0.5, 0, 0.5, 1) }), 400, 300).matrix
    expect(applyMatrix(c, 200, 0)).toEqual({ x: 0, y: 0 })
    for (const rotation of [0, 90, 180, 270] as const) {
      const r = transformMatrix(t({ rotation, flipV: true }), 400, 300)
      // Every corner of the original lands on a corner of the output.
      for (const [px, py] of [[0, 0], [400, 0], [0, 300], [400, 300]]) {
        const p = applyMatrix(r.matrix, px, py)
        expect([0, r.width]).toContain(Math.round(p.x))
        expect([0, r.height]).toContain(Math.round(p.y))
      }
    }
  })
})
