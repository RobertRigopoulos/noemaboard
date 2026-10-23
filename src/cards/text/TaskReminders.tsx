/**
 * Board overlay that reminds the current user of their tasks (in to-dos, notes and documents) due
 * today or overdue: when the board opens and every 10 minutes while the window is visible, one toast
 * per task per day, with a Show button that selects the card and brings it into view. Local only
 * (no server, no push).
 */
import { useEffect } from 'react'
import type { BoardContextValue } from '../../board/BoardContext'
import { centerOn, zoomToSelection } from '../../board/actions'
import { cardBounds } from '../../board/geometry'
import { usePanels, useSelection, useView } from '../../board/store'
import { getUser } from '../../collab/identity'
import { getCards } from '../../model/board'
import { toast } from '../../ui/toast'
import { today } from '../../editor/dayClock'
import { dueReminders, loadSeen, pickFresh, REMINDER_INTERVAL_MS, reminderMessage, saveSeen } from './reminders'

/** More fresh reminders than this at once are summed up in one toast. */
const MAX_TOASTS = 3

function stillOpen(ctx: BoardContextValue): boolean {
  return useView.getState().boardId === ctx.boardId
}

/** Selects a card and scrolls it into view (opening the Unsorted drawer for a parked card). */
export function showCard(ctx: BoardContextValue, cardId: string): void {
  if (!stillOpen(ctx)) return
  const c = ctx.index.get(cardId)
  if (!c) {
    toast('That card is no longer on this board.')
    return
  }
  const parent = c.parent ? ctx.index.get(c.parent) : undefined
  useSelection.getState().select([cardId])
  if (c.unsorted || parent?.unsorted) {
    usePanels.getState().setPanel('unsorted')
    return
  }
  const r = cardBounds(c) ?? (parent ? cardBounds(parent) : null)
  if (r) centerOn({ x: r.x + r.w / 2, y: r.y + Math.min(r.h, 400) / 2 })
}

function remind(ctx: BoardContextValue) {
  const me = getUser().id
  const day = today()
  const { fresh, seen } = pickFresh(dueReminders(ctx.doc, me, day), loadSeen(ctx.boardId), day)
  if (!fresh.length) return
  saveSeen(ctx.boardId, seen)
  const shown = fresh.length > MAX_TOASTS ? fresh.slice(0, MAX_TOASTS - 1) : fresh
  for (const r of shown) {
    toast(reminderMessage(r), 'info', 10000, { label: 'Show', run: () => showCard(ctx, r.cardId) })
  }
  const rest = fresh.slice(shown.length)
  if (rest.length) {
    const ids = Array.from(new Set(rest.map((r) => r.cardId)))
    toast(`${rest.length} more of your tasks are due today or overdue`, 'info', 10000, {
      label: 'Show',
      run: () => {
        if (!stillOpen(ctx)) return
        const present = ids.filter((id) => ctx.index.get(id))
        if (!present.length) return
        useSelection.getState().select(present)
        zoomToSelection(ctx.doc)
      },
    })
  }
}

export function TaskReminders({ ctx }: { ctx: BoardContextValue }) {
  useEffect(() => {
    let last = 0
    const run = () => {
      if (document.visibilityState !== 'visible' || ctx.doc.isDestroyed) return
      // Not while presenting: the reminder waits for the next check.
      if (usePanels.getState().presenting || !stillOpen(ctx)) return
      last = Date.now()
      remind(ctx)
    }
    // The board may still be loading from local storage or peers: look once it had a moment, and
    // again a little later when it was empty then.
    let second = 0
    const first = window.setTimeout(() => {
      run()
      if (!getCards(ctx.doc).size) second = window.setTimeout(run, 10000)
    }, 2500)
    const timer = window.setInterval(run, REMINDER_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= REMINDER_INTERVAL_MS) run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(first)
      window.clearTimeout(second)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [ctx])
  return null
}
