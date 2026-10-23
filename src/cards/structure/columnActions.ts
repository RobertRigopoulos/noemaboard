/**
 * Column commands offered by the structure card actions (see actions.ts): turn a column into a board
 * that keeps its title, colour and cards, and sort the cards of a column.
 */
import * as Y from 'yjs'
import { generateNKeysBetween } from 'fractional-indexing'
import { ArrowDownAZ, ArrowDownZA, CalendarArrowDown, CalendarArrowUp, ListTodo, Shapes, type LucideIcon } from 'lucide-react'
import {
  createCard,
  deleteCards,
  forEachActiveCard,
  getCardMap,
  initBoardDoc,
  isTrashed,
  isValidOrderKey,
  LOCAL_ORIGIN,
  moveCardsToBoard,
  readCard,
  updateCards,
  xmlToText,
  type MoveOptions,
} from '../../model/board'
import { newBoardId, newSecret } from '../../model/ids'
import type { CardMap, ColumnCard, LineEnd } from '../../model/types'
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { elementBoardRect, measuredSize } from '../../board/geometry'
import { trackMove } from '../../board/moveUndo'
import { useSelection } from '../../board/store'
import { docs } from '../../collab/docs'
import { useLibrary } from '../../collab/library'
import { getUser } from '../../collab/identity'
import { taskStats } from '../../editor/tasks'
import { toast } from '../../ui/toast'
import { isPinnedComment, type AttachLookup } from './attach'
import { getThread, readThread } from './thread'
import { isCardColor } from './boardAppearance'
import { BOARD_TITLE_MAX, cleanTitle, columnChildIds, sortAroundLocked, type ColumnSortMode, type SortEntry } from './helpers'

/** Where the cards of a converted column land in the new board (its top-left corner). */
const CONVERTED_AT = { x: 40, y: 40 }
const SORT_KEY_MAX = 200

export const SORT_OPTIONS: readonly { mode: ColumnSortMode; label: string; icon: LucideIcon }[] = [
  { mode: 'title-asc', label: 'Title A to Z', icon: ArrowDownAZ },
  { mode: 'title-desc', label: 'Title Z to A', icon: ArrowDownZA },
  { mode: 'newest', label: 'Newest first', icon: CalendarArrowDown },
  { mode: 'oldest', label: 'Oldest first', icon: CalendarArrowUp },
  { mode: 'type', label: 'By type', icon: Shapes },
  { mode: 'unfinished', label: 'Unfinished first', icon: ListTodo },
]

/**
 * Cards a column shows, in order. Comments pinned to a card are drawn as pins, not in the column
 * (a peer may pin a comment that still names the column as its parent).
 */
export function visibleColumnChildren(cards: readonly IndexedCard[], columnId: string, lookup: AttachLookup): string[] {
  return columnChildIds(cards, columnId, (c) => !isPinnedComment(c, lookup))
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? ''
  // To-do items read as '[ ] Buy milk' in plain text; the box is not part of the title.
  return cleanTitle(line.replace(/^\[[ x]\]\s*/, ''), SORT_KEY_MAX)
}

/** What a card is sorted by: its title or name, else its first line of text, else its link or colour. */
export function sortKeyOf(m: CardMap): string {
  for (const k of ['title', 'name']) {
    const v = cleanTitle(m.get(k), SORT_KEY_MAX)
    if (v) return v
  }
  for (const f of ['content', 'caption']) {
    const frag = m.get(f)
    if (frag instanceof Y.XmlFragment) {
      const line = firstLine(xmlToText(frag))
      if (line) return line
    }
  }
  if (m.get('type') === 'comment') {
    const first = readThread(getThread(m))[0]
    if (first) return firstLine(first.text)
  }
  for (const k of ['url', 'hex']) {
    const v = cleanTitle(m.get(k), SORT_KEY_MAX)
    if (v) return v
  }
  return ''
}

/** A to-do list with at least one unchecked task. */
export function isUnfinishedTodo(m: CardMap): boolean {
  if (m.get('type') !== 'todo') return false
  const frag = m.get('content')
  if (!(frag instanceof Y.XmlFragment)) return false
  const { total, done } = taskStats(frag)
  return total > done
}

export interface ColumnSortEntry extends SortEntry {
  /** Locked cards keep their place when the column is sorted. */
  locked: boolean
  /** The order key as stored (peer data: may be malformed). */
  order: unknown
}

