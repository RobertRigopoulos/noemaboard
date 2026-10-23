/**
 * Pure geometry for sketch cards: pointer -> drawing-space conversion, point rounding,
 * validation of (untrusted) strokes, perfect-freehand outlines -> SVG paths, eraser hit-testing.
 * No DOM / React so it can be unit-tested in Node.
 */
import { getStroke } from 'perfect-freehand'
import type { SketchStroke } from '../../model/types'
import { isHex6 } from './color'

/** Hard cap on points per stroke; longer strokes are split so docs stay small. */
export const MAX_STROKE_POINTS = 5000
/** Default pressure for mouse / touch input (and missing pen pressure). */
export const DEFAULT_PRESSURE = 0.5
/** Theme-adaptive ink: strokes stored with this color render with var(--text). */
export const INK = '#1f2328'
export const PEN_COLORS: readonly { color: string; label: string }[] = [
  { color: INK, label: 'Ink' },
  { color: '#ffffff', label: 'White' },
  { color: '#e5484d', label: 'Red' },
  { color: '#f76b15', label: 'Orange' },
  { color: '#f2c23b', label: 'Yellow' },
  { color: '#30a46c', label: 'Green' },
  { color: '#0090ff', label: 'Blue' },
  { color: '#6e56cf', label: 'Purple' },
]
/** Pen sizes in board units (the stroke keeps its size relative to the board, not the screen). */
export const PEN_SIZES: readonly { size: number; label: string }[] = [
  { size: 2, label: 'Fine' },
  { size: 4, label: 'Medium' },
  { size: 8, label: 'Bold' },
]
/** Next pen size preset above (dir 1) or below (dir -1) the current size, clamped to the ends. */
export function stepPenSize(current: number, dir: 1 | -1): number {
  const sizes = PEN_SIZES.map((s) => s.size)
  if (dir > 0) return sizes.find((s) => s > current) ?? sizes[sizes.length - 1]
  for (let i = sizes.length - 1; i >= 0; i--) if (sizes[i] < current) return sizes[i]
  return sizes[0]
}

export const MIN_STROKE_SIZE = 0.2
export const MAX_STROKE_SIZE = 400
const MAX_ID = 64

export const STROKE_OPTIONS = { thinning: 0.5, smoothing: 0.5, streamline: 0.5 } as const

export interface ClientRectLike {
  left: number
  top: number
  width: number
  height: number
}

export interface Bounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** A validated stroke plus its cached render data. */
export interface ParsedStroke extends SketchStroke {
  /** SVG path data of the filled outline. */
  d: string
  bounds: Bounds
}

export const round1 = (v: number) => Math.round(v * 10) / 10
export const round2 = (v: number) => Math.round(v * 100) / 100

/** Drawing coordinate space dimension: positive and finite, otherwise the fallback. */
export function validDim(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.min(v, 100_000)
  return Math.max(1, Number.isFinite(fallback) && fallback > 0 ? fallback : 300)
}

/**
 * Converts a client (screen) position into drawing units using the svg's on-screen rect.
 * Because the rect already includes the canvas zoom and card size, this works at any zoom.
 */
export function clientToSketch(clientX: number, clientY: number, rect: ClientRectLike, vw: number, vh: number): { x: number; y: number } {
  const w = rect.width || 1
  const h = rect.height || 1
  return { x: ((clientX - rect.left) / w) * vw, y: ((clientY - rect.top) / h) * vh }
}

/** Normalizes pointer pressure: pens report 0..1 (0 when unsupported), everything else gets the default. */
export function pointerPressure(pointerType: string, pressure: number): number {
  if (pointerType !== 'pen') return DEFAULT_PRESSURE
  if (!Number.isFinite(pressure) || pressure <= 0) return DEFAULT_PRESSURE
  return Math.min(1, pressure)
}

/** Keeps points within a generous margin around the drawing so a stray pointer cannot store huge values. */
export function clampToMargin(x: number, y: number, vw: number, vh: number): { x: number; y: number } {
  return { x: Math.min(vw * 2, Math.max(-vw, x)), y: Math.min(vh * 2, Math.max(-vh, y)) }
}

