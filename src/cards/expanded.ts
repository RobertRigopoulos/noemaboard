/**
 * Full-screen views (document editor, image lightbox) are rendered by the card body while
 * usePanels.expanded is the card's id.
 */
import { useLayoutEffect } from 'react'
import { usePanels } from '../board/store'

/** Mounted bodies per card id. */
const mounted = new Map<string, number>()
/** How long a remounted body (card moved between canvas and column) has to take over the view. */
export const HANDOVER_MS = 250

/**
 * Closes the card's full-screen view once no body of it is mounted any more: deleted, moved to
 * another board, or scrolled out of view inside a column. When a teammate drags the card into or out
 * of a column, its body unmounts and mounts again elsewhere at once, and the view stays open.
 */
export function useExpandedOwner(id: string) {
  useLayoutEffect(() => {
    mounted.set(id, (mounted.get(id) ?? 0) + 1)
    return () => {
      const n = (mounted.get(id) ?? 1) - 1
      if (n > 0) mounted.set(id, n)
      else mounted.delete(id)
      setTimeout(() => {
        if (mounted.has(id)) return
        if (usePanels.getState().expanded === id) usePanels.getState().setExpanded(null)
      }, HANDOVER_MS)
    }
  }, [id])
}