/** Sort entries for column children (in their current order). */
export function sortEntriesFor(doc: Y.Doc, ids: readonly string[]): ColumnSortEntry[] {
  const out: ColumnSortEntry[] = []
  for (const id of ids) {
    const m = getCardMap(doc, id)
    if (!m || isTrashed(m)) continue
    const c = readCard(m)
    out.push({
      id,
      type: c.type,
      key: sortKeyOf(m),
      createdAt: c.createdAt,
      unfinished: isUnfinishedTodo(m),
      locked: m.get('locked') === true,
      order: m.get('order'),
    })
  }
  return out
}

/**
 * New order keys for the unlocked cards of a column, given in their new order with the locked cards
 * at their old places. Each run of unlocked cards gets keys between the locked cards around it,
 * whose own keys stay as they are. Null when a locked card's key cannot bound a run (malformed, or
 * not after the previous locked card's key).
 */
export function orderKeysAroundLocked(list: readonly { id: string; locked: boolean; order: unknown }[]): Record<string, string> | null {
  const out: Record<string, string> = {}
  let i = 0
  while (i < list.length) {
    if (list[i].locked) {
      i++
      continue
    }
    let j = i
    while (j < list.length && !list[j].locked) j++
    const lo = i > 0 ? list[i - 1].order : null
    const hi = j < list.length ? list[j].order : null
    if ((lo !== null && !isValidOrderKey(lo)) || (hi !== null && !isValidOrderKey(hi))) return null
    if (typeof lo === 'string' && typeof hi === 'string' && hi <= lo) return null
    let keys: string[]
    try {
      keys = generateNKeysBetween(lo as string | null, hi as string | null, j - i)
    } catch {
      return null
    }
    for (let k = 0; k < keys.length; k++) out[list[i + k].id] = keys[k]
    i = j
  }
  return out
}

const LOCKED_SORT_MESSAGE = 'This column is locked. Unlock it to sort its cards.'
const LOCKED_CONVERT_MESSAGE = 'This column is locked. Unlock it to turn it into a board.'

/**
 * Reorders a column's cards; locked cards keep their places, and a locked column is not sorted.
 * All new order keys are written in one LOCAL_ORIGIN transaction, so the sort is one undo step.
 * Returns false when nothing changed.
 */
export function sortColumn(ctx: BoardContextValue, columnId: string, mode: ColumnSortMode): boolean {
  if (ctx.readOnly) return false
  const col = getCardMap(ctx.doc, columnId)
  if (!col || isTrashed(col) || col.get('type') !== 'column') return false
  if (col.get('locked') === true) {
    toast(LOCKED_SORT_MESSAGE)
    return false
  }
  const ids = visibleColumnChildren(ctx.index.getSnapshot(), columnId, (id) => ctx.index.get(id))
  const entries = sortEntriesFor(ctx.doc, ids)
  if (entries.filter((e) => !e.locked).length < 2) return false
  const sorted = sortAroundLocked(entries, mode)
  if (sorted.every((e, i) => e.id === entries[i].id)) {
    toast('The cards are already in that order')
    return false
  }
  const keys = orderKeysAroundLocked(sorted)
  if (!keys) {
    toast('Could not sort the cards around the locked ones in this column.', 'error')
    return false
  }
  const patches: Record<string, Record<string, unknown>> = {}
  for (const [id, order] of Object.entries(keys)) patches[id] = { order }
  ctx.undo.stopCapturing()
  updateCards(ctx.doc, patches, getUser().id, LOCAL_ORIGIN)
  ctx.undo.stopCapturing()
  return true
}

function retarget(end: unknown, from: string, to: string): LineEnd | null {
  if (!end || typeof end !== 'object') return null
  const e = end as Record<string, unknown>
  if (e.card !== from) return null
  return { card: to, x: Number.isFinite(e.x) ? (e.x as number) : 0, y: Number.isFinite(e.y) ? (e.y as number) : 0 }
}

/**
 * Comments pinned to the column and lines ending on it now belong to the board card that replaces
 * it. Comments that still name the column as their parent although they are pinned to a card (so
 * they did not move with the column's cards) leave the column. Otherwise deleting the column would
 * take them to the trash. Runs after the column's cards were moved away.
 */
