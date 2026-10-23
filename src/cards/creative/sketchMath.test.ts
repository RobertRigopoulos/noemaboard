import { describe, expect, it } from 'vitest'
import {
  clampToMargin,
  clientToSketch,
  distToSegmentSq,
  finalizePoints,
  getSvgPathFromStroke,
  INK,
  isConstantPressure,
  MAX_STROKE_POINTS,
  parseStroke,
  pointerPressure,
  readStrokes,
  segmentDistanceSq,
  stepPenSize,
  strokeBounds,
  strokeHit,
  strokePathData,
  strokesHit,
  toTriples,
  validDim,
} from './sketchMath'

describe('point conversion', () => {
  const rect = { left: 100, top: 50, width: 200, height: 150 }

  it('maps client coordinates into drawing units regardless of on-screen scale', () => {
    // A 400x300 drawing shown at half size (e.g. zoom 0.5)
    expect(clientToSketch(100, 50, rect, 400, 300)).toEqual({ x: 0, y: 0 })
    expect(clientToSketch(300, 200, rect, 400, 300)).toEqual({ x: 400, y: 300 })
    expect(clientToSketch(200, 125, rect, 400, 300)).toEqual({ x: 200, y: 150 })
    // Same drawing shown at 2x
    const big = { left: 0, top: 0, width: 800, height: 600 }
    expect(clientToSketch(400, 300, big, 400, 300)).toEqual({ x: 200, y: 150 })
  })

  it('handles stretched cards and degenerate rects', () => {
    const stretched = { left: 0, top: 0, width: 800, height: 150 }
    expect(clientToSketch(400, 75, stretched, 400, 300)).toEqual({ x: 200, y: 150 })
    const zero = { left: 0, top: 0, width: 0, height: 0 }
    const p = clientToSketch(10, 10, zero, 400, 300)
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
  })

  it('clamps far-away points to a margin around the drawing', () => {
    expect(clampToMargin(50, 60, 400, 300)).toEqual({ x: 50, y: 60 })
    expect(clampToMargin(-5000, 99999, 400, 300)).toEqual({ x: -400, y: 600 })
  })

  it('normalizes pressure', () => {
    expect(pointerPressure('mouse', 0)).toBe(0.5)
    expect(pointerPressure('mouse', 1)).toBe(0.5)
    expect(pointerPressure('touch', 0.9)).toBe(0.5)
    expect(pointerPressure('pen', 0.8)).toBe(0.8)
    expect(pointerPressure('pen', 0)).toBe(0.5)
    expect(pointerPressure('pen', NaN)).toBe(0.5)
    expect(pointerPressure('pen', 3)).toBe(1)
  })

  it('validates drawing dimensions', () => {
    expect(validDim(400, 10)).toBe(400)
    expect(validDim(0, 300)).toBe(300)
    expect(validDim(-1, 300)).toBe(300)
    expect(validDim('400', 250)).toBe(250)
    expect(validDim(NaN, NaN)).toBe(300)
    expect(validDim(1e9, 1)).toBe(100_000)
  })
})

describe('finalizePoints', () => {
  it('rounds coordinates to 1 decimal and pressure to 2', () => {
    expect(finalizePoints([1.234, 5.678, 0.5555, 10.04, 20.06, 0.123])).toEqual([1.2, 5.7, 0.56, 10, 20.1, 0.12])
  })

  it('drops consecutive duplicates after rounding and non-finite points', () => {
    expect(finalizePoints([1, 1, 0.5, 1.01, 1.02, 0.5, NaN, 3, 0.5, 2, 2, 0.5])).toEqual([1, 1, 0.5, 2, 2, 0.5])
  })

  it('drops strokes with fewer than 2 points', () => {
    expect(finalizePoints([])).toBeNull()
    expect(finalizePoints([5, 5, 0.5])).toBeNull()
    expect(finalizePoints([5, 5, 0.5, 5.01, 5.02, 0.5])).toBeNull()
  })

  it('turns a tap into a tiny dot when asked', () => {
    expect(finalizePoints([5, 5, 0.5], { dot: true })).toEqual([5, 5, 0.5, 5.2, 5, 0.5])
    expect(finalizePoints([5, 5, 0.5, 5.01, 5.02, 0.5], { dot: true })).toEqual([5, 5, 0.5, 5.2, 5, 0.5])
  })

  it('caps the number of points', () => {
    const raw: number[] = []
    for (let i = 0; i < MAX_STROKE_POINTS + 100; i++) raw.push(i, i, 0.5)
    expect(finalizePoints(raw)!.length).toBe(MAX_STROKE_POINTS * 3)
    expect(finalizePoints(raw, { max: 10 })!.length).toBe(30)
  })

  it('detects constant pressure (mouse) vs varying pressure (pen)', () => {
    expect(isConstantPressure([0, 0, 0.5, 1, 1, 0.5, 2, 2, 0.5])).toBe(true)
    expect(isConstantPressure([0, 0, 0.3, 1, 1, 0.6])).toBe(false)
    expect(isConstantPressure([0, 0, 0.3])).toBe(true)
  })

  it('splits flattened points into triples', () => {
    expect(toTriples([1, 2, 0.5, 3, 4, 0.6, 9])).toEqual([
      [1, 2, 0.5],
      [3, 4, 0.6],
    ])
  })
})

