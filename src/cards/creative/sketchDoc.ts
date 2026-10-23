/**
 * Sketch stroke mutations on the shared doc. Local edits use LOCAL_ORIGIN so the board
 * UndoManager can undo them; strokes are plain objects pushed once when finished.
 */
import * as Y from 'yjs'
import { ensureArray, LOCAL_ORIGIN } from '../../model/board'
import type { CardMap, SketchStroke } from '../../model/types'

/** The card's strokes array if present and well-typed (a peer could have stored something else). */
export function getStrokesArray(map: CardMap): Y.Array<unknown> | null {
  const v = map.get('strokes')
  return v instanceof Y.Array ? (v as Y.Array<unknown>) : null
}

/** Appends one finished stroke, creating the array for old/malformed cards. */
export function pushStroke(doc: Y.Doc, map: CardMap, stroke: SketchStroke): void {
  const arr = getStrokesArray(map) ?? ensureArray<unknown>(doc, map, 'strokes')
  doc.transact(() => arr.push([stroke]), LOCAL_ORIGIN)
}

/** Removes every stroke whose id is in `ids` (one transaction). Returns how many were removed. */
export function removeStrokes(doc: Y.Doc, map: CardMap, ids: Iterable<string>): number {
  const arr = getStrokesArray(map)
  const set = new Set(ids)
  if (!arr || !set.size) return 0
  let removed = 0
  doc.transact(() => {
    const items = arr.toArray()
    // Back to front so earlier indexes stay valid while deleting.
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i] as { id?: unknown } | null
      if (it && typeof it === 'object' && typeof it.id === 'string' && set.has(it.id)) {
        arr.delete(i, 1)
        removed++
      }
    }
  }, LOCAL_ORIGIN)
  return removed
}

/** Removes all strokes. */
export function clearStrokes(doc: Y.Doc, map: CardMap): void {
  const arr = getStrokesArray(map)
  if (!arr || !arr.length) return
  doc.transact(() => arr.delete(0, arr.length), LOCAL_ORIGIN)
}
