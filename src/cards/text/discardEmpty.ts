/**
 * A note, to-do or comment created by a double-click or a quick-add key opens in edit mode. When the
 * person leaves it without writing anything it is discarded, like in Milanote, instead of staying on
 * the shared board as "Empty note" litter.
 */
import { useEffect, useLayoutEffect, useRef } from 'react'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { useBoard } from '../../board/BoardContext'
import { getCards, isTrashed, removeCards } from '../../model/board'
import { getUser } from '../../collab/identity'
import type { Card, CardMap } from '../../model/types'

/** A card counts as just created by this person for this long after its creation. */
export const FRESH_CARD_MS = 10_000

type StackItem = Y.UndoManager['undoStack'][number]
type DeleteSet = StackItem['insertions']

/** Every struct in `ds` is the card itself or something inside it. */
function onlyInside(doc: Y.Doc, ds: DeleteSet, card: CardMap): boolean {
  const own = card._item
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      let c = clock
      while (c < clock + len) {
        const struct = Y.getItem(doc.store, Y.createID(client, c)) as unknown
        if (!(struct instanceof Y.Item)) return false
        if (struct !== own && !Y.isParentOf(card, struct)) return false
        c = struct.id.clock + struct.length
      }
    }
  }
  return true
}

/** True when an undo step changed nothing but this card (its fields or its text). */
function stepOnlyTouches(doc: Y.Doc, step: StackItem, card: CardMap): boolean {
  try {
    return onlyInside(doc, step.insertions, card) && onlyInside(doc, step.deletions, card)
  } catch {
    // A struct that is gone from the store (garbage collected): not a step we can reason about.
    return false
  }
}

/** True when an undo step did nothing but create this card (so undoing it removes exactly the card). */
export function stepOnlyCreates(doc: Y.Doc, step: StackItem, card: CardMap): boolean {
  const own = card._item
  return !!own && Y.isDeleted(step.insertions, own.id) && stepOnlyTouches(doc, step, card)
}

/**
 * How many of the newest undo steps belong only to this card, ending with its creation (0 when the
 * creation is not reachable that way, e.g. something else happened since).
 */
function stepsSinceCreation(doc: Y.Doc, undo: Y.UndoManager, card: CardMap): number {
  const stack = undo.undoStack
  for (let i = stack.length - 1, n = 1; i >= 0; i--, n++) {
    if (stepOnlyCreates(doc, stack[i], card)) return n
    if (!stepOnlyTouches(doc, stack[i], card)) return 0
  }
  return 0
}

/**
 * Removes a card that was just created and left empty. When the newest undo steps are its creation
 * (and, say, text typed and erased again), they are undone and forgotten, so neither Ctrl+Z nor redo
 * brings an empty card back. Otherwise the card is hidden like a card moved away (never listed in
 * the trash).
 */
export function discardEmptyCard(doc: Y.Doc, undo: Y.UndoManager | null, id: string, userId: string) {
  const cards = getCards(doc)
  const m = cards.get(id)
  if (!m || isTrashed(m)) return
  const steps = undo ? stepsSinceCreation(doc, undo, m) : 0
  if (undo && steps > 0) {
    const redoBefore = undo.redoStack.length
    for (let i = 0; i < steps && cards.has(id); i++) undo.undo()
    if (!cards.has(id)) {
      if (redoBefore === 0) undo.clear(false, true)
      return
    }
  }
  removeCards(doc, [id], userId)
}

/** Someone else has the card open for editing (they may be about to type into it). */
function editedByOthers(awareness: Awareness, id: string): boolean {
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId !== awareness.clientID && (state as { editing?: unknown } | null)?.editing === id) return true
  }
  return false
}

export function isFreshCard(card: Pick<Card, 'createdAt' | 'createdBy'>, userId: string, now: number): boolean {
  return !!userId && card.createdBy === userId && Math.abs(now - card.createdAt) < FRESH_CARD_MS
}

/**
 * Discards the card when its first edit session (the one it was created in) ends with nothing
 * written. `isEmpty` is read when editing ends.
 */
export function useDiscardIfLeftEmpty(id: string, card: Card, editing: boolean, readOnly: boolean, isEmpty: () => boolean) {
  const board = useBoard()
  // Decided on mount: a body that mounts already editing a card this person just made.
  const fresh = useRef<boolean | null>(null)
  if (fresh.current === null) fresh.current = editing && !readOnly && isFreshCard(card, getUser().id, Date.now())
  const isEmptyRef = useRef(isEmpty)
  useLayoutEffect(() => {
    isEmptyRef.current = isEmpty
  })
  const wasEditing = useRef(editing)
  useEffect(() => {
    const was = wasEditing.current
    wasEditing.current = editing
    if (!was || editing || !fresh.current) return
    fresh.current = false
    if (readOnly || board.readOnly || !isEmptyRef.current() || editedByOthers(board.awareness, id)) return
    discardEmptyCard(board.doc, board.undo, id, getUser().id)
  }, [editing, readOnly, board, id])
}
