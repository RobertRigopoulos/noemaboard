import { describe, expect, it } from 'vitest'
import {
  ATTACH_GAP,
  arrowHeadPath,
  arrowSize,
  bendFromMidpoint,
  clampThickness,
  cleanLabel,
  controlPoint,
  curvePath,
  dashArray,
  endDirection,
  lineColor,
  linePaths,
  lineStyle,
  MAX_LABEL_LENGTH,
  pointInside,
  quadBounds,
  quadPoint,
  quadTangent,
  rectBoundaryPoint,
  resolveLine,
  type Rect,
} from './geometry'

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)

describe('rectBoundaryPoint', () => {
  const r: Rect = { x: 0, y: 0, w: 200, h: 100 }

  it('exits through the right edge towards a point on the right', () => {
    expect(rectBoundaryPoint(r, { x: 500, y: 50 })).toEqual({ x: 200 + ATTACH_GAP, y: 50 })
  })

  it('exits through the top and left edges', () => {
    expect(rectBoundaryPoint(r, { x: 100, y: -300 }, 0)).toEqual({ x: 100, y: 0 })
    expect(rectBoundaryPoint(r, { x: -50, y: 50 }, 0)).toEqual({ x: 0, y: 50 })
  })

  it('handles diagonal rays hitting the shorter side first', () => {
    // Direction (1, 1) from (100, 50): the bottom edge (y = 100) is reached at x = 150.
    const p = rectBoundaryPoint(r, { x: 400, y: 350 }, 0)
    close(p.x, 150)
    close(p.y, 100)
  })

  it('pushes the point out along the ray by the gap', () => {
    const p = rectBoundaryPoint(r, { x: 400, y: 350 }, 10)
    close(p.x, 150 + 10 / Math.SQRT2)
    close(p.y, 100 + 10 / Math.SQRT2)
  })

  it('returns the right edge middle when aimed at its own centre', () => {
    expect(rectBoundaryPoint(r, { x: 100, y: 50 })).toEqual({ x: 200 + ATTACH_GAP, y: 50 })
  })

  it('works for zero-size rects', () => {
    expect(rectBoundaryPoint({ x: 10, y: 10, w: 0, h: 0 }, { x: 20, y: 10 }, 0)).toEqual({ x: 10, y: 10 })
  })
})

describe('quadratic helpers', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 100, y: 0 }

  it('control point is the chord midpoint when straight and offset along the normal when bent', () => {
    expect(controlPoint(a, b, 0)).toEqual({ x: 50, y: 0 })
    const c = controlPoint(a, b, 40)
    close(c.x, 50)
    close(c.y, 40)
    const c2 = controlPoint(a, b, -40)
    close(c2.y, -40)
  })

  it('control point of a zero-length chord is the point itself', () => {
    expect(controlPoint(a, a, 30)).toEqual({ x: 0, y: 0 })
  })

  it('evaluates the curve at its ends and midpoint', () => {
    const c = controlPoint(a, b, 40)
    expect(quadPoint(a, c, b, 0)).toEqual(a)
    const end = quadPoint(a, c, b, 1)
    close(end.x, 100)
    close(end.y, 0)
    const m = quadPoint(a, c, b, 0.5)
    close(m.x, 50)
    close(m.y, 20)
  })

  it('tangents point from the ends towards the control point', () => {
    const c = { x: 50, y: 40 }
    expect(quadTangent(a, c, b, 0)).toEqual({ x: 100, y: 80 })
    expect(quadTangent(a, c, b, 1)).toEqual({ x: 100, y: -80 })
  })

  it('bendFromMidpoint inverts the curve midpoint', () => {
    const p = { x: 30, y: -20 }
    const q = { x: 170, y: 90 }
    for (const bend of [-120, -15, 0, 33, 250]) {
      const c = controlPoint(p, q, bend)
      const m = quadPoint(p, c, q, 0.5)
      close(bendFromMidpoint(p, q, m), bend)
    }
  })

  it('bendFromMidpoint ignores movement along the chord and degenerate chords', () => {
    close(bendFromMidpoint(a, b, { x: 90, y: 0 }), 0)
    expect(bendFromMidpoint(a, a, { x: 5, y: 5 })).toBe(0)
  })

  it('quadBounds covers the curve extremum, not the control point', () => {
    const c = { x: 50, y: 40 }
    const r = quadBounds(a, c, b)
    close(r.x, 0)
    close(r.w, 100)
    close(r.y, 0)
    close(r.h, 20)
  })

  it('quadBounds of a straight segment is its box', () => {
    const r = quadBounds({ x: 10, y: 50 }, { x: 30, y: 30 }, { x: 50, y: 10 })
    expect(r).toEqual({ x: 10, y: 10, w: 40, h: 40 })
  })
})

