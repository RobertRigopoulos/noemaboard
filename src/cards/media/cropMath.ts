/**
 * Geometry of the crop box in the cropper: dragging handles (optionally keeping an aspect ratio),
 * moving the box, and fitting a preset ratio. All values are fractions of the displayed (rotated)
 * picture; `ratio` is width / height in those fractions. Pure.
 */
import type { Crop } from './transform'

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
export type Handle = (typeof HANDLES)[number]

export const HANDLE_LABELS: Record<Handle, string> = {
  nw: 'Top-left handle',
  n: 'Top handle',
  ne: 'Top-right handle',
  e: 'Right handle',
  se: 'Bottom-right handle',
  s: 'Bottom handle',
  sw: 'Bottom-left handle',
  w: 'Left handle',
}

export interface CropLimits {
  /** Locked width / height in fractions, or null for a free box. */
  ratio: number | null
  minW: number
  minH: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** The box moved by (du, dv), kept inside the picture. */
export function moveCrop(start: Crop, du: number, dv: number): Crop {
  return { ...start, x: clamp(start.x + du, 0, 1 - start.w), y: clamp(start.y + dv, 0, 1 - start.h) }
}

/** The box after dragging `handle` by (du, dv). */
export function resizeCrop(start: Crop, handle: Handle, du: number, dv: number, limits: CropLimits): Crop {
  const { ratio, minW, minH } = limits
  const west = handle.includes('w')
  const east = handle.includes('e')
  const north = handle.includes('n')
  const south = handle.includes('s')
  const right = start.x + start.w
  const bottom = start.y + start.h

  if (!ratio) {
    let x1 = start.x
    let x2 = right
    let y1 = start.y
    let y2 = bottom
    if (west) x1 = clamp(start.x + du, 0, right - minW)
    if (east) x2 = clamp(right + du, start.x + minW, 1)
    if (north) y1 = clamp(start.y + dv, 0, bottom - minH)
    if (south) y2 = clamp(bottom + dv, start.y + minH, 1)
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
  }

  // Smallest width that satisfies both minimums at this ratio.
  const minWidth = Math.max(minW, minH * ratio)

  if ((west || east) && (north || south)) {
    // Corner: the opposite corner stays put; the axis dragged further decides the size, so the box
    // can grow or shrink with a mostly horizontal or mostly vertical drag.
    const ax = west ? right : start.x
    const ay = north ? bottom : start.y
    const wantW = west ? ax - (start.x + du) : start.x + start.w + du - ax
    const wantH = north ? ay - (start.y + dv) : start.y + start.h + dv - ay
    const fromH = wantH * ratio
    let w = Math.abs(wantW - start.w) >= Math.abs(fromH - start.w) ? wantW : fromH
    const maxW = Math.min(west ? ax : 1 - ax, (north ? ay : 1 - ay) * ratio)
    w = Math.min(Math.max(w, minWidth), maxW)
    const h = w / ratio
    return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h }
  }

  if (west || east) {
    // Side: the opposite side stays put and the height follows, centred on the old centre.
    const cy = start.y + start.h / 2
    const ax = west ? right : start.x
    const wantW = west ? ax - (start.x + du) : right + du - ax
    const maxW = Math.min(west ? ax : 1 - ax, 2 * Math.min(cy, 1 - cy) * ratio)
    const w = Math.min(Math.max(wantW, minWidth), maxW)
    const h = w / ratio
    return { x: west ? ax - w : ax, y: cy - h / 2, w, h }
  }

  const cx = start.x + start.w / 2
  const ay = north ? bottom : start.y
  const wantH = north ? ay - (start.y + dv) : bottom + dv - ay
  const maxH = Math.min(north ? ay : 1 - ay, (2 * Math.min(cx, 1 - cx)) / ratio)
  const h = Math.min(Math.max(wantH, minWidth / ratio), maxH)
  const w = h * ratio
  return { x: cx - w / 2, y: north ? ay - h : ay, w, h }
}

/** The largest box of `ratio` (width / height in fractions) centred in `box`. */
export function fitAspect(box: Crop, ratio: number): Crop {
  let w = box.w
  let h = w / ratio
  if (h > box.h) {
    h = box.h
    w = h * ratio
  }
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h }
}

/** Fraction ratio for a pixel aspect (width / height) on a picture whose displayed size is W' x H'. */
export function fractionRatio(pixelAspect: number, ow: number, oh: number): number {
  return ow > 0 && oh > 0 ? (pixelAspect * oh) / ow : pixelAspect
}

/** Arrow-key movement for a handle: only the axes that handle can move. */
export function nudgeFor(handle: Handle | 'box', key: string, step: number): { du: number; dv: number } | null {
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  if (!dx && !dy) return null
  if (handle === 'box') return { du: dx, dv: dy }
  const horizontal = handle.includes('w') || handle.includes('e')
  const vertical = handle.includes('n') || handle.includes('s')
  const du = horizontal ? dx : 0
  const dv = vertical ? dy : 0
  return du || dv ? { du, dv } : null
}
