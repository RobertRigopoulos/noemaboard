/**
 * Undo/redo for "move cards into another board". The move writes two docs: the copies are inserted
 * into the target board (a doc the source board's UndoManager does not track) and the originals are
 * hidden in the source (tracked). Ctrl+Z alone would bring the originals back and leave the copies
 * in the child board, so the move's undo step carries what it inserted (stack item meta) and the
 * matching copies are hidden on undo and shown again on redo.
 */
import type * as Y from 'yjs'
import { cardContentState, getCardMap, hideMovedCopies, isTrashed, unhideMovedCopies, type CardContentState } from '../model/board'
import { docs } from '../collab/docs'
import { getUser } from '../collab/identity'

const META_KEY = 'noema:move-into-board'

interface MoveMeta {
  src: string
  dst: string
  /** Content fingerprint of each copy right after the move (or the last redo). */
  base: Record<string, CardContentState>
  /** Copies hidden by the last undo. */
  hidden: { group: string; ids: string[] } | null
  /** Undo/redo work runs one at a time per move (it loads the target doc asynchronously). */
  queue: Promise<void>
}

type StackItem = { meta: Map<unknown, unknown> }

const managers = new WeakMap<Y.Doc, Y.UndoManager>()

/** Connects a board's UndoManager so moves out of that board can be undone completely. */
export function attachMoveUndo(doc: Y.Doc, undo: Y.UndoManager): () => void {
  managers.set(doc, undo)
  const onPopped = (ev: { stackItem: StackItem; type: 'undo' | 'redo' }) => {
    const meta = ev.stackItem.meta.get(META_KEY) as MoveMeta | undefined
    if (!meta) return
    // The inverse step was just pushed on the other stack: it represents the same move.
    const other = (ev.type === 'undo' ? undo.redoStack : undo.undoStack) as unknown as StackItem[]
    other[other.length - 1]?.meta.set(META_KEY, meta)
    const run = ev.type === 'undo' ? () => undoTargetSide(meta) : () => redoTargetSide(meta)
    meta.queue = meta.queue.then(run, run).catch((err) => console.warn('Could not update the target board of a moved card', err))
  }
  undo.on('stack-item-popped', onPopped)
  return () => {
    undo.off('stack-item-popped', onPopped)
    if (managers.get(doc) === undo) managers.delete(doc)
  }
}

/**
 * Runs a move from `src` to `dst` as its own undo step and remembers what it inserted. `move`
 * returns the inserted ids in `dst`.
 */
export function trackMove(src: Y.Doc, dst: Y.Doc, move: () => string[]): string[] {
  const undo = managers.get(src)
  if (!undo) return move()
  undo.stopCapturing()
  const before = undo.undoStack.length
  const out = move()
  if (undo.undoStack.length > before && out.length) {
    const item = undo.undoStack[undo.undoStack.length - 1] as unknown as StackItem
    item.meta.set(META_KEY, { src: src.guid, dst: dst.guid, base: fingerprints(dst, out), hidden: null, queue: Promise.resolve() } satisfies MoveMeta)
  }
  // Later edits must not merge into the move's undo step.
  undo.stopCapturing()
  return out
}

function fingerprints(doc: Y.Doc, ids: Iterable<string>): Record<string, CardContentState> {
  const base: Record<string, CardContentState> = {}
  for (const id of ids) {
    const m = getCardMap(doc, id)
    if (m && !isTrashed(m)) base[id] = cardContentState(m)
  }
  return base
}

async function undoTargetSide(meta: MoveMeta) {
  await docs.withDoc(meta.dst, (dst) => {
    meta.hidden = hideMovedCopies(dst, meta.base, meta.src, getUser().id)
  })
}

async function redoTargetSide(meta: MoveMeta) {
  await docs.withDoc(meta.dst, (dst) => {
    const shown = meta.hidden ? unhideMovedCopies(dst, meta.hidden) : []
    meta.hidden = null
    meta.base = fingerprints(dst, shown.length ? shown : Object.keys(meta.base))
  })
}
