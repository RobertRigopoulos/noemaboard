/**
 * Non-destructive image edits: crop, rotation and flips, stored as one optional `transform` field on
 * image cards. The blob is never rewritten, so the original is always recoverable.
 *
 * Display = flip(rotate(original)): the picture is rotated clockwise by `rotation` first, then mirrored
 * in screen axes. `crop` selects a region of that displayed picture, in fractions (0..1) of its size.
 * Pure: no DOM, no React.
 */
import type { CSSProperties } from 'react'

export type Rotation = 0 | 90 | 180 | 270

export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

export interface ImageTransform {
  crop: Crop | null
  rotation: Rotation
  flipH: boolean
  flipV: boolean
}

export const IDENTITY: ImageTransform = { crop: null, rotation: 0, flipH: false, flipV: false }
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 }

/** A crop at least this large in both directions is the whole image. */
const FULL_THRESHOLD = 0.999
const MIN_FRACTION = 0.02
const MIN_PIXELS = 8
export const MIN_RATIO = 1 / 40
export const MAX_RATIO = 40
/** Aspect assumed for images whose size is unknown (cards from older clients, before load). */
const FALLBACK_ASPECT = 4 / 3

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const known = (iw: number, ih: number) => finite(iw) && finite(ih) && iw > 0 && ih > 0

export function isRotation(v: unknown): v is Rotation {
  return v === 0 || v === 90 || v === 180 || v === 270
}

/** Pixel size of the image after rotation (W' x H'). */
export function orientedSize(iw: number, ih: number, rot: Rotation): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: ih, h: iw } : { w: iw, h: ih }
}

/** W'/H', falling back to 4:3 (rotated) when the size is unknown. */
function orientedRatio(iw: number, ih: number, rot: Rotation): number {
  const base = known(iw, ih) ? iw / ih : FALLBACK_ASPECT
  return rot === 90 || rot === 270 ? 1 / base : base
}

/** Smallest crop, in fractions: 2% of the image and never under 8 pixels. */
export function minCropSize(iw: number, ih: number, rot: Rotation): { w: number; h: number } {
  if (!known(iw, ih)) return { w: MIN_FRACTION, h: MIN_FRACTION }
  const o = orientedSize(iw, ih, rot)
  return { w: Math.min(1, Math.max(MIN_FRACTION, MIN_PIXELS / o.w)), h: Math.min(1, Math.max(MIN_FRACTION, MIN_PIXELS / o.h)) }
}

/** True when a crop covers (practically) the whole image. */
export function isFullCrop(c: Crop): boolean {
  return c.w >= FULL_THRESHOLD && c.h >= FULL_THRESHOLD
}

/**
 * Clamps a crop into the image: sizes between the minimum and 1, then each box shifted inside
 * (shift first, then shrink). Returns null for a crop of the whole image.
 */
export function clampCrop(c: Crop, iw: number, ih: number, rot: Rotation): Crop | null {
  const min = minCropSize(iw, ih, rot)
  const w = clamp(c.w, min.w, 1)
  const h = clamp(c.h, min.h, 1)
  const x = clamp(c.x, 0, 1 - w)
  const y = clamp(c.y, 0, 1 - h)
  const out = roundCrop({ x, y, w, h })
  return isFullCrop(out) ? null : out
}

/** Reads a crop written by anyone (peers are untrusted): four finite numbers, else null. */
function readCrop(v: unknown): Crop | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!finite(o.x) || !finite(o.y) || !finite(o.w) || !finite(o.h)) return null
  return { x: clamp(o.x, 0, 1), y: clamp(o.y, 0, 1), w: clamp(o.w, 0, 1), h: clamp(o.h, 0, 1) }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The transform stored on a card (any value, from any peer), validated. Read from the combined
 * `transform` field, or from the separate crop / rotation / flipH / flipV fields of cards edited
 * before it existed.
 */
