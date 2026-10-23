/**
 * Card rects for line ends, using the same sources the canvas renders from: stored index geometry
 * (plus measured heights) for free cards, so lines work even when a card is culled, and the DOM
 * only for cards stacked inside columns. Live drag/resize previews are applied on top.
 */
import type { BoardContextValue } from '../BoardContext'
import type { CardIndex, IndexedCard } from '../cardIndex'
import { getCardElement, measuredSize } from '../geometry'
import type { LineCard } from '../../model/types'
import { quadBounds, resolveLine, pointInside, type Point, type Rect, type ResolvedLine } from './geometry'

/** Drag/resize preview of one card (local or from a peer). */
export interface CardOffset {
  dx: number
  dy: number
  w?: number
  h?: number
}

export type OffsetMap = ReadonlyMap<string, CardOffset>

const EMPTY_OFFSETS: OffsetMap = new Map()
const UNMEASURED_HEIGHT = 100

type IndexLike = Pick<CardIndex, 'get'>

export interface RectResolver {
  (id: string): Rect | null
  /** Card ids whose rect came from the DOM (cards inside columns); they can lag one commit behind. */
  readonly domIds: ReadonlySet<string>
}

/** Translation currently applied to a card element by CardShell (its drag preview). */
function appliedTranslate(el: HTMLElement): Point {
  const m = /translate\(\s*(-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\s*\)/.exec(el.style.transform)
  if (!m) return { x: 0, y: 0 }
  const x = Number(m[1])
  const y = Number(m[2])
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

/**
 * Creates a memoising rect lookup for one render pass. `offsets` are drag previews by card id.
 */
export function createRectResolver(index: IndexLike, offsets: OffsetMap = EMPTY_OFFSETS): RectResolver {
  const cache = new Map<string, Rect | null>()
  const domIds = new Set<string>()

  const freeRect = (c: IndexedCard): Rect => {
    const o = offsets.get(c.id)
    return {
      x: c.x + (o?.dx ?? 0),
      y: c.y + (o?.dy ?? 0),
      w: o?.w ?? c.w,
      h: o?.h ?? c.h ?? measuredSize(c.id)?.h ?? UNMEASURED_HEIGHT,
    }
  }

  const columnChildRect = (c: IndexedCard, depth: number): Rect | null => {
    const column = resolve(c.parent!, depth + 1)
    if (!column) return null
    const el = getCardElement(c.id)
    const colEl = getCardElement(c.parent!)
    // Collapsed or culled column: the line meets the column itself.
    if (!el || !colEl || !el.isConnected || !colEl.isConnected) return column
    const er = el.getBoundingClientRect()
    const cr = colEl.getBoundingClientRect()
    // Scale from the DOM itself so a zoom change that has not been painted yet cannot skew the offset.
    const scale = colEl.offsetWidth > 0 ? cr.width / colEl.offsetWidth : 1
    if (!(scale > 0)) return column
    domIds.add(c.id)
    const applied = appliedTranslate(el)
    const o = offsets.get(c.id)
    return {
      x: column.x + (er.left - cr.left) / scale - applied.x + (o?.dx ?? 0),
      y: column.y + (er.top - cr.top) / scale - applied.y + (o?.dy ?? 0),
      w: er.width / scale,
      h: o?.h ?? er.height / scale,
    }
  }

  const resolve = (id: string, depth = 0): Rect | null => {
    if (cache.has(id)) return cache.get(id)!
    let r: Rect | null = null
    const c = index.get(id)
    // Depth guard: malformed peer data could make parents form a cycle.
    if (c && c.type !== 'line' && depth < 4) r = c.parent ? columnChildRect(c, depth) : freeRect(c)
    cache.set(id, r)
    return r
  }

  const fn = ((id: string) => resolve(id)) as RectResolver
  Object.defineProperty(fn, 'domIds', { get: () => domIds })
  return fn
}

/** Committed geometry of a line (no drag previews): start, end and control point. */
export function resolveLineGeometry(board: Pick<BoardContextValue, 'index'>, line: LineCard): ResolvedLine {
  return resolveLine(line, createRectResolver(board.index))
}

/** Resolved start and end points of a line, e.g. for marquee selection. */
export function lineEndpoints(board: Pick<BoardContextValue, 'index'>, line: LineCard): { a: Point; b: Point } {
  const { a, b } = resolveLineGeometry(board, line)
  return { a, b }
}

/** True when both resolved ends of the line lie inside `rect` (board coordinates). */
export function lineInRect(board: Pick<BoardContextValue, 'index'>, line: LineCard, rect: Rect): boolean {
  const { a, b } = lineEndpoints(board, line)
  return pointInside(a, rect) && pointInside(b, rect)
}

/** Bounding box of the drawn curve (e.g. to place a toolbar above a selected line). */
export function lineBounds(board: Pick<BoardContextValue, 'index'>, line: LineCard): Rect {
  const { a, b, c } = resolveLineGeometry(board, line)
  return quadBounds(a, c, b)
}