/**
 * Rounds raw [x, y, pressure, ...] triples (coordinates to 1 decimal, pressure to 2), drops
 * consecutive duplicates and caps the length. Returns null when fewer than 2 points remain,
 * unless `dot` is set: then a single point (a tap) becomes a tiny 2-point stroke that renders as a dot.
 */
export function finalizePoints(raw: readonly number[], opts: { max?: number; dot?: boolean } = {}): number[] | null {
  const max = Math.max(2, opts.max ?? MAX_STROKE_POINTS)
  const out: number[] = []
  for (let i = 0; i + 2 < raw.length; i += 3) {
    const x = raw[i]
    const y = raw[i + 1]
    const p = raw[i + 2]
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const rx = round1(x)
    const ry = round1(y)
    const rp = Number.isFinite(p) ? round2(Math.min(1, Math.max(0, p))) : DEFAULT_PRESSURE
    const n = out.length
    if (n && out[n - 3] === rx && out[n - 2] === ry) continue
    out.push(rx, ry, rp)
    if (out.length / 3 >= max) break
  }
  if (out.length === 3 && opts.dot) out.push(round1(out[0] + 0.2), out[1], out[2])
  return out.length >= 6 ? out : null
}

/** Mouse/touch strokes have constant pressure; for those perfect-freehand simulates it from speed. */
export function isConstantPressure(points: readonly number[]): boolean {
  if (points.length < 6) return true
  const first = points[2]
  for (let i = 5; i < points.length; i += 3) if (points[i] !== first) return false
  return true
}

export function toTriples(points: readonly number[]): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let i = 0; i + 2 < points.length; i += 3) out.push([points[i], points[i + 1], points[i + 2]])
  return out
}

const avg = (a: number, b: number) => (a + b) / 2
const fmt = (v: number) => (Math.round(v * 100) / 100).toString()

/**
 * Turns a perfect-freehand outline polygon into SVG path data, smoothing it with quadratic
 * curves through the midpoints of consecutive outline points.
 */
export function getSvgPathFromStroke(outline: readonly (readonly number[])[], closed = true): string {
  const len = outline.length
  if (len < 4) {
    if (!len) return ''
    // Too few points to smooth: draw the polygon as-is.
    return `M${outline.map((p) => `${fmt(p[0])},${fmt(p[1])}`).join(' L')}${closed ? ' Z' : ''}`
  }
  let a = outline[0]
  let b = outline[1]
  const c = outline[2]
  let d = `M${fmt(a[0])},${fmt(a[1])} Q${fmt(b[0])},${fmt(b[1])} ${fmt(avg(b[0], c[0]))},${fmt(avg(b[1], c[1]))} T`
  for (let i = 2; i < len - 1; i++) {
    a = outline[i]
    b = outline[i + 1]
    d += `${fmt(avg(a[0], b[0]))},${fmt(avg(a[1], b[1]))} `
  }
  if (closed) d += 'Z'
  return d
}

/** Filled-outline path data for a stroke (flattened points). `last` = the stroke is complete. */
export function strokePathData(points: readonly number[], size: number, last = true): string {
  if (points.length < 3) return ''
  const outline = getStroke(toTriples(points), {
    size,
    ...STROKE_OPTIONS,
    simulatePressure: isConstantPressure(points),
    last,
  })
  return getSvgPathFromStroke(outline)
}

export function strokeBounds(points: readonly number[]): Bounds {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i]
    const y = points[i + 1]
    if (x < x1) x1 = x
    if (x > x2) x2 = x
    if (y < y1) y1 = y
    if (y > y2) y2 = y
  }
  return Number.isFinite(x1) ? { x1, y1, x2, y2 } : { x1: 0, y1: 0, x2: 0, y2: 0 }
}

/**
 * Validates one Y.Array item from a (possibly malicious or buggy) peer. Returns a clean copy
 * or null. Colors must be plain hex so they can never reference external resources via url().
 */
export function parseStroke(raw: unknown): SketchStroke | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id || o.id.length > MAX_ID) return null
  if (!Array.isArray(o.points)) return null
  const src = o.points as unknown[]
  const n = Math.min(Math.floor(src.length / 3), MAX_STROKE_POINTS) * 3
  if (n < 6) return null
  const points: number[] = []
  for (let i = 0; i < n; i++) {
    const v = src[i]
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    points.push(v)
  }
  const color = typeof o.color === 'string' ? o.color.toLowerCase() : ''
  const size = typeof o.size === 'number' && Number.isFinite(o.size) ? o.size : 4
  return {
    id: o.id,
    points,
    color: isHex6(color) ? color : INK,
    size: Math.min(MAX_STROKE_SIZE, Math.max(MIN_STROKE_SIZE, size)),
  }
}