export function readImageTransform(card: unknown, iw: number, ih: number): ImageTransform {
  if (!isRecord(card)) return IDENTITY
  const o = isRecord(card.transform) ? card.transform : card
  const rotation: Rotation = isRotation(o.rotation) ? o.rotation : 0
  const raw = readCrop(o.crop)
  const crop = raw ? clampCrop(raw, iw, ih, rotation) : null
  const flipH = o.flipH === true
  const flipV = o.flipV === true
  if (!crop && rotation === 0 && !flipH && !flipV) return IDENTITY
  return { crop, rotation, flipH, flipV }
}

export function isIdentity(t: ImageTransform): boolean {
  return !t.crop && t.rotation === 0 && !t.flipH && !t.flipV
}

export function sameTransform(a: ImageTransform, b: ImageTransform): boolean {
  if (a.rotation !== b.rotation || a.flipH !== b.flipH || a.flipV !== b.flipV) return false
  if (!a.crop || !b.crop) return !a.crop && !b.crop
  return a.crop.x === b.crop.x && a.crop.y === b.crop.y && a.crop.w === b.crop.w && a.crop.h === b.crop.h
}

/** Width / height of what the card shows (cropped, rotated), clamped to [1/40, 40]. */
export function displayAspect(t: ImageTransform, iw: number, ih: number): number {
  const c = t.crop ?? FULL_CROP
  return clamp((c.w / c.h) * orientedRatio(iw, ih, t.rotation), MIN_RATIO, MAX_RATIO)
}

/** Pixel size of the visible (cropped, rotated) region of the original. */
export function croppedPixelSize(t: ImageTransform, iw: number, ih: number): { w: number; h: number } {
  if (!known(iw, ih)) return { w: 0, h: 0 }
  const o = orientedSize(iw, ih, t.rotation)
  const c = t.crop ?? FULL_CROP
  return { w: c.w * o.w, h: c.h * o.h }
}

const pct = (n: number) => `${Number(n.toFixed(4))}%`

/**
 * CSS for showing a transformed image in a frame of the display aspect (overflow hidden):
 * `inner` is the whole oriented picture, scaled and offset so the crop fills the frame; `img` is the
 * original, centred in it, rotated and mirrored.
 */
export function transformStyle(t: ImageTransform, iw: number, ih: number): { inner: CSSProperties; img: CSSProperties } {
  const c = t.crop ?? FULL_CROP
  const inner: CSSProperties = {
    position: 'absolute',
    width: pct(100 / c.w),
    height: pct(100 / c.h),
    left: pct((-c.x / c.w) * 100),
    top: pct((-c.y / c.h) * 100),
  }
  const quarter = t.rotation === 90 || t.rotation === 270
  const r = orientedRatio(iw, ih, t.rotation)
  const sx = t.flipH ? -1 : 1
  const sy = t.flipV ? -1 : 1
  const img: CSSProperties = {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: quarter ? pct(100 / r) : '100%',
    height: quarter ? pct(100 * r) : '100%',
    maxWidth: 'none',
    transform: `translate(-50%, -50%) scale(${sx}, ${sy}) rotate(${t.rotation}deg)`,
  }
  return { inner, img }
}

export type TurnDirection = 'cw' | 'ccw'
export type FlipAxis = 'h' | 'v'

/** Rounds crop values to 1e-6 so repeated turns and flips do not pile up floating-point noise. */
export function roundCrop(c: Crop): Crop {
  const r = (v: number) => Math.round(v * 1e6) / 1e6
  return { x: r(c.x), y: r(c.y), w: r(c.w), h: r(c.h) }
}

/** The same region after the picture turns a quarter clockwise (cw) or counter-clockwise. */
export function rotateCrop(crop: Crop | null, dir: TurnDirection): Crop | null {
  if (!crop) return null
  return roundCrop(
    dir === 'cw'
      ? { x: 1 - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w }
      : { x: crop.y, y: 1 - (crop.x + crop.w), w: crop.h, h: crop.w },
  )
}

/** The same region after the picture is mirrored. */
export function flipCrop(crop: Crop | null, axis: FlipAxis): Crop | null {
  if (!crop) return null
  return roundCrop(axis === 'h' ? { ...crop, x: 1 - (crop.x + crop.w) } : { ...crop, y: 1 - (crop.y + crop.h) })
}

