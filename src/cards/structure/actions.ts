/**
 * Card actions and board overlays of the structure cards (comments, columns), registered at module
 * load. CommentCard.tsx and ColumnCard.tsx import this file for its side effects.
 */
import { ArrowUpDown, LayoutGrid, MessageSquare, MessageSquarePlus } from 'lucide-react'
import { registerBoardOverlay, registerCardActions, type CardAction } from '../cardActions'
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { createCard, getCardMap } from '../../model/board'
import { getUser } from '../../collab/identity'
import { toast } from '../../ui/toast'
import { isAttachableType, pinsOn } from './attach'
import { markFreshPin, usePins } from './pinStore'
import { convertColumnToBoard, sortColumn, SORT_OPTIONS, visibleColumnChildren } from './columnActions'
import { cleanTitle } from './helpers'
import { hiddenReason, revealCard } from './reveal'
import { getThread, readThread } from './thread'
import { MentionsNotifier } from './MentionsNotifier'

/** Gap between a card and the stored position of a comment pinned to it (used if it is detached). */
const PIN_OFFSET = 20
/** Opens the newest open comment thread of the selected card. */
export const OPEN_COMMENTS_KEYS = 'Mod+Alt+Shift+M'
const THREAD_LABEL_MAX = 48

/**
 * Pins a new comment to a card and opens its thread with the composer focused. The card is brought
 * into view and laid out first (a card in a column off screen has no rect until its column renders),
 * so the marker and its thread can show. The comment keeps a real position next to the card, where
 * it shows up if it is ever detached or the card goes away. One undo step; closing the thread
 * without writing anything removes the pin again.
 */
export async function addPinnedComment(ctx: BoardContextValue, targetId: string): Promise<string | null> {
  if (ctx.readOnly) return null
  const t = ctx.index.get(targetId)
  if (!t || !isAttachableType(t.type) || hiddenReason(ctx, t)) return null
  const rect = await revealCard(ctx, targetId)
  if (ctx.doc.isDestroyed) return null
  if (!rect) {
    if (ctx.index.get(targetId)) toast('Could not show that card to comment on it. Scroll to it and try again.', 'error')
    return null
  }
  ctx.undo.stopCapturing()
  const id = createCard(
    ctx.doc,
    'comment',
    { attachedTo: targetId, x: Math.round(rect.x + rect.w + PIN_OFFSET), y: Math.round(rect.y), parent: null },
    getUser().id,
  )
  ctx.undo.stopCapturing()
  markFreshPin(id)
  usePins.getState().openPin(id, { focusComposer: true })
  return id
}

/** Brings a card into view and opens one of the comment threads pinned to it. */
export async function openPinnedThread(ctx: BoardContextValue, targetId: string, commentId: string): Promise<boolean> {
  const rect = await revealCard(ctx, targetId)
  if (!rect || ctx.doc.isDestroyed) return false
  usePins.getState().openPin(commentId, { focusComposer: false })
  return true
}

interface ThreadSummary {
  id: string
  label: string
  resolved: boolean
}

/**
 * The threads pinned to a card that have a marker: those with messages, and empty ones started on
 * this device or by this person (the others are still being written by someone).
 */
function threadsOn(ctx: BoardContextValue, targetId: string): ThreadSummary[] {
  const me = getUser().id
  const out: ThreadSummary[] = []
  for (const id of pinsOn(ctx.index.getSnapshot(), (cid) => ctx.index.get(cid), targetId)) {
    const m = getCardMap(ctx.doc, id)
    if (!m) continue
    const first = readThread(getThread(m))[0]
    if (!first && m.get('createdBy') !== me) continue
    const resolved = m.get('resolved') === true
    const text = first ? cleanTitle(`${first.authorName}: ${first.text}`, THREAD_LABEL_MAX) : 'New comment'
    out.push({ id, label: resolved ? `${text} (resolved)` : text, resolved })
  }
  return out
}

/** Number of comment threads a card shows markers for (for its keyboard announcement). */
export function commentThreadCount(ctx: BoardContextValue, targetId: string): number {
  return threadsOn(ctx, targetId).length
}

function commentActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  if (cards.length !== 1) return []
  const t = cards[0]
  // Cards in the Unsorted drawer or in a collapsed column show no markers (nor threads).
  if (!isAttachableType(t.type) || hiddenReason(ctx, t)) return []
  const out: CardAction[] = [
    {
      id: 'comment.attach',
      label: 'Comment',
      icon: MessageSquarePlus,
      group: 'collab',
      inToolbar: true,
      keys: 'Mod+Alt+M',
      run: () => addPinnedComment(ctx, t.id),
    },
  ]
  const threads = threadsOn(ctx, t.id)
  if (!threads.length) return out
  const open = (id: string) => () => openPinnedThread(ctx, t.id, id)
  if (threads.length === 1) {
    out.push({
      id: 'comment.open',
      label: 'Open comment thread',
      icon: MessageSquare,
      group: 'collab',
      keys: OPEN_COMMENTS_KEYS,
      readOnlyOk: true,
      run: open(threads[0].id),
    })
    return out
  }
  // The shortcut opens the newest thread that is not resolved, else the newest one.
  const preferred = [...threads].reverse().find((th) => !th.resolved) ?? threads[threads.length - 1]
  out.push({
    id: 'comment.open',
    label: `Open comments (${threads.length})`,
    icon: MessageSquare,
    group: 'collab',
    readOnlyOk: true,
    children: threads.map((th) => ({
      id: `comment.open.${th.id}`,
      label: th.label,
      icon: MessageSquare,
      group: 'collab' as const,
      readOnlyOk: true,
      ...(th === preferred ? { keys: OPEN_COMMENTS_KEYS } : null),
      run: open(th.id),
    })),
  })
  return out
}

function columnActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  if (cards.length !== 1 || cards[0].type !== 'column') return []
  const col = cards[0]
  // A locked column keeps its place and its cards: it is neither replaced nor reordered.
  const locked = col.card.locked === true
  const hint = locked ? 'Locked' : undefined
  const out: CardAction[] = []
  if (!col.parent && !col.unsorted) {
    out.push({
      id: 'column.toBoard',
      label: 'Convert to board',
      icon: LayoutGrid,
      group: 'convert',
      disabled: locked,
      hint,
      run: () => convertColumnToBoard(ctx, col.id),
    })
  }
  // Locked cards keep their places: only the others are sorted.
  const kids = visibleColumnChildren(ctx.index.getSnapshot(), col.id, (id) => ctx.index.get(id)).filter(
    (id) => ctx.index.get(id)?.card.locked !== true,
  )
  if (kids.length >= 2) {
    const hasTodos = kids.some((id) => ctx.index.get(id)?.type === 'todo')
    out.push({
      id: 'column.sort',
      label: 'Sort cards',
      icon: ArrowUpDown,
      group: 'arrange',
      disabled: locked,
      hint,
      children: SORT_OPTIONS.filter((o) => o.mode !== 'unfinished' || hasTodos).map((o) => ({
        id: `column.sort.${o.mode}`,
        label: o.label,
        icon: o.icon,
        group: 'arrange' as const,
        disabled: locked,
        run: () => {
          sortColumn(ctx, col.id, o.mode)
        },
      })),
    })
  }
  return out
}

export function structureActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  return [...commentActions(ctx, cards), ...columnActions(ctx, cards)]
}

registerCardActions(structureActions)
registerBoardOverlay('structure.mentions', MentionsNotifier)
