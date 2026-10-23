/**
 * Renaming / re-iconing / re-colouring / re-covering a nested board touches three places that must
 * agree: the board card in the parent doc (undoable), the library entry (keyring cache), and the
 * child doc's own meta. The child doc has its own undo stack, so it is written with SYSTEM_ORIGIN.
 *
 * Undo / redo only revert the card. syncAppearanceOnUndo() then pushes the card's values to the
 * library and the child meta as well: otherwise the library title would keep showing the new name,
 * and the docs registry would copy the child meta back onto the card the next time the child loads.
 *
 * Other UI (selection toolbar, context menu) should call this for board cards too: otherwise the
 * docs registry copies the child meta back onto the card the next time the child doc loads.
 */
import * as Y from 'yjs'
import { forEachActiveCard, getCards, updateCard, updateMeta, SYSTEM_ORIGIN } from '../../model/board'
import { isValidId } from '../../model/ids'
import { CARD_COLORS, type BoardMeta, type CardColor } from '../../model/types'
import { docs } from '../../collab/docs'
import { useLibrary } from '../../collab/library'
import { getUser } from '../../collab/identity'
import { BOARD_TITLE_MAX, cleanTitle, isBlobHash, sanitizeIcon } from './helpers'

/** An image of a board offered as a cover. */
export interface CoverChoice {
  /** Blob hash to store as the cover: the image's display copy when it has one, else the image. */
  hash: string
  name: string
}

/** Most images offered as covers. */
export const MAX_COVER_CHOICES = 24
const CHOICE_NAME_MAX = 80

/** Images on a board that can become a cover, in card order, without duplicates. */
export function childImageChoices(doc: Y.Doc, max = MAX_COVER_CHOICES): CoverChoice[] {
  const out: CoverChoice[] = []
  const seen = new Set<string>()
  forEachActiveCard(doc, (m) => {
    if (out.length >= max || m.get('type') !== 'image') return
    const thumb = m.get('thumb')
    const blob = m.get('blob')
    const hash = isBlobHash(thumb) ? thumb : isBlobHash(blob) ? blob : null
    if (!hash || seen.has(hash)) return
    seen.add(hash)
    out.push({ hash, name: cleanTitle(m.get('alt'), CHOICE_NAME_MAX) || cleanTitle(m.get('name'), CHOICE_NAME_MAX) || 'image' })
  })
  return out
}

export interface BoardAppearance {
  title?: string
  icon?: string | null
  color?: CardColor | null
  /** Blob hash of a cover image shown on the tile instead of the icon. */
  cover?: string | null
}

export type CleanAppearance = Partial<Pick<BoardMeta, 'title' | 'icon' | 'color'>> & { cover?: string | null }

export function isCardColor(v: unknown): v is CardColor {
  return typeof v === 'string' && (CARD_COLORS as readonly string[]).includes(v)
}

/** A board card's cover, when it is a valid blob hash. */
export function readCover(v: unknown): string | null {
  return isBlobHash(v) ? v : null
}

/**
 * Validated subset of the patch; undefined fields are left alone. A cover that is not a blob hash is
 * dropped (no change); null removes the cover.
 */
export function cleanAppearance(patch: BoardAppearance): CleanAppearance {
  const out: CleanAppearance = {}
  if (patch.title !== undefined) out.title = cleanTitle(patch.title, BOARD_TITLE_MAX) || 'Untitled board'
  if (patch.icon !== undefined) out.icon = patch.icon === null ? null : sanitizeIcon(patch.icon)
  if (patch.color !== undefined) out.color = isCardColor(patch.color) ? patch.color : null
  if (patch.cover === null) out.cover = null
  else if (patch.cover !== undefined && isBlobHash(patch.cover)) out.cover = patch.cover
  return out
}

/** Writes the appearance to the library entry and the child board's own meta (never undoable there). */
async function propagate(boardId: string, clean: CleanAppearance) {
  // The library has no use for covers; they live on the card and in the child meta.
  const { cover: _cover, ...forLibrary } = clean
  if (Object.keys(forLibrary).length) useLibrary.getState().upsert({ id: boardId, ...forLibrary })
  try {
    await docs.withDoc(boardId, (child) => updateMeta(child, clean, SYSTEM_ORIGIN))
  } catch (err) {
    // Storage failure: the card and library already show the change, which is the best we can do.
    console.warn('Could not update board meta', boardId, err)
  }
}

export async function updateBoardAppearance(parentDoc: Y.Doc, cardId: string, boardId: string | null, patch: BoardAppearance) {
  const clean = cleanAppearance(patch)
  if (!Object.keys(clean).length) return
  syncAppearanceOnUndo(parentDoc)
  updateCard(parentDoc, cardId, clean, getUser().id)
  if (!boardId || !isValidId(boardId)) return
  await propagate(boardId, clean)
}

const APPEARANCE_KEYS = ['title', 'icon', 'color', 'cover'] as const

/**
 * The appearance fields of board cards that an undo/redo transaction changed, keyed by child board
 * id. Pure (exported for tests).
 */
export function appearanceChangesOf(events: Y.YEvent<any>[], cards: Y.Map<unknown>): Map<string, CleanAppearance> {
  const out = new Map<string, CleanAppearance>()
  for (const event of events) {
    const card = event.target
    if (!(card instanceof Y.Map) || card.parent !== cards || !(event instanceof Y.YMapEvent)) continue
    if (card.get('type') !== 'board') continue
    const boardId = card.get('boardId')
    if (typeof boardId !== 'string' || !isValidId(boardId)) continue
    const patch: BoardAppearance = {}
    for (const key of APPEARANCE_KEYS) {
      if (!event.keysChanged.has(key)) continue
      const value = card.get(key)
      if (key === 'title') patch.title = typeof value === 'string' ? value : ''
      else if (key === 'icon') patch.icon = typeof value === 'string' ? value : null
      else if (key === 'color') patch.color = isCardColor(value) ? value : null
      else patch.cover = readCover(value)
    }
    const clean = cleanAppearance(patch)
    if (Object.keys(clean).length) out.set(boardId, { ...out.get(boardId), ...clean })
  }
  return out
}

const synced = new WeakSet<Y.Doc>()

/**
 * Keeps the library entry and child board meta in step with board cards when an undo or redo
 * reverts an appearance change. Installed once per parent doc (idempotent): by
 * updateBoardAppearance, before any such change can be on the undo stack, and by mounted board cards.
 */
export function syncAppearanceOnUndo(parentDoc: Y.Doc, push: (boardId: string, clean: CleanAppearance) => void = (id, c) => void propagate(id, c)) {
  if (synced.has(parentDoc)) return
  synced.add(parentDoc)
  const cards = getCards(parentDoc)
  cards.observeDeep((events, tr) => {
    if (!(tr.origin instanceof Y.UndoManager)) return
    for (const [boardId, clean] of appearanceChangesOf(events, cards as Y.Map<unknown>)) push(boardId, clean)
  })
}