function handOver(doc: Y.Doc, columnId: string, boardCardId: string, userId: string) {
  const patches: Record<string, Record<string, unknown>> = {}
  forEachActiveCard(doc, (m, id) => {
    const type = m.get('type')
    if (type === 'comment') {
      const patch: Record<string, unknown> = {}
      if (m.get('attachedTo') === columnId) patch.attachedTo = boardCardId
      if (m.get('parent') === columnId) {
        patch.parent = null
        patch.order = undefined
      }
      if (Object.keys(patch).length) patches[id] = patch
    } else if (type === 'line') {
      const from = retarget(m.get('from'), columnId, boardCardId)
      const to = retarget(m.get('to'), columnId, boardCardId)
      if (from || to) patches[id] = { ...(from ? { from } : null), ...(to ? { to } : null) }
    }
  })
  if (Object.keys(patches).length) updateCards(doc, patches, userId, LOCAL_ORIGIN)
}

/** The column, when it can become a board: an active free column that is not in the Unsorted drawer. */
function convertibleColumn(doc: Y.Doc, columnId: string): ColumnCard | null {
  const m = getCardMap(doc, columnId)
  if (!m || isTrashed(m) || m.get('type') !== 'column') return null
  const col = readCard(m)
  if (col.type !== 'column' || col.parent || col.unsorted === true) return null
  return col
}

/** Rendered height of a card, so the column's cards keep their spacing as free cards. */
const renderedHeight = (id: string) => elementBoardRect(id)?.h ?? measuredSize(id)?.h

/** Takes back a board that was created for a conversion that did not happen: its library entry and local data. */
function forgetNewBoard(boardId: string) {
  useLibrary.getState().remove(boardId)
  void docs.destroyLocal(boardId).catch((err) => console.warn('Could not remove an unused board', err))
}

/**
 * Replaces a free, unlocked column with a board card at the same place, with the column's title and
 * colour; the column's cards move into the new board as free cards stacked in order. The move, the
 * new board card and the column's removal are one transaction and one undo step (whose undo also
 * takes the copies out of the new board again). If anything fails, the column stays as it was and no
 * board is left behind. Returns the new board card id, or null.
 */
export async function convertColumnToBoard(ctx: BoardContextValue, columnId: string): Promise<string | null> {
  const { doc } = ctx
  if (ctx.readOnly) return null
  const first = convertibleColumn(doc, columnId)
  if (!first) return null
  if (first.locked === true) {
    toast(LOCKED_CONVERT_MESSAGE)
    return null
  }
  const title = cleanTitle(first.title, BOARD_TITLE_MAX) || 'Untitled column'
  const color = isCardColor(first.color) ? first.color : null
  const user = getUser()
  const boardId = newBoardId()
  const secret = newSecret()
  // In the library before anything moves: the card never shows as unavailable. The new board's own
  // meta gets the colour too, or loading it would copy "no colour" back onto the card.
  useLibrary.getState().upsert({ id: boardId, secret, title, color, parentId: doc.guid })

  // Written inside the callbacks below.
  const result: { boardCardId: string | null; locked: boolean } = { boardCardId: null, locked: false }
  try {
    await docs.withDoc(boardId, (child) => {
      initBoardDoc(child, { id: boardId, title, color, parentId: doc.guid, shared: false }, user.id)
      // The column may have changed, or gone, while the new board loaded.
      const col = doc.isDestroyed ? null : convertibleColumn(doc, columnId)
      if (!col) return
      if (col.locked === true) {
        result.locked = true
        return
      }
      const childIds = visibleColumnChildren(ctx.index.getSnapshot(), columnId, (id) => ctx.index.get(id))
      const opts: MoveOptions = { heightOf: renderedHeight, unsorted: false }
      trackMove(doc, child, () => {
        let inserted: string[] = []
        doc.transact(() => {
          // The move comes first: when it fails, nothing on this board has changed yet.
          if (childIds.length) inserted = moveCardsToBoard(doc, child, childIds, CONVERTED_AT, user.id, opts)
          const id = createCard(doc, 'board', { x: col.x, y: col.y, boardId, secret, title, color }, user.id)
          // From here on the moved cards live in the new board: it must never be thrown away.
          result.boardCardId = id
          handOver(doc, columnId, id, user.id)
          deleteCards(doc, [columnId], user.id)
        }, LOCAL_ORIGIN)
        return inserted
      })
    })
  } catch (err) {
    console.warn('Could not turn the column into a board', err)
  }

  const { boardCardId } = result
  if (!boardCardId) {
    forgetNewBoard(boardId)
    if (doc.isDestroyed) return null
    if (result.locked) toast(LOCKED_CONVERT_MESSAGE)
    else if (convertibleColumn(doc, columnId)) {
      useSelection.getState().select([columnId])
      toast('Could not turn the column into a board. The column was kept.', 'error')
    }
    return null
  }
  useSelection.getState().select([boardCardId])
  toast('Converted the column into a board', 'success')
  return boardCardId
}
