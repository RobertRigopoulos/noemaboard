/**
 * Pure layout maths for Align, Distribute and Tidy up on a multi-selection. Inputs are board-space
 * rects; outputs are new top-left positions for the cards that actually move.
 */
import { snap } from './prefs'

export interface ARect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vmiddle' | 'bottom'
export type ArrangeMode = AlignMode | 'distribute-h' | 'distribute-v' | 'tidy'

export type Positions = Record<string, { x: number; y: number }>

function bounds(rects: readonly ARect[]) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x1, y1, x2, y2 }
}

/** Only rects whose position changes get an entry. */
function changed(rects: readonly ARect[], next: (r: ARect) => { x: number; y: number }): Positions {
  const out: Positions = {}
  for (const r of rects) {
    const p = next(r)
    if (p.x !== r.x || p.y !== r.y) out[r.id] = p
  }
  return out
}

/** Aligns every rect to an edge or the centre line of their union. */
export function alignRects(rects: readonly ARect[], mode: AlignMode): Positions {
  if (rects.length < 2) return {}
  const b = bounds(rects)
  const cx = (b.x1 + b.x2) / 2
  const cy = (b.y1 + b.y2) / 2
  return changed(rects, (r) => {
    switch (mode) {
      case 'left':
        return { x: b.x1, y: r.y }
      case 'right':
        return { x: b.x2 - r.w, y: r.y }
      case 'hcenter':
        return { x: Math.round(cx - r.w / 2), y: r.y }
      case 'top':
        return { x: r.x, y: b.y1 }
      case 'bottom':
        return { x: r.x, y: b.y2 - r.h }
      case 'vmiddle':
        return { x: r.x, y: Math.round(cy - r.h / 2) }
    }
  })
}

/**
 * Equal gaps between consecutive rects along one axis. The first and last (by leading edge) stay
 * where they are; a gap may come out negative when the cards are wider than the span.
 */
export function distributeRects(rects: readonly ARect[], axis: 'h' | 'v'): Positions {
  if (rects.length < 3) return {}
  const pos = (r: ARect) => (axis === 'h' ? r.x : r.y)
  const size = (r: ARect) => (axis === 'h' ? r.w : r.h)
  const sorted = [...rects].sort((a, b) => pos(a) - pos(b) || (a.id < b.id ? -1 : 1))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const inner = sorted.slice(1, -1)
  const span = pos(last) - (pos(first) + size(first))
  const used = inner.reduce((sum, r) => sum + size(r), 0)
  const gap = (span - used) / (sorted.length - 1)
  const next = new Map<string, number>()
  let cursor = pos(first) + size(first)
  for (const r of inner) {
    next.set(r.id, Math.round(cursor + gap))
    cursor += gap + size(r)
  }
  return changed(rects, (r) => {
    const v = next.get(r.id)
    if (v === undefined) return { x: r.x, y: r.y }
    return axis === 'h' ? { x: v, y: r.y } : { x: r.x, y: v }
  })
}

/**
 * Groups rects into rows: a rect joins the current row when its vertical centre lies inside the
 * row's band (from the row's top to its lowest bottom so far). Rows sorted by top, cards by x.
 */
export function clusterRows<T extends { x: number; y: number; h: number }>(rects: readonly T[]): T[][] {
  const byTop = [...rects].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: { top: number; bottom: number; items: T[] }[] = []
  for (const r of byTop) {
    const centre = r.y + r.h / 2
    const row = rows[rows.length - 1]
    if (row && centre >= row.top && centre <= row.bottom) {
      row.items.push(r)
      row.bottom = Math.max(row.bottom, r.y + r.h)
    } else rows.push({ top: r.y, bottom: r.y + r.h, items: [r] })
  }
  return rows.map((row) => row.items.sort((a, b) => a.x - b.x))
}

/**
 * Lays the rects out as a tidy grid keeping their rough rows and order: column width is the widest
 * card at that column index, row height the tallest card of the row, `gap` between them. Anchored at
 * the selection's top-left; every position is snapped to the grid.
 */
export function tidyRects(rects: readonly ARect[], gap = 20, snapTo: (v: number) => number = snap): Positions {
  if (rects.length < 2) return {}
  const b = bounds(rects)
  const rows = clusterRows(rects)
  const colWidths: number[] = []
  for (const row of rows) row.forEach((r, i) => (colWidths[i] = Math.max(colWidths[i] ?? 0, r.w)))
  const next = new Map<string, { x: number; y: number }>()
  let y = b.y1
  for (const row of rows) {
    let x = b.x1
    let rowH = 0
    row.forEach((r, i) => {
      next.set(r.id, { x: snapTo(x), y: snapTo(y) })
      x += colWidths[i] + gap
      rowH = Math.max(rowH, r.h)
    })
    y += rowH + gap
  }
  return changed(rects, (r) => next.get(r.id) ?? { x: r.x, y: r.y })
}

/** Dispatches one arrange mode. */
export function arrangeRects(rects: readonly ARect[], mode: ArrangeMode): Positions {
  if (mode === 'distribute-h') return distributeRects(rects, 'h')
  if (mode === 'distribute-v') return distributeRects(rects, 'v')
  if (mode === 'tidy') return tidyRects(rects)
  return alignRects(rects, mode)
}
