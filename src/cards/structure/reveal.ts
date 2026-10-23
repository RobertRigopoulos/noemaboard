/**
 * Bringing a card into view before something is shown next to it (a comment thread, a mention).
 * Cards inside a column have no position of their own: they are only laid out while their column is
 * rendered, which it is not when it is scrolled out of view (culled), collapsed, or in the Unsorted
 * drawer.
 */
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { centerOn } from '../../board/actions'
import { cardBounds, rectsIntersect, visibleBoardRect, waitForLayout, type Rect } from '../../board/geometry'

/** Why a card is not drawn on the canvas right now (it is somewhere else), or null when it is. */
export type HiddenReason = 'unsorted' | 'collapsed'

export function hiddenReason(ctx: Pick<BoardContextValue, 'index'>, c: IndexedCard): HiddenReason | null {
  if (c.unsorted) return 'unsorted'
  if (!c.parent) return null
  const col = ctx.index.get(c.parent)
  if (!col || col.type !== 'column') return null
  if (col.unsorted) return 'unsorted'
  if (col.card.type === 'column' && col.card.collapsed === true) return 'collapsed'
  return null
}

const centre = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/**
 * Scrolls the board so the card is in view and resolves with its board rect once it is laid out,
 * or null when it is not drawn on the canvas (gone, in the Unsorted drawer, in a collapsed column)
 * or could not be laid out.
 */
export async function revealCard(ctx: BoardContextValue, id: string): Promise<Rect | null> {
  let c = ctx.index.get(id)
  if (!c || hiddenReason(ctx, c)) return null
  let rect = cardBounds(c)
  if (!rect) {
    // A card in a column that is not rendered: bring the column into view first.
    const col = c.parent ? ctx.index.get(c.parent) : undefined
    const around = (col && cardBounds(col)) ?? { x: c.x, y: c.y, w: c.w, h: 0 }
    centerOn(centre(around))
    await waitForLayout()
    c = ctx.index.get(id)
    if (!c || ctx.doc.isDestroyed || hiddenReason(ctx, c)) return null
    rect = cardBounds(c)
    if (!rect) return null
  }
  if (rectsIntersect(rect, visibleBoardRect())) return rect
  centerOn(centre(rect))
  // Rects of cards in columns are measured from the page, which must show the new scroll position.
  await waitForLayout()
  const latest = ctx.index.get(id)
  if (!latest || ctx.doc.isDestroyed || hiddenReason(ctx, latest)) return null
  return cardBounds(latest) ?? rect
}
