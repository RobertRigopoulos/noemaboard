/**
 * "Open board X and show card Y": the target is stored here, the board is opened through the
 * router, and BoardChrome applies it (centre + select) once that board's card has loaded.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { BoardContextValue } from '../../board/BoardContext'
import { usePanels, useSelection, useView } from '../../board/store'
import { centerOn } from '../../board/actions'
import { canvasRect, elementBoardRect, measuredSize } from '../../board/geometry'
import { isTrashed } from '../../model/board'
import { openBoard } from '../../app/router'
import { toast } from '../toast'

export interface FocusTarget {
  boardId: string
  cardId: string
  requestedAt: number
}

export const usePendingFocus = create<{ target: FocusTarget | null }>(() => ({ target: null }))

/** Navigates to a board (if needed) and focuses a card on it. */
export function openCard(boardId: string, cardId: string, currentBoardId?: string) {
  usePendingFocus.setState({ target: { boardId, cardId, requestedAt: Date.now() } })
  if (boardId !== currentBoardId) openBoard(boardId)
}

const GIVE_UP_MS = 10_000
/** Lets BoardView's first-visit "fit to content" run before we move the view. */
const SETTLE_MS = 120

/** Centres the view on a card and selects it. */
export function revealCard(ctx: BoardContextValue, cardId: string) {
  const c = ctx.index.get(cardId)
  if (!c) return
  // A card waiting in the Unsorted drawer is not on the canvas: show the drawer instead.
  const top = c.parent ? ctx.index.get(c.parent) : c
  if (top?.unsorted) {
    usePanels.getState().setPanel('unsorted')
    return
  }
  let center: { x: number; y: number }
  if (c.parent) {
    const col = ctx.index.get(c.parent)
    center = col ? { x: col.x + col.w / 2, y: col.y + 160 } : { x: c.x, y: c.y }
  } else if (c.card.type === 'line') {
    center = { x: (c.card.from.x + c.card.to.x) / 2, y: (c.card.from.y + c.card.to.y) / 2 }
  } else {
    const h = c.h ?? measuredSize(cardId)?.h ?? 120
    center = { x: c.x + c.w / 2, y: c.y + Math.min(h, 400) / 2 }
  }
  const { viewport, setViewport } = useView.getState()
  // Make sure the card is readable.
  if (viewport.zoom < 0.6) setViewport({ ...viewport, zoom: 1 })
  centerOn(center)
  useSelection.getState().select([cardId])
  // Once rendered (cards in columns, measured heights), refine so the card's top part is in view.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const r = elementBoardRect(cardId)
      if (!r) return
      const visibleH = canvasRect().height / useView.getState().viewport.zoom
      centerOn({ x: r.x + r.w / 2, y: r.y + Math.min(r.h, visibleH * 0.8) / 2 })
    }),
  )
}

/** Applies a pending focus target when its board is the one on screen. */
export function useApplyPendingFocus(ctx: BoardContextValue) {
  const target = usePendingFocus((s) => s.target)
  useEffect(() => {
    if (!target || target.boardId !== ctx.boardId) return
    if (Date.now() - target.requestedAt > GIVE_UP_MS * 3) {
      usePendingFocus.setState({ target: null })
      return
    }
    let settle: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null
    let finished = false

    const attempt = (): boolean => {
      if (finished) return true
      const map = ctx.cards.get(target.cardId)
      if (map && isTrashed(map)) {
        finished = true
        usePendingFocus.setState({ target: null })
        toast('That card is in the trash now.')
        return true
      }
      if (!map || !ctx.index.get(target.cardId)) return false
      finished = true
      // The target is cleared only when applied: clearing it earlier would re-run this effect
      // and cancel the timer.
      settle = setTimeout(() => {
        usePendingFocus.setState({ target: null })
        revealCard(ctx, target.cardId)
      }, SETTLE_MS)
      return true
    }

    if (!attempt()) {
      unsubscribe = ctx.index.subscribe(() => {
        if (attempt()) unsubscribe?.()
      })
    }
    const giveUp = setTimeout(() => {
      if (finished) return
      finished = true
      unsubscribe?.()
      usePendingFocus.setState({ target: null })
      toast('That card could not be found. It may have been deleted or not synced yet.')
    }, GIVE_UP_MS)
    return () => {
      unsubscribe?.()
      clearTimeout(giveUp)
      if (settle) clearTimeout(settle)
    }
  }, [target, ctx])
}
