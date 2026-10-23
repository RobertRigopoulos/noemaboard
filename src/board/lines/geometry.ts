/**
 * Pure geometry for line/arrow cards: where attached ends meet their cards, quadratic curve helpers,
 * arrowheads and SVG path strings. No DOM, no React: everything here is unit-tested in Node.
 */
import { CARD_COLORS, type CardColor } from '../../model/types'

export interface Point {
  x: number
  y: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface LineEndLike {
  card: string | null
  x: number
  y: number
}

export interface LineLike {
  from: LineEndLike
  to: LineEndLike
  bend: number
}

/** Resolved line: start `a`, end `b` and quadratic control point `c` (the chord midpoint when straight). */
export interface ResolvedLine {
  a: Point
  b: Point
  c: Point
}

/** Board-unit gap between an attached line end and its card's edge. */
export const ATTACH_GAP = 6
/** Peer data is untrusted: keep coordinates in a sane range so path strings stay finite and short. */
const COORD_LIMIT = 1e7
export const MAX_LABEL_LENGTH = 200
export const MIN_THICKNESS = 1
export const MAX_THICKNESS = 16

const finite = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const clampCoord = (v: number) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, finite(v)))

export const rectCenter = (r: Rect): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

export const distance = (p: Point, q: Point) => Math.hypot(q.x - p.x, q.y - p.y)

function unit(dx: number, dy: number): Point | null {
  const len = Math.hypot(dx, dy)
  return len > 1e-9 ? { x: dx / len, y: dy / len } : null
}

/**
 * Point where the ray from the rect's centre towards `toward` leaves the rect, pushed `gap` further
 * along the ray. A target at the centre itself yields the middle of the right edge.
 */
export function rectBoundaryPoint(rect: Rect, toward: Point, gap = ATTACH_GAP): Point {
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  const dir = unit(dx, dy)
  if (!dir) return { x: rect.x + rect.w + gap, y: cy }
  const hw = Math.max(0, rect.w / 2)
  const hh = Math.max(0, rect.h / 2)
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s + dir.x * gap, y: cy + dy * s + dir.y * gap }
}

/** Unit normal of the chord a→b (rotated +90° in screen coordinates), or null for a zero-length chord. */
export function chordNormal(a: Point, b: Point): Point | null {
  const d = unit(b.x - a.x, b.y - a.y)
  return d ? { x: -d.y, y: d.x } : null
}

/** Quadratic control point: chord midpoint offset perpendicularly by `bend`. */
export function controlPoint(a: Point, b: Point, bend: number): Point {
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const n = chordNormal(a, b)
  if (!n || !bend) return mid
  return { x: mid.x + n.x * bend, y: mid.y + n.y * bend }
}

export function quadPoint(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  }
}

/** Derivative of the quadratic curve at t (not normalised). */
export function quadTangent(a: Point, c: Point, b: Point, t: number): Point {
  return {
    x: 2 * (1 - t) * (c.x - a.x) + 2 * t * (b.x - c.x),
    y: 2 * (1 - t) * (c.y - a.y) + 2 * t * (b.y - c.y),
  }
}

/**
 * Bend that makes the curve pass through `m` at its midpoint. The curve midpoint sits halfway
 * between the chord midpoint and the control point, hence the factor 2.
 */
export function bendFromMidpoint(a: Point, b: Point, m: Point): number {
  const n = chordNormal(a, b)
  if (!n) return 0
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  return 2 * ((m.x - mx) * n.x + (m.y - my) * n.y)
}

/** Exact axis-aligned bounds of a quadratic curve (extrema where the derivative is zero). */
export function quadBounds(a: Point, c: Point, b: Point): Rect {
  const axis = (p0: number, p1: number, p2: number): [number, number] => {
    let lo = Math.min(p0, p2)
    let hi = Math.max(p0, p2)
    const denom = p0 - 2 * p1 + p2
    if (Math.abs(denom) > 1e-12) {
      const t = (p0 - p1) / denom
      if (t > 0 && t < 1) {
        const u = 1 - t
        const v = u * u * p0 + 2 * u * t * p1 + t * t * p2
        lo = Math.min(lo, v)
        hi = Math.max(hi, v)
      }
    }
    return [lo, hi]
  }
  const [x1, x2] = axis(a.x, c.x, b.x)
  const [y1, y2] = axis(a.y, c.y, b.y)
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/**
 * Resolves a line's geometry. Attached ends meet the edge of their card's rect (via `getRect`),
 * aimed at the other end (or at the curve's control point when bent). An attached end whose card
 * cannot be resolved falls back to its last known point. `offset` moves free ends (line being dragged).
 */
export function resolveLine(
  line: LineLike,
  getRect: (id: string) => Rect | null,
  offset: { dx: number; dy: number } | null = null,
): ResolvedLine {
  const odx = finite(offset?.dx)
  const ody = finite(offset?.dy)
  const ra = line.from.card ? getRect(line.from.card) : null
  const rb = line.to.card ? getRect(line.to.card) : null
  const pa = ra ? rectCenter(ra) : { x: clampCoord(line.from.x + odx), y: clampCoord(line.from.y + ody) }
  const pb = rb ? rectCenter(rb) : { x: clampCoord(line.to.x + odx), y: clampCoord(line.to.y + ody) }
  const bend = Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, finite(line.bend)))
  let a = pa
  let b = pb
  if (ra || rb) {
    // Bent lines leave their cards heading towards the curve, not towards the other end.
    const guide = bend ? controlPoint(pa, pb, bend) : null
    a = ra ? rectBoundaryPoint(ra, guide ?? pb) : pa
    b = rb ? rectBoundaryPoint(rb, guide ?? pa) : pb
  }
  return { a, b, c: controlPoint(a, b, bend) }
}