/**
 * Turns the displayed picture a quarter. A mirrored picture turned clockwise equals the turned
 * picture mirrored on the other axis, so the flips swap.
 */
export function rotateTransform(t: ImageTransform, dir: TurnDirection): ImageTransform {
  const rotation = ((t.rotation + (dir === 'cw' ? 90 : 270)) % 360) as Rotation
  return { crop: rotateCrop(t.crop, dir), rotation, flipH: t.flipV, flipV: t.flipH }
}

/** Mirrors the displayed picture; the crop follows the region it selected. */
export function flipTransform(t: ImageTransform, axis: FlipAxis): ImageTransform {
  return {
    crop: flipCrop(t.crop, axis),
    rotation: t.rotation,
    flipH: axis === 'h' ? !t.flipH : t.flipH,
    flipV: axis === 'v' ? !t.flipV : t.flipV,
  }
}

/** The value of the card's `transform` field. */
export interface StoredTransform {
  crop: Crop | null
  rotation: Rotation
  flipH: boolean
  flipV: boolean
}

/**
 * Card fields to write for a transform: the whole of it as one value, so that two people editing at
 * once never end up with one person's crop paired with the other's rotation (the crop is measured in
 * the rotated picture). The identity removes the field. The separate fields of older cards are removed.
 */
export function transformFields(t: ImageTransform): {
  transform: StoredTransform | undefined
  crop: undefined
  rotation: undefined
  flipH: undefined
  flipV: undefined
} {
  const transform = isIdentity(t)
    ? undefined
    : { crop: t.crop ? { x: t.crop.x, y: t.crop.y, w: t.crop.w, h: t.crop.h } : null, rotation: t.rotation, flipH: t.flipH, flipV: t.flipV }
  return { transform, crop: undefined, rotation: undefined, flipH: undefined, flipV: undefined }
}

export interface TransformMatrix {
  /** Output canvas size in pixels. */
  width: number
  height: number
  /** ctx.setTransform(a, b, c, d, e, f), then ctx.drawImage(source, 0, 0, iw, ih). */
  matrix: [number, number, number, number, number, number]
}

/**
 * Canvas operations that render the transformed image: output size (the cropped, rotated region,
 * scaled down so its long edge is at most `maxEdge`) and the affine matrix that maps original pixels
 * into it.
 */
export function transformMatrix(t: ImageTransform, iw: number, ih: number, maxEdge = Infinity): TransformMatrix {
  const o = orientedSize(iw, ih, t.rotation)
  const c = t.crop ?? FULL_CROP
  const cw = c.w * o.w
  const ch = c.h * o.h
  const s = Math.min(1, maxEdge / Math.max(cw, ch, 1e-9))
  // Original pixel (px, py) -> oriented (a px + c py + e, b px + d py + f).
  const turns: Record<Rotation, TransformMatrix['matrix']> = {
    0: [1, 0, 0, 1, 0, 0],
    90: [0, 1, -1, 0, ih, 0],
    180: [-1, 0, 0, -1, iw, ih],
    270: [0, -1, 1, 0, 0, iw],
  }
  let [a, b, cc, d, e, f] = turns[t.rotation]
  if (t.flipH) {
    a = -a
    cc = -cc
    e = o.w - e
  }
  if (t.flipV) {
    b = -b
    d = -d
    f = o.h - f
  }
  e -= c.x * o.w
  f -= c.y * o.h
  return {
    width: Math.max(1, Math.round(cw * s)),
    height: Math.max(1, Math.round(ch * s)),
    matrix: [a * s, b * s, cc * s, d * s, e * s, f * s],
  }
}

/** Applies a matrix to a point (for tests and hit-testing). */
export function applyMatrix(m: TransformMatrix['matrix'], px: number, py: number): { x: number; y: number } {
  return { x: m[0] * px + m[2] * py + m[4], y: m[1] * px + m[3] * py + m[5] }
}
