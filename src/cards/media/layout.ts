/** Placement of several imported cards. Pure: no DOM. */
import { GRID } from '../../model/types'
import { displayAspect, IDENTITY, type ImageTransform } from './transform'

export interface Box {
  w: number
  h: number
}

export interface GridOptions {
  columns?: number
  gap?: number
}

const snapTo = (v: number) => Math.round(v / GRID) * GRID

/**
 * Masonry grid: each box goes into the currently shortest column (leftmost on ties), so mixed
 * image heights pack tightly while the drop order still reads left-to-right, top-to-bottom.
 * Columns are as wide as the widest box. Returns snapped top-left positions, in input order.
 */
export function gridLayout(boxes: readonly Box[], at: { x: number; y: number }, opts: GridOptions = {}): { x: number; y: number }[] {
  if (!boxes.length) return []
  const columns = Math.max(1, Math.min(opts.columns ?? 3, boxes.length))
  const gap = opts.gap ?? 20
  const colW = Math.max(...boxes.map((b) => (Number.isFinite(b.w) && b.w > 0 ? b.w : 0)))
  const heights: number[] = Array.from({ length: columns }, () => 0)
  const x0 = snapTo(at.x)
  const y0 = snapTo(at.y)
  return boxes.map((b) => {
    let col = 0
    for (let i = 1; i < columns; i++) if (heights[i] < heights[col]) col = i
    // Round the offset up so snapping never eats into the gap.
    const pos = { x: x0 + Math.ceil((col * (colW + gap)) / GRID) * GRID, y: y0 + Math.ceil(heights[col] / GRID) * GRID }
    const h = Number.isFinite(b.h) && b.h > 0 ? b.h : 100
    heights[col] += h + gap
    return pos
  })
}

/** Shifts laid-out positions so the whole group is centred on `center` (snapped). */
export function centerGroup(positions: { x: number; y: number }[], boxes: readonly Box[], center: { x: number; y: number }) {
  if (!positions.length) return positions
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  positions.forEach((p, i) => {
    const b = boxes[i]
    x1 = Math.min(x1, p.x)
    y1 = Math.min(y1, p.y)
    x2 = Math.max(x2, p.x + (b?.w > 0 ? b.w : 0))
    y2 = Math.max(y2, p.y + (b?.h > 0 ? b.h : 0))
  })
  const dx = snapTo(center.x - (x1 + x2) / 2)
  const dy = snapTo(center.y - (y1 + y2) / 2)
  return positions.map((p) => ({ x: p.x + dx, y: p.y + dy }))
}

/** Card width for an image of intrinsic width `iw`: its natural size up to 300, snapped, at least 60. */
export function imageCardWidth(iw: number, max = 300, min = 60): number {
  const w = Number.isFinite(iw) && iw > 0 ? Math.min(max, iw) : max
  return Math.max(min, snapTo(w))
}

/**
 * Rendered height of an image card (without caption) for layout before it is measured: the width
 * over the aspect of what it shows (cropped and rotated, 4:3 when the size is unknown).
 */
export function imageCardHeight(w: number, iw: number, ih: number, t: ImageTransform = IDENTITY): number {
  return Math.round(w / displayAspect(t, iw, ih))
}
