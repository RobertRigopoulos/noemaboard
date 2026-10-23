/**
 * Grouping operations used by the context menu: cards -> column, column -> cards, and the
 * ordering/layout rules behind them. Pure model code (no DOM), so it is unit-tested in Node.
 */
import type * as Y from 'yjs'
import {
  columnChildren,
  createCard,
  forEachActiveCard,
  getCards,
  insertIntoColumn,
  isTrashed,
  LOCAL_ORIGIN,
  readCard,
  removeCards,
  updateCards,
} from '../../model/board'
import { COLUMN_CHILD_TYPES, GRID, type Card, type CardType } from '../../model/types'
import type { Rect } from '../../board/geometry'

const snapToGrid = (v: number) => Math.round(v / GRID) * GRID

/** `movedTo` marker on a column removed by "Ungroup" (soft-removed, never listed in the trash). */
export const UNGROUPED_MARKER = 'ungrouped'
/** Gap between cards when a column is unstacked onto the canvas. */
export const UNGROUP_GAP = 20
/** Fallback height for cards that have not been measured (culled or never rendered). */
const FALLBACK_HEIGHT = 100

interface Positioned {
  id: string
  x: number
  y: number
}

/** Visual reading order: top to bottom, then left to right for cards on the same row. */
export function visualOrder<T extends Positioned>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** True if a card may be gathered into a new column (free, and a type columns accept). */
export function isGroupable(c: { type: CardType; parent: string | null }): boolean {
  return !c.parent && c.type !== 'column' && c.type !== 'line' && COLUMN_CHILD_TYPES.has(c.type)
}

/** The groupable cards among `ids`, in the order they will appear in the column. */
export function groupableCards(doc: Y.Doc, ids: Iterable<string>): Card[] {
  const cards = getCards(doc)
  const out: Card[] = []
  for (const id of ids) {
    const m = cards.get(id)
    if (!m || isTrashed(m)) continue
    const c = readCard(m)
    if (isGroupable(c)) out.push(c)
  }
  return visualOrder(out)
}

/**
 * Creates a column at the top-left of the cards' bounds and stacks them into it in visual
 * order. One undo step. Returns the column id, or null if nothing could be grouped.
 */
export function groupIntoColumn(doc: Y.Doc, ids: Iterable<string>, userId: string): string | null {
  const items = groupableCards(doc, ids)
  if (!items.length) return null
  const x = Math.min(...items.map((c) => c.x))
  const y = Math.min(...items.map((c) => c.y))
  let columnId: string | null = null
  doc.transact(() => {
    columnId = createCard(doc, 'column', { x: snapToGrid(x), y: snapToGrid(y) }, userId)
    insertIntoColumn(
      doc,
      items.map((c) => c.id),
      columnId,
      0,
      userId,
    )
  }, LOCAL_ORIGIN)
  return columnId
}

/** Positions for cards stacked vertically from `origin`, each `gap` below the previous one. */
export function stackLayout(origin: { x: number; y: number }, items: readonly { id: string; h: number }[], gap = UNGROUP_GAP) {
  const out: Record<string, { x: number; y: number }> = {}
  let y = origin.y
  for (const it of items) {
    out[it.id] = { x: snapToGrid(origin.x), y: snapToGrid(y) }
    y += Math.max(1, Number.isFinite(it.h) ? it.h : FALLBACK_HEIGHT) + gap
  }
  return out
}

/**
 * Takes every card out of a column onto the canvas and removes the (then empty) column.
 * `measure` returns a card's current on-screen board rect when it is rendered: if all children
 * are rendered they stay exactly where they appear, otherwise they are stacked from the column's
 * top-left. Lines attached to the column keep their last position as free ends.
 * Returns the ids of the cards that were in the column.
 */
export function ungroupColumn(
  doc: Y.Doc,
  columnId: string,
  userId: string,
  measure: (id: string) => Rect | null = () => null,
): string[] {
  const cards = getCards(doc)
  const colMap = cards.get(columnId)
  if (!colMap || isTrashed(colMap)) return []
  const col = readCard(colMap)
  if (col.type !== 'column') return []
  const children = columnChildren(doc, columnId)
  const rects = children.map((id) => measure(id))
  let positions: Record<string, { x: number; y: number }>
  if (children.length && rects.every((r): r is Rect => !!r)) {
    positions = {}
    children.forEach((id, i) => {
      const r = rects[i]!
      positions[id] = { x: snapToGrid(r.x), y: snapToGrid(r.y) }
    })
  } else {
    positions = stackLayout(
      { x: col.x, y: col.y },
      children.map((id, i) => {
        const m = cards.get(id)
        const h = rects[i]?.h ?? (m ? readCard(m).h : undefined) ?? FALLBACK_HEIGHT
        return { id, h }
      }),
    )
  }

  const colRect = measure(columnId)
  const anchor = colRect ? { x: colRect.x + colRect.w / 2, y: colRect.y } : { x: col.x + col.w / 2, y: col.y }
  const patches: Record<string, Record<string, unknown>> = {}
  for (const [id, p] of Object.entries(positions)) patches[id] = { parent: null, x: p.x, y: p.y }
  forEachActiveCard(doc, (m, id) => {
    if (m.get('type') !== 'line') return
    const line = readCard(m)
    if (line.type !== 'line') return
    const patch: Record<string, unknown> = {}
    if (line.from.card === columnId) patch.from = { card: null, x: Math.round(anchor.x), y: Math.round(anchor.y) }
    if (line.to.card === columnId) patch.to = { card: null, x: Math.round(anchor.x), y: Math.round(anchor.y) }
    if (Object.keys(patch).length) patches[id] = patch
  })

  doc.transact(() => {
    updateCards(doc, patches, userId)
    // Hidden rather than trashed: an emptied column is not something to restore later.
    removeCards(doc, [columnId], userId, UNGROUPED_MARKER)
  }, LOCAL_ORIGIN)
  return children
}

/** Top-left of the given free cards (lines contribute their free end points). */
export function boundsTopLeft(cards: readonly Card[]): { x: number; y: number } | null {
  let x = Infinity
  let y = Infinity
  for (const c of cards) {
    if (c.parent) continue
    if (c.type === 'line') {
      for (const p of [c.from, c.to]) {
        x = Math.min(x, p.x)
        y = Math.min(y, p.y)
      }
      continue
    }
    x = Math.min(x, c.x)
    y = Math.min(y, c.y)
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}
