/**
 * The Unsorted drawer: top-level cards flagged `unsorted: true` sit in a per-board drawer instead
 * of on the canvas, ordered by their `order` key. They keep real x/y next to the board's content,
 * because older versions ignore the flag and draw them there.
 *
 * Moving cards into and out of the drawer is a user edit (LOCAL_ORIGIN, undoable). Automatic
 * arrivals (a board joined from an invite landing on Home) use SYSTEM_ORIGIN.
 */
import type * as Y from 'yjs'
import {
  createTextNote,
  forEachActiveCard,
  getCardMap,
  isTrashed,
  isUnsortedMap,
  LOCAL_ORIGIN,
  maxZ,
  unsortedIds,
  unsortedTailKeys,
  updateCards,
} from './board'
import { GRID } from './types'

export { isUnsortedMap, unsortedIds }

/** Stack height of a card whose height is neither known to the caller nor stored. */
const FALLBACK_HEIGHT = 120

const snap = (v: number) => Math.round(v / GRID) * GRID

/**
 * Puts cards into the drawer, after the cards already there, in the given order. Column children
 * leave their column. Lines, trashed cards and cards already in the drawer are skipped.
 * One transaction. Returns the ids that moved.
 */
export function moveToUnsorted(doc: Y.Doc, ids: Iterable<string>, userId: string, origin: unknown = LOCAL_ORIGIN): string[] {
  const todo: string[] = []
  for (const id of new Set(ids)) {
    const m = getCardMap(doc, id)
    if (!m || isTrashed(m) || m.get('type') === 'line' || isUnsortedMap(m)) continue
    todo.push(id)
  }
  if (!todo.length) return []
  doc.transact(() => {
    const keys = unsortedTailKeys(doc, todo.length)
    const patches: Record<string, Record<string, unknown>> = {}
    todo.forEach((id, i) => (patches[id] = { unsorted: true, parent: null, order: keys[i] }))
    updateCards(doc, patches, userId, origin)
  }, origin)
  return todo
}

export interface PlaceOptions {
  /**
   * Rendered (or estimated) height of a card in board units, if known. Notes, to-dos, documents,
   * links and columns have no stored height, so without it they are stacked FALLBACK_HEIGHT apart.
   */
  heightOf?: (id: string) => number | undefined
}

/**
 * Takes drawer cards out onto the canvas, stacked top to bottom from `at` (snapped to the grid)
 * in the given order, above everything else. One undoable transaction. Returns the placed ids.
 */
export function placeFromUnsorted(
  doc: Y.Doc,
  ids: Iterable<string>,
  at: { x: number; y: number },
  userId: string,
  opts: PlaceOptions = {},
): string[] {
  const placed: string[] = []
  for (const id of new Set(ids)) {
    const m = getCardMap(doc, id)
    if (m && isUnsortedMap(m)) placed.push(id)
  }
  if (!placed.length) return []
  const x = snap(Number.isFinite(at.x) ? at.x : 0)
  let y = snap(Number.isFinite(at.y) ? at.y : 0)
  doc.transact(() => {
    let z = maxZ(doc)
    const patches: Record<string, Record<string, unknown>> = {}
    for (const id of placed) {
      const height = positive(opts.heightOf?.(id)) ?? positive(getCardMap(doc, id)?.get('h')) ?? FALLBACK_HEIGHT
      patches[id] = { unsorted: undefined, x, y, z: ++z }
      y = snap(y + height + GRID)
    }
    updateCards(doc, patches, userId)
  }, LOCAL_ORIGIN)
  return placed
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined
}

/** A free spot right of the board's top-level content (drawer cards included, so they never pile up). */
function spotRight(doc: Y.Doc): { x: number; y: number } {
  let right = -Infinity
  let top = Infinity
  forEachActiveCard(doc, (m) => {
    if (typeof m.get('parent') === 'string' || m.get('type') === 'line') return
    const x = m.get('x')
    const y = m.get('y')
    const w = m.get('w')
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
    right = Math.max(right, x + (typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 300))
    top = Math.min(top, y)
  })
  if (!Number.isFinite(right) || !Number.isFinite(top)) return { x: 80, y: 80 }
  return { x: snap(right + 40), y: snap(top) }
}

/** Creates a note with plain text at the end of the drawer. Returns its id. */
export function addUnsortedNote(doc: Y.Doc, text: string, userId: string): string {
  let id = ''
  doc.transact(() => {
    const at = spotRight(doc)
    const [order] = unsortedTailKeys(doc, 1)
    id = createTextNote(doc, text, { unsorted: true, x: at.x, y: at.y, order }, userId)
  }, LOCAL_ORIGIN)
  return id
}
