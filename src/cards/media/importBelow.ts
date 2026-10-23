/**
 * Files pasted while a card's text is being edited (a screenshot pasted into a note) become cards
 * right below that card, without leaving the editor.
 */
import type * as Y from 'yjs'
import { columnChildren, getCardMap, insertIntoColumn, isTrashed, readCard } from '../../model/board'
import { isUnsortedMap } from '../../model/unsorted'
import { getUser } from '../../collab/identity'
import { toast } from '../../ui/toast'
import { viewCenter } from '../../board/actions'
import { elementBoardRect, measuredSize } from '../../board/geometry'
import { importFiles } from './import'
import { renamePasted } from './paste'

const GAP = 20
const FALLBACK_HEIGHT = 120

function liveColumn(doc: Y.Doc, id: string | null): string | null {
  if (!id) return null
  const m = getCardMap(doc, id)
  return m && m.get('type') === 'column' && !isTrashed(m) ? id : null
}

function addedMessage(doc: Y.Doc, ids: string[]): string {
  if (ids.length > 1) return `${ids.length} files added below`
  return getCardMap(doc, ids[0])?.get('type') === 'image' ? 'Image added below' : 'File added below'
}

/**
 * Imports `files` below card `cardId`: under it on the canvas, right after it in its column, or near
 * the view centre for a card in Unsorted. Selection and editing stay as they are. Resolves with the
 * new card ids (empty when nothing could be added).
 */
export async function importBelowCard(doc: Y.Doc, cardId: string, files: File[]): Promise<string[]> {
  const m = getCardMap(doc, cardId)
  if (!m || isTrashed(m) || !files.length) return []
  const card = readCard(m)
  const column = liveColumn(doc, card.parent)
  const parentMap = column ? getCardMap(doc, column) : undefined
  const unsorted = isUnsortedMap(m) || (!!parentMap && isUnsortedMap(parentMap))

  let at: { x: number; y: number }
  if (unsorted) {
    const c = viewCenter()
    at = { x: c.x - 150, y: c.y - 100 }
  } else if (column) {
    const col = readCard(parentMap ? parentMap : m)
    at = { x: col.x, y: col.y }
  } else {
    const h = elementBoardRect(cardId)?.h ?? measuredSize(cardId)?.h ?? card.h ?? FALLBACK_HEIGHT
    at = { x: card.x, y: card.y + h + GAP }
  }

  const ids = await importFiles(doc, files.map(renamePasted), at, { select: false })
  if (!ids.length || doc.isDestroyed) return ids
  if (column && !unsorted) {
    // The card may have moved while the files were stored.
    const index = columnChildren(doc, column).indexOf(cardId)
    insertIntoColumn(doc, ids, column, index < 0 ? Number.MAX_SAFE_INTEGER : index + 1, getUser().id)
  }
  toast(addedMessage(doc, ids), 'success', 3000)
  return ids
}
