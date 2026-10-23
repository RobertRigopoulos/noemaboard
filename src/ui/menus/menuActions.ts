/**
 * Card actions offered by the context menu and the selection toolbar. They act on an explicit
 * list of ids (the menu's), syncing the selection first because the shared board actions read it.
 */
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { addCard, deleteSelection, moveIntoBoard } from '../../board/actions'
import { elementBoardRect } from '../../board/geometry'
import { useSelection } from '../../board/store'
import { getUser } from '../../collab/identity'
import { getCards } from '../../model/board'
import { getDefinition } from '../../cards/registry'
import { toast } from '../toast'
import { boundsTopLeft, groupIntoColumn, isGroupable, ungroupColumn } from './grouping'

/** Active cards for the given ids, in the given order (missing / trashed ids are skipped). */
export function cardsFor(ctx: BoardContextValue, ids: readonly string[]): IndexedCard[] {
  const out: IndexedCard[] = []
  for (const id of ids) {
    const c = ctx.index.get(id)
    if (c) out.push(c)
  }
  return out
}

/** Makes the selection exactly `ids` (board actions such as duplicate read the selection). */
export function syncSelection(ids: readonly string[]) {
  const sel = useSelection.getState()
  if (sel.selected.size === ids.length && ids.every((id) => sel.selected.has(id))) return
  sel.select(ids)
}

export interface SelectionCapabilities {
  count: number
  colorable: boolean
  single: IndexedCard | null
  canEdit: boolean
  isBoard: boolean
  canGroup: boolean
  columns: string[]
  canTurnIntoBoard: boolean
}

export function capabilities(cards: readonly IndexedCard[]): SelectionCapabilities {
  const single = cards.length === 1 ? cards[0] : null
  const singleDef = single ? getDefinition(single.type) : undefined
  return {
    count: cards.length,
    colorable: cards.length > 0 && cards.every((c) => getDefinition(c.type)?.colorable === true),
    single,
    canEdit: !!singleDef?.editable && single?.type !== 'line',
    isBoard: single?.type === 'board',
    canGroup: cards.some((c) => isGroupable(c)),
    columns: cards.filter((c) => c.type === 'column').map((c) => c.id),
    canTurnIntoBoard: cards.some((c) => !c.parent && c.type !== 'line'),
  }
}

export function deleteIds(ctx: BoardContextValue, ids: readonly string[]) {
  if (!ids.length) return
  syncSelection(ids)
  deleteSelection(ctx.doc)
}

export function groupSelectionIntoColumn(ctx: BoardContextValue, ids: readonly string[]) {
  ctx.undo.stopCapturing()
  const col = groupIntoColumn(ctx.doc, ids, getUser().id)
  if (col) useSelection.getState().select([col])
}

export function ungroupColumns(ctx: BoardContextValue, columnIds: readonly string[]) {
  ctx.undo.stopCapturing()
  const freed: string[] = []
  for (const id of columnIds) freed.push(...ungroupColumn(ctx.doc, id, getUser().id, elementBoardRect))
  useSelection.getState().select(freed)
}

/** Creates a board card where the cards were and moves them into the new board. */
export async function turnIntoBoard(ctx: BoardContextValue, ids: readonly string[]) {
  const cards = cardsFor(ctx, ids).filter((c) => !c.parent)
  if (!cards.some((c) => c.type !== 'line')) return
  const at = boundsTopLeft(cards.map((c) => c.card)) ?? { x: 0, y: 0 }
  ctx.undo.stopCapturing()
  const cardId = addCard(ctx.doc, 'board', { title: 'New board' }, { at, centered: false })
  const boardId = getCards(ctx.doc).get(cardId)?.get('boardId')
  if (typeof boardId !== 'string' || !boardId) return
  try {
    // The new board shows the cards as they were laid out here, never in its Unsorted drawer.
    await moveIntoBoard(
      ctx.doc,
      cards.map((c) => c.id),
      boardId,
      { unsorted: false },
    )
    useSelection.getState().select([cardId])
    toast(cards.length === 1 ? 'Moved 1 card into a new board' : `Moved ${cards.length} cards into a new board`, 'success')
  } catch {
    toast('Could not move the cards into the new board', 'error')
  }
}