describe('resolveLine', () => {
  const rects: Record<string, Rect> = {
    left: { x: 0, y: 0, w: 100, h: 100 },
    right: { x: 300, y: 0, w: 100, h: 100 },
  }
  const getRect = (id: string) => rects[id] ?? null

  it('keeps free ends at their stored points', () => {
    const r = resolveLine({ from: { card: null, x: 1, y: 2 }, to: { card: null, x: 50, y: 60 }, bend: 0 }, getRect)
    expect(r.a).toEqual({ x: 1, y: 2 })
    expect(r.b).toEqual({ x: 50, y: 60 })
    expect(r.c).toEqual({ x: 25.5, y: 31 })
  })

  it('moves free ends by the drag offset', () => {
    const r = resolveLine(
      { from: { card: null, x: 0, y: 0 }, to: { card: 'left', x: 0, y: 0 }, bend: 0 },
      getRect,
      { dx: -100, dy: 50 },
    )
    expect(r.a).toEqual({ x: -100, y: 50 })
  })

  it('connects two cards edge to edge along their centres', () => {
    const r = resolveLine({ from: { card: 'left', x: 0, y: 0 }, to: { card: 'right', x: 0, y: 0 }, bend: 0 }, getRect)
    expect(r.a).toEqual({ x: 100 + ATTACH_GAP, y: 50 })
    expect(r.b).toEqual({ x: 300 - ATTACH_GAP, y: 50 })
  })

  it('aims an attached end at a free end', () => {
    const r = resolveLine({ from: { card: 'left', x: 0, y: 0 }, to: { card: null, x: 50, y: 400 }, bend: 0 }, getRect)
    expect(r.a).toEqual({ x: 50, y: 100 + ATTACH_GAP })
    expect(r.b).toEqual({ x: 50, y: 400 })
  })

  it('bent lines leave their cards towards the curve', () => {
    const r = resolveLine({ from: { card: 'left', x: 0, y: 0 }, to: { card: 'right', x: 0, y: 0 }, bend: -300 }, getRect)
    // Negative bend pulls the curve upwards (towards -y) for a left-to-right chord.
    expect(r.a.y).toBeLessThan(50)
    expect(r.b.y).toBeLessThan(50)
    expect(r.c.y).toBeLessThan(r.a.y)
  })

  it('falls back to the last known point when the attached card is missing', () => {
    const r = resolveLine({ from: { card: 'gone', x: 7, y: 8 }, to: { card: 'right', x: 0, y: 0 }, bend: 0 }, getRect)
    expect(r.a).toEqual({ x: 7, y: 8 })
    // Leaves the right card through its left edge, aimed at the fallback point.
    expect(r.b.x).toBeLessThan(300)
    expect(r.b.x).toBeGreaterThan(300 - ATTACH_GAP - 0.5)
  })

  it('survives garbage numbers from peers', () => {
    const r = resolveLine({ from: { card: null, x: NaN, y: Infinity }, to: { card: null, x: 1e30, y: 0 }, bend: NaN }, getRect)
    expect(Number.isFinite(r.a.x) && Number.isFinite(r.a.y) && Number.isFinite(r.b.x) && Number.isFinite(r.c.x)).toBe(true)
  })
})