// ---------------------------------------------------------------------------
// Rendering helpers

export interface ArrowSize {
  length: number
  halfWidth: number
}

export function arrowSize(thickness: number): ArrowSize {
  return { length: 5 + thickness * 2.5, halfWidth: 2.5 + thickness * 1.5 }
}

/** Unit direction in which the curve arrives at `b` (falls back to the chord, then to +x). */
export function endDirection(a: Point, c: Point, b: Point): Point {
  return unit(b.x - c.x, b.y - c.y) ?? unit(b.x - a.x, b.y - a.y) ?? { x: 1, y: 0 }
}

const fmt = (n: number) => String(Math.round(n * 100) / 100)

/** Filled triangle with its tip at `tip`, pointing along unit vector `dir`. */
export function arrowHeadPath(tip: Point, dir: Point, size: ArrowSize): string {
  const bx = tip.x - dir.x * size.length
  const by = tip.y - dir.y * size.length
  const px = -dir.y * size.halfWidth
  const py = dir.x * size.halfWidth
  return `M${fmt(tip.x)} ${fmt(tip.y)}L${fmt(bx + px)} ${fmt(by + py)}L${fmt(bx - px)} ${fmt(by - py)}Z`
}

export function curvePath(a: Point, c: Point, b: Point, straight: boolean): string {
  return straight
    ? `M${fmt(a.x)} ${fmt(a.y)}L${fmt(b.x)} ${fmt(b.y)}`
    : `M${fmt(a.x)} ${fmt(a.y)}Q${fmt(c.x)} ${fmt(c.y)} ${fmt(b.x)} ${fmt(b.y)}`
}

/**
 * Moves an end point towards the control point by `k`. A quadratic's end tangent is parallel to
 * (end - control), so the shortened curve keeps the same direction where the arrowhead sits.
 */
function trimToward(end: Point, toward: Point, k: number): Point {
  const d = distance(end, toward)
  if (d < 1e-9 || k <= 0) return end
  const kk = Math.min(k, d * 0.9)
  return { x: end.x + ((toward.x - end.x) / d) * kk, y: end.y + ((toward.y - end.y) / d) * kk }
}

export interface LinePaths {
  /** Visible stroke, shortened under arrowheads so round caps never poke past the tip. */
  stroke: string
  /** Full-length path for hit testing and the selection halo. */
  full: string
  /** Arrowhead triangles (possibly empty). */
  arrows: string
  /** Point on the curve at t = 0.5 (label and bend handle). */
  mid: Point
  /** Too short to draw meaningfully. */
  degenerate: boolean
}

export function linePaths(
  r: ResolvedLine,
  opts: { thickness: number; arrowStart: boolean; arrowEnd: boolean; straight: boolean },
): LinePaths {
  const { a, b, c } = r
  const degenerate = distance(a, b) < 1
  const size = arrowSize(opts.thickness)
  const trim = size.length * 0.7
  // For straight lines the control point is the chord midpoint, so trimming towards it keeps them straight.
  const a2 = opts.arrowStart ? trimToward(a, c, trim) : a
  const b2 = opts.arrowEnd ? trimToward(b, c, trim) : b
  let arrows = ''
  if (!degenerate) {
    if (opts.arrowEnd) arrows += arrowHeadPath(b, endDirection(a, c, b), size)
    if (opts.arrowStart) arrows += arrowHeadPath(a, endDirection(b, c, a), size)
  }
  return {
    stroke: curvePath(a2, c, b2, opts.straight),
    full: curvePath(a, c, b, opts.straight),
    arrows,
    mid: quadPoint(a, c, b, 0.5),
    degenerate,
  }
}

// ---------------------------------------------------------------------------
// Style sanitising (line fields can come from untrusted peers)

export interface LineStyle {
  /** CSS color expression for stroke and arrowheads. */
  color: string
  thickness: number
  dashed: boolean
  arrowStart: boolean
  arrowEnd: boolean
  label: string
}

const COLOR_SET: ReadonlySet<string> = new Set(CARD_COLORS)

export function lineColor(color: unknown): string {
  if (typeof color !== 'string' || !COLOR_SET.has(color)) return 'var(--text-2)'
  // The "dark" swatch would vanish on the dark canvas; the text color is dark in light mode and vice versa.
  if ((color as CardColor) === 'dark') return 'var(--text)'
  return `var(--c-${color})`
}

export function clampThickness(t: unknown): number {
  const v = finite(t, 2)
  return Math.max(MIN_THICKNESS, Math.min(MAX_THICKNESS, v))
}

export function cleanLabel(label: unknown): string {
  if (typeof label !== 'string') return ''
  return label.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_LABEL_LENGTH)
}

export function lineStyle(card: {
  color?: unknown
  thickness?: unknown
  dashed?: unknown
  arrowStart?: unknown
  arrowEnd?: unknown
  label?: unknown
}): LineStyle {
  return {
    color: lineColor(card.color),
    thickness: clampThickness(card.thickness),
    dashed: card.dashed === true,
    arrowStart: card.arrowStart === true,
    arrowEnd: card.arrowEnd !== false,
    label: cleanLabel(card.label),
  }
}

/** Dash pattern for a given thickness; round caps lengthen dashes by one thickness. */
export function dashArray(thickness: number): string {
  return `${fmt(thickness * 3)} ${fmt(thickness * 3)}`
}

/** True when the point lies inside (or on the edge of) the rect. */
export const pointInside = (p: Point, r: Rect) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h
