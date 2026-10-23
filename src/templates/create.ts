/**
 * New boards from templates: a board card on the current board pointing to a new child board (its
 * own id and secret, known to the library like any board made here), filled with the template.
 */
import type * as Y from 'yjs'
import { createCard, initBoardDoc, SYSTEM_ORIGIN } from '../model/board'
import { newBoardId, newSecret } from '../model/ids'
import { DEFAULT_SIZE } from '../model/types'
import { docs } from '../collab/docs'
import { useLibrary } from '../collab/library'
import { getUser } from '../collab/identity'
import { findFreeSpot, snap, viewCenter } from '../board/actions'
import { BLANK_BOARD, getTemplate, templateBoardTitle } from './registry'
import type { TemplateChoice } from './types'

/** Board cards have no stored height; the same estimate addCard uses when looking for space. */
const BOARD_CARD_H = 80

/**
 * Creates a board from `templateId` as a card on `parentDoc` and returns the new board's id.
 * The card is centred on `at` (board coordinates; default: the view centre), moved to the nearest
 * free spot. Adding the card is one undoable step on the parent board; the child board's content
 * is written without undo history. Unknown ids create a blank board.
 */
export function createBoardFromTemplate(
  parentDoc: Y.Doc,
  templateId: TemplateChoice,
  at?: { x: number; y: number },
  userId: string = getUser().id,
): string {
  const template = getTemplate(templateId) ?? BLANK_BOARD
  const title = templateBoardTitle(template)
  const icon = template.boardIcon
  const color = template.color
  const boardId = newBoardId()
  const secret = newSecret()
  const parentId = parentDoc.guid

  // Known right away, so the new card never shows as unavailable while the child doc loads.
  useLibrary.getState().upsert({ id: boardId, secret, title, icon, color, parentId })
  void docs
    .withDoc(boardId, (child) => {
      child.transact(() => {
        initBoardDoc(child, { id: boardId, title, icon, color, parentId, shared: false }, userId)
        template.build(child, userId)
      }, SYSTEM_ORIGIN)
    })
    .catch((err) => console.warn('Could not fill the new board from its template', err))

  const w = DEFAULT_SIZE.board.w
  const center = at ?? viewCenter()
  const spot = findFreeSpot(parentDoc, { x: snap(center.x - w / 2), y: snap(center.y - BOARD_CARD_H / 2), w, h: BOARD_CARD_H })
  createCard(parentDoc, 'board', { ...spot, boardId, secret, title, icon, color }, userId)
  return boardId
}