describe('line rendering', () => {
  it('arrowheads grow with thickness', () => {
    expect(arrowSize(4).length).toBeGreaterThan(arrowSize(2).length)
    expect(arrowSize(4).halfWidth).toBeGreaterThan(arrowSize(2).halfWidth)
  })

  it('draws the arrowhead with its tip at the end point', () => {
    const d = arrowHeadPath({ x: 100, y: 0 }, { x: 1, y: 0 }, { length: 10, halfWidth: 5 })
    expect(d).toBe('M100 0L90 5L90 -5Z')
  })

  it('end direction follows the tangent with fallbacks', () => {
    expect(endDirection({ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 })).toEqual({ x: 1, y: 0 })
    expect(endDirection({ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 50 })).toEqual({ x: 0, y: 1 })
    expect(endDirection({ x: 3, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 3 })).toEqual({ x: 1, y: 0 })
  })

  it('shortens the stroke under arrowheads but keeps the full path for hit testing', () => {
    const r = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 50, y: 0 } }
    const p = linePaths(r, { thickness: 2, arrowStart: false, arrowEnd: true, straight: true })
    expect(p.full).toBe('M0 0L100 0')
    const trimmed = 100 - arrowSize(2).length * 0.7
    expect(p.stroke).toBe(`M0 0L${trimmed} 0`)
    expect(p.arrows.startsWith('M100 0')).toBe(true)
    expect(p.mid).toEqual({ x: 50, y: 0 })
    expect(p.degenerate).toBe(false)
  })

  it('draws both arrowheads when requested and none for degenerate lines', () => {
    const r = { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, c: { x: 50, y: 0 } }
    const both = linePaths(r, { thickness: 2, arrowStart: true, arrowEnd: true, straight: true })
    expect(both.arrows.match(/Z/g)?.length).toBe(2)
    const dot = linePaths({ a: { x: 5, y: 5 }, b: { x: 5.5, y: 5 }, c: { x: 5.25, y: 5 } }, { thickness: 2, arrowStart: true, arrowEnd: true, straight: true })
    expect(dot.degenerate).toBe(true)
    expect(dot.arrows).toBe('')
  })

  it('uses a quadratic path when bent', () => {
    expect(curvePath({ x: 0, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 0 }, false)).toBe('M0 0Q50 40 100 0')
  })

  it('dash pattern scales with thickness', () => {
    expect(dashArray(2)).toBe('6 6')
    expect(dashArray(4)).toBe('12 12')
  })
})

describe('line style sanitising', () => {
  it('maps card colors to CSS variables and rejects unknown values', () => {
    expect(lineColor('blue')).toBe('var(--c-blue)')
    expect(lineColor('dark')).toBe('var(--text)')
    expect(lineColor(null)).toBe('var(--text-2)')
    expect(lineColor('red; background: url(x)')).toBe('var(--text-2)')
  })

  it('clamps thickness and cleans labels', () => {
    expect(clampThickness(2)).toBe(2)
    expect(clampThickness(1000)).toBe(16)
    expect(clampThickness(-3)).toBe(1)
    expect(clampThickness('4')).toBe(2)
    expect(cleanLabel('a\nb')).toBe('a b')
    expect(cleanLabel('x'.repeat(5000)).length).toBe(MAX_LABEL_LENGTH)
    expect(cleanLabel(42)).toBe('')
  })

  it('defaults to an end arrow only', () => {
    expect(lineStyle({})).toMatchObject({ arrowStart: false, arrowEnd: true, dashed: false, thickness: 2, label: '' })
    expect(lineStyle({ arrowEnd: false, dashed: true, thickness: 4 })).toMatchObject({ arrowEnd: false, dashed: true, thickness: 4 })
  })

  it('pointInside includes edges', () => {
    const r = { x: 0, y: 0, w: 10, h: 10 }
    expect(pointInside({ x: 10, y: 0 }, r)).toBe(true)
    expect(pointInside({ x: 10.1, y: 0 }, r)).toBe(false)
  })
})
