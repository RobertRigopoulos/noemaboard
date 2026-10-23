/** Which board routes this device can actually open (pure, unit-tested). */
import { HOME_BOARD_ID } from '../config'
import type { LibraryEntry } from '../collab/library'

/**
 * Home always opens. Any other board opens only when this device knows its key (learned from a
 * board card or an invite link). A board whose key is known but whose content has not arrived yet
 * still opens: it fills in once a teammate syncs it.
 *
 * Opening an id this device has never been given (e.g. a link copied from someone else's address
 * bar, or Back after leaving a board) would otherwise create an empty local board that can never
 * sync or be shared.
 */
export function canOpenBoard(boardId: string, entries: Record<string, LibraryEntry>): boolean {
  if (boardId === HOME_BOARD_ID) return true
  if (!Object.prototype.hasOwnProperty.call(entries, boardId)) return false
  return !!entries[boardId]?.secret
}
