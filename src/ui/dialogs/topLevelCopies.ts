/** Which copied cards stand on their own in the target board (pure, used by Copy to board). */
import type * as Y from 'yjs'
import { getCardMap, isTrashed } from '../../model/board'

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * The inserted cards that stand on their own, in reading order (top to bottom, then left to right):
 * the rule a move into the Unsorted drawer uses. Column children, lines and comments pinned to
 * another inserted card are left out: they follow the card they belong to.
 */
export function topLevelCopies(doc: Y.Doc, inserted: readonly string[]): string[] {
  const set = new Set(inserted)
  const out: { id: string; x: number; y: number }[] = []
  for (const id of inserted) {
    const m = getCardMap(doc, id)
    if (!m || isTrashed(m) || m.get('parent') || m.get('type') === 'line') continue
    const pinnedTo = m.get('type') === 'comment' ? m.get('attachedTo') : null
    if (typeof pinnedTo === 'string' && set.has(pinnedTo)) continue
    out.push({ id, x: num(m.get('x')), y: num(m.get('y')) })
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x).map((c) => c.id)
}
