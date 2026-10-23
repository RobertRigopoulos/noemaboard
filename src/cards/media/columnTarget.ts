/**
 * Files, links or text dropped (or pasted) over a column go into that column, at the slot under
 * the pointer, like dragging an existing card there.
 */
import type * as Y from 'yjs'
import { columnChildren, getCards, insertIntoColumn } from '../../model/board'
import { boardToScreen, elementBoardRect } from '../../board/geometry'

export interface ColumnSlot {
  columnId: string
  index: number
}

/**
 * Column under a board point right now. Call synchronously during the drop/paste event.
 * With `requireHover` the pointer must actually be over that column (pastes fall back to the view
 * centre when the pointer is elsewhere, which must not drop cards into a random column).
 */
export function columnAt(doc: Y.Doc, at: { x: number; y: number }, requireHover = false): ColumnSlot | null {
  if (typeof document === 'undefined' || typeof document.elementsFromPoint !== 'function') return null
  const p = boardToScreen(at.x, at.y)
  for (const el of document.elementsFromPoint(p.x, p.y)) {
    const host = (el as HTMLElement).closest?.('[data-drop="column"]') as HTMLElement | null
    const columnId = host?.dataset.dropId
    if (!columnId) continue
    if (requireHover && !host!.matches(':hover')) return null
    const col = getCards(doc).get(columnId)
    if (!col || col.get('type') !== 'column') return null
    if (col.get('collapsed') === true) return { columnId, index: Number.MAX_SAFE_INTEGER }
    const children = columnChildren(doc, columnId)
    let index = children.length
    for (let i = 0; i < children.length; i++) {
      const r = elementBoardRect(children[i])
      if (r && at.y < r.y + r.h / 2) {
        index = i
        break
      }
    }
    return { columnId, index }
  }
  return null
}

/** Moves freshly created cards into the column slot found at event time (no-op if it is gone). */
export function placeInColumn(doc: Y.Doc, ids: string[], slot: ColumnSlot | null, userId: string) {
  if (!slot || !ids.length || doc.isDestroyed) return
  insertIntoColumn(doc, ids, slot.columnId, slot.index, userId)
}