// Strokes are immutable once pushed, and Y.Array returns the same object for an item every
// time, so outlines are computed once per item for the lifetime of the doc.
const cache = new WeakMap<object, ParsedStroke | null>()

/** Validated + rendered strokes for the items of a sketch's Y.Array, in drawing order. */
export function readStrokes(items: readonly unknown[]): ParsedStroke[] {
  const out: ParsedStroke[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    let parsed = cache.get(item)
    if (parsed === undefined) {
      const s = parseStroke(item)
      parsed = s ? { ...s, d: strokePathData(s.points, s.size, true), bounds: strokeBounds(s.points) } : null
      cache.set(item, parsed)
    }
    if (parsed) out.push(parsed)
  }
  return out
}

// ---------------------------------------------------------------------------
// Eraser hit-testing

/** Squared distance from point P to segment AB. */
export function distToSegmentSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = ax + t * dx - px
  const cy = ay + t * dy - py
  return cx * cx + cy * cy
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

/** Squared distance between segments AB and CD (0 when they cross). */
export function segmentDistanceSq(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  const d1 = cross(cx, cy, dx, dy, ax, ay)
  const d2 = cross(cx, cy, dx, dy, bx, by)
  const d3 = cross(ax, ay, bx, by, cx, cy)
  const d4 = cross(ax, ay, bx, by, dx, dy)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  return Math.min(
    distToSegmentSq(ax, ay, cx, cy, dx, dy),
    distToSegmentSq(bx, by, cx, cy, dx, dy),
    distToSegmentSq(cx, cy, ax, ay, bx, by),
    distToSegmentSq(dx, dy, ax, ay, bx, by),
  )
}

export interface HitOptions {
  /** Extra distance (in board units) beyond the stroke's own radius that still counts as a hit. */
  tolerance: number
  /** Board units per drawing unit on each axis (the drawing may be stretched when resized). */
  kx?: number
  ky?: number
}

/**
 * Does the eraser path from A to B (drawing units) touch the stroke? Distances are measured in
 * board units so the tolerance feels the same however the card is stretched.
 */
export function strokeHit(stroke: Pick<ParsedStroke, 'points' | 'size'> & { bounds?: Bounds }, ax: number, ay: number, bx: number, by: number, opts: HitOptions): boolean {
  const kx = opts.kx ?? 1
  const ky = opts.ky ?? 1
  const reach = opts.tolerance + (stroke.size / 2) * ((kx + ky) / 2)
  const reach2 = reach * reach
  const b = stroke.bounds ?? strokeBounds(stroke.points)
  // Cheap reject using the stroke's bounding box.
  if (
    Math.max(ax, bx) * kx < b.x1 * kx - reach ||
    Math.min(ax, bx) * kx > b.x2 * kx + reach ||
    Math.max(ay, by) * ky < b.y1 * ky - reach ||
    Math.min(ay, by) * ky > b.y2 * ky + reach
  )
    return false
  const pts = stroke.points
  const sax = ax * kx
  const say = ay * ky
  const sbx = bx * kx
  const sby = by * ky
  if (pts.length < 6) {
    return pts.length >= 3 && distToSegmentSq(pts[0] * kx, pts[1] * ky, sax, say, sbx, sby) <= reach2
  }
  for (let i = 0; i + 5 < pts.length; i += 3) {
    const d = segmentDistanceSq(sax, say, sbx, sby, pts[i] * kx, pts[i + 1] * ky, pts[i + 3] * kx, pts[i + 4] * ky)
    if (d <= reach2) return true
  }
  return false
}

/** Ids of the strokes touched by the eraser moving from A to B. */
export function strokesHit(
  strokes: readonly (Pick<ParsedStroke, 'id' | 'points' | 'size'> & { bounds?: Bounds })[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  opts: HitOptions,
): string[] {
  const out: string[] = []
  for (const s of strokes) if (strokeHit(s, ax, ay, bx, by, opts)) out.push(s.id)
  return out
}
