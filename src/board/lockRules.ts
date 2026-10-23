/** Lock position: which cards of a delete or cut may actually go, and touch presses on locked cards. */
import type * as Y from 'yjs'
import { getCardMap } from '../model/board'

/**
 * Splits ids into cards that may be deleted and locked cards that stay. A locked card selected on
 * its own is kept; a locked card inside a column that is deleted goes with its column (the column
 * takes all its children along).
 */
export function splitLocked(doc: Y.Doc, ids: Iterable<string>): { deletable: string[]; kept: string[] } {
  const list = Array.from(new Set(ids))
  const isLocked = (id: string) => getCardMap(doc, id)?.get('locked') === true
  const deletedColumns = new Set(list.filter((id) => getCardMap(doc, id)?.get('type') === 'column' && !isLocked(id)))
  const deletable: string[] = []
  const kept: string[] = []
  for (const id of list) {
    const m = getCardMap(doc, id)
    if (!m) continue
    if (!isLocked(id)) {
      deletable.push(id)
      continue
    }
    const parent = m.get('parent')
    if (typeof parent === 'string' && deletedColumns.has(parent)) deletable.push(id)
    else kept.push(id)
  }
  return { deletable, kept }
}

export const LOCKED_KEPT_MESSAGE = 'Locked cards were kept. Unlock them to delete.'

/** Controls inside a card keep their own presses (a checkbox on a locked to-do still toggles). */
const CARD_CONTROLS = 'input, textarea, select, button, a[href], [contenteditable="true"], .no-drag, .resize-handle'

/**
 * Id of the locked card a touch press landed on, when that press belongs to the background instead
 * (a one-finger drag pans, a tap selects the card). Null on controls inside the card, on unlocked
 * cards (an unlocked card inside a locked column included) and off cards.
 */
export function lockedBackgroundCard(t: EventTarget | null): string | null {
  const el = t as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return null
  const shell = el.closest<HTMLElement>('.card-shell')
  if (!shell || !shell.classList.contains('is-locked')) return null
  const control = el.closest(CARD_CONTROLS)
  if (control && shell.contains(control)) return null
  return shell.dataset.cardId ?? null
}