describe('svg path helper', () => {
  it('builds a smoothed closed quadratic path', () => {
    const d = getSvgPathFromStroke([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(d).toBe('M0,0 Q10,0 10,5 T5,10 Z')
  })

  it('handles tiny outlines and empty input', () => {
    expect(getSvgPathFromStroke([])).toBe('')
    expect(
      getSvgPathFromStroke([
        [0, 0],
        [1, 1],
        [2, 0],
      ]),
    ).toBe('M0,0 L1,1 L2,0 Z')
    expect(getSvgPathFromStroke([[1.23456, 2]], false)).toBe('M1.23,2')
  })

  it('renders perfect-freehand strokes into valid path data', () => {
    const d = strokePathData([0, 0, 0.5, 20, 5, 0.5, 40, 0, 0.5, 60, 10, 0.5], 4)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(d).not.toMatch(/NaN|Infinity/)
    // pen strokes (varying pressure) work too
    expect(strokePathData([0, 0, 0.2, 20, 5, 0.8, 40, 0, 0.4], 6)).toMatch(/^M[-\d.]+,[-\d.]+ Q/)
    expect(strokePathData([], 4)).toBe('')
  })
})

describe('stroke validation', () => {
  const good = { id: 'abc123', points: [0, 0, 0.5, 10, 10, 0.5], color: '#e5484d', size: 4 }

  it('accepts a well-formed stroke', () => {
    expect(parseStroke(good)).toEqual(good)
  })

  it('rejects malformed peer data', () => {
    expect(parseStroke(null)).toBeNull()
    expect(parseStroke('stroke')).toBeNull()
    expect(parseStroke([1, 2, 3])).toBeNull()
    expect(parseStroke({ ...good, id: 5 })).toBeNull()
    expect(parseStroke({ ...good, id: '' })).toBeNull()
    expect(parseStroke({ ...good, id: 'x'.repeat(65) })).toBeNull()
    expect(parseStroke({ ...good, points: 'nope' })).toBeNull()
    expect(parseStroke({ ...good, points: [0, 0, 0.5] })).toBeNull()
    expect(parseStroke({ ...good, points: [0, 0, 0.5, 'x', 1, 0.5] })).toBeNull()
    expect(parseStroke({ ...good, points: [0, 0, 0.5, Infinity, 1, 0.5] })).toBeNull()
  })

  it('sanitizes colors, sizes and lengths', () => {
    expect(parseStroke({ ...good, color: 'url(https://evil.example/x.svg#a)' })!.color).toBe(INK)
    expect(parseStroke({ ...good, color: '#E5484D' })!.color).toBe('#e5484d')
    expect(parseStroke({ ...good, size: 1e9 })!.size).toBe(400)
    expect(parseStroke({ ...good, size: -3 })!.size).toBe(0.2)
    expect(parseStroke({ ...good, size: 'big' })!.size).toBe(4)
    // trailing partial triple is dropped
    expect(parseStroke({ ...good, points: [0, 0, 0.5, 10, 10, 0.5, 7] })!.points).toEqual([0, 0, 0.5, 10, 10, 0.5])
    const long: number[] = []
    for (let i = 0; i < MAX_STROKE_POINTS + 10; i++) long.push(i, i, 0.5)
    expect(parseStroke({ ...good, points: long })!.points.length).toBe(MAX_STROKE_POINTS * 3)
  })

  it('reads and caches strokes from Y.Array items', () => {
    const items: unknown[] = [good, { bad: true }, null, 7, { ...good, id: 'def456' }]
    const a = readStrokes(items)
    expect(a.map((s) => s.id)).toEqual(['abc123', 'def456'])
    expect(a[0].d.startsWith('M')).toBe(true)
    expect(a[0].bounds).toEqual({ x1: 0, y1: 0, x2: 10, y2: 10 })
    // Same item objects -> same cached parsed objects
    const b = readStrokes(items)
    expect(b[0]).toBe(a[0])
    expect(b[1]).toBe(a[1])
  })

  it('computes stroke bounds', () => {
    expect(strokeBounds([5, -2, 0.5, -3, 8, 0.5, 1, 1, 0.5])).toEqual({ x1: -3, y1: -2, x2: 5, y2: 8 })
    expect(strokeBounds([])).toEqual({ x1: 0, y1: 0, x2: 0, y2: 0 })
  })
})

describe('eraser hit-testing', () => {
  it('measures point-to-segment distance', () => {
    expect(distToSegmentSq(5, 5, 0, 0, 10, 0)).toBe(25)
    expect(distToSegmentSq(-3, 4, 0, 0, 10, 0)).toBe(25) // beyond the start
    expect(distToSegmentSq(2, 2, 2, 2, 2, 2)).toBe(0) // degenerate segment
  })

  it('measures segment-to-segment distance', () => {
    expect(segmentDistanceSq(0, 0, 10, 10, 0, 10, 10, 0)).toBe(0) // crossing
    expect(segmentDistanceSq(0, 0, 10, 0, 0, 3, 10, 3)).toBe(9) // parallel
    expect(segmentDistanceSq(0, 0, 1, 0, 4, 4, 4, 4)).toBe(25) // to a point
  })

  const line = { id: 's1', points: [0, 0, 0.5, 100, 0, 0.5], size: 4 }
  const far = { id: 's2', points: [0, 50, 0.5, 100, 50, 0.5], size: 4 }

  it('hits a stroke within tolerance + stroke radius', () => {
    expect(strokeHit(line, 50, 5, 50, 5, { tolerance: 4 })).toBe(true) // 5 <= 4 + 2
    expect(strokeHit(line, 50, 7, 50, 7, { tolerance: 4 })).toBe(false) // 7 > 6
    expect(strokeHit(line, 120, 0, 120, 0, { tolerance: 4 })).toBe(false)
  })

  it('hits strokes crossed by a fast eraser drag between samples', () => {
    expect(strokeHit(line, 50, -40, 50, 40, { tolerance: 1 })).toBe(true)
    expect(strokesHit([line, far], 50, -40, 50, 60, { tolerance: 1 })).toEqual(['s1', 's2'])
    expect(strokesHit([line, far], 50, 20, 50, 30, { tolerance: 1 })).toEqual([])
  })

  it('measures in board units when the drawing is stretched', () => {
    // Drawing stretched 4x vertically: 5 drawing units above the line = 20 board units.
    expect(strokeHit(line, 50, 5, 50, 5, { tolerance: 4, kx: 1, ky: 4 })).toBe(false)
    expect(strokeHit(line, 50, 1, 50, 1, { tolerance: 4, kx: 1, ky: 4 })).toBe(true)
  })

  it('uses precomputed bounds for a quick reject', () => {
    const withBounds = { ...line, bounds: strokeBounds(line.points) }
    expect(strokeHit(withBounds, 500, 500, 600, 600, { tolerance: 4 })).toBe(false)
    expect(strokeHit(withBounds, 10, 1, 10, 1, { tolerance: 4 })).toBe(true)
  })
})

describe('pen size stepping', () => {
  it('steps through presets and clamps', () => {
    expect(stepPenSize(4, 1)).toBe(8)
    expect(stepPenSize(4, -1)).toBe(2)
    expect(stepPenSize(8, 1)).toBe(8)
    expect(stepPenSize(2, -1)).toBe(2)
    expect(stepPenSize(5, 1)).toBe(8)
    expect(stepPenSize(5, -1)).toBe(4)
  })
})
