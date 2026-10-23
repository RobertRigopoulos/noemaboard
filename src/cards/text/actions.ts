/**
 * Card actions of the text cards, registered at module load (NoteCard.tsx imports this file):
 * converting between note, to-do and document, and hiding or deleting a to-do's completed tasks.
 */
import * as Y from 'yjs'
import { CheckSquare, EyeOff, FileText, ListX, Shuffle, StickyNote, type LucideIcon } from 'lucide-react'
import { registerCardActions, type CardAction } from '../cardActions'
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { useSelection } from '../../board/store'
import { getCardMap, updateCard } from '../../model/board'
import { convertTextCard, isTextCardType, TEXT_CARD_TYPES, type TextCardType } from '../../model/convertText'
import { getUser } from '../../collab/identity'
import { toast } from '../../ui/toast'
import { APP_NAME } from '../../config'
import { deleteCheckedTasks, hasCheckedTasks, readHideDone } from '../../editor/tasks'
import { isFragmentProjectable } from '../../editor/staticHtml'

const TYPES: Record<TextCardType, { label: string; icon: LucideIcon }> = {
  note: { label: 'Note', icon: StickyNote },
  todo: { label: 'To-do', icon: CheckSquare },
  document: { label: 'Document', icon: FileText },
}

function contentOf(ctx: BoardContextValue, id: string): Y.XmlFragment | null {
  const content = getCardMap(ctx.doc, id)?.get('content')
  return content instanceof Y.XmlFragment ? content : null
}

/** Turns hiding of completed tasks on or off for a to-do (one undo step). */
export function setHideDone(ctx: BoardContextValue, id: string, hide: boolean): void {
  if (ctx.readOnly) return
  ctx.undo.stopCapturing()
  updateCard(ctx.doc, id, { hideDone: hide }, getUser().id)
  ctx.undo.stopCapturing()
}

type StackItem = Y.UndoManager['undoStack'][number]
type DeleteSet = ReturnType<typeof Y.createDeleteSet>

/**
 * Undoes one particular step of the board history, even when newer steps sit above it (the person
 * typed or moved a card while the toast was up). Yjs undo restores exactly what that step changed,
 * whatever happened since. Every other step stays on the stack, in order. Returns false when the
 * step is no longer there (already undone with Ctrl+Z).
 */
export function undoStep(undo: Y.UndoManager, step: StackItem): boolean {
  const stack = undo.undoStack
  if (!stack.includes(step)) return false
  const others = stack.filter((s) => s !== step)
  // undo() pops the top step and, when that one has nothing left to restore, goes on popping. So
  // while it runs, the stack holds only this step, over an empty one that stands in for the others
  // (the toolbar reads the stack when it is told about the undo, and must still see more to undo).
  const Step = step.constructor as new (deletions: DeleteSet, insertions: DeleteSet) => StackItem
  const standIn = others.length ? [new Step(Y.createDeleteSet(), Y.createDeleteSet())] : []
  stack.splice(0, stack.length, ...standIn, step)
  try {
    undo.undo()
  } finally {
    // Whatever is left besides the stand-in (nothing, normally) stays on top.
    const left = stack.filter((s) => !standIn.includes(s))
    stack.splice(0, stack.length, ...others, ...left)
  }
  return true
}

/**
 * Deletes a to-do's completed tasks (one undo step). The toast's Undo brings back exactly these
 * tasks, also after other changes. Returns how many went.
 */
export function deleteCompletedTasks(ctx: BoardContextValue, id: string): number {
  const content = contentOf(ctx, id)
  if (!content || ctx.readOnly) return 0
  ctx.undo.stopCapturing()
  const before = ctx.undo.undoStack.length
  const removed = deleteCheckedTasks(content)
  ctx.undo.stopCapturing()
  const step = ctx.undo.undoStack.length > before ? ctx.undo.undoStack[ctx.undo.undoStack.length - 1] : null
  if (removed > 0) {
    const message = `Deleted ${removed} completed ${removed === 1 ? 'task' : 'tasks'}`
    const run = () => {
      if (ctx.readOnly) return
      // Gone from the history: already undone with Ctrl+Z (and maybe redone since).
      if (!step || !undoStep(ctx.undo, step)) toast('That can no longer be undone from here.', 'info')
    }
    toast(message, 'info', 6000, step ? { label: 'Undo', run } : undefined)
  }
  return removed
}

/** Converts a text card to another text card type, telling the person when it cannot be done. */
export function convertCard(ctx: BoardContextValue, id: string, to: TextCardType): boolean {
  if (ctx.readOnly) return false
  const sel = useSelection.getState()
  if (sel.editing === id) sel.setEditing(null)
  ctx.undo.stopCapturing()
  const ok = convertTextCard(ctx.doc, id, to, getUser().id)
  ctx.undo.stopCapturing()
  if (!ok) {
    const content = contentOf(ctx, id)
    if (content && !isFragmentProjectable(content)) {
      toast(`This card has content from a newer version of ${APP_NAME} and can’t be converted.`, 'error', 6000)
    } else toast('This card can’t be converted.', 'error')
  }
  return ok
}

export function textCardActions(ctx: BoardContextValue, cards: readonly IndexedCard[]): CardAction[] {
  if (cards.length !== 1 || ctx.readOnly) return []
  const c = cards[0]
  const out: CardAction[] = []
  if (c.type === 'todo') {
    const hide = readHideDone((c.card as { hideDone?: unknown }).hideDone)
    const content = contentOf(ctx, c.id)
    out.push(
      {
        id: 'todo.hideDone',
        label: 'Hide completed',
        icon: EyeOff,
        group: 'edit',
        pressed: hide,
        run: () => setHideDone(ctx, c.id, !hide),
      },
      {
        id: 'todo.deleteDone',
        label: 'Delete completed',
        icon: ListX,
        group: 'edit',
        disabled: !content || !hasCheckedTasks(content),
        run: () => {
          deleteCompletedTasks(ctx, c.id)
        },
      },
    )
  }
  const from = c.type
  if (isTextCardType(from)) {
    out.push({
      id: 'text.convert',
      label: 'Convert to',
      icon: Shuffle,
      group: 'convert',
      children: TEXT_CARD_TYPES.filter((t) => t !== from).map((to) => ({
        id: `text.convert.${to}`,
        label: TYPES[to].label,
        icon: TYPES[to].icon,
        group: 'convert' as const,
        run: () => {
          convertCard(ctx, c.id, to)
        },
      })),
    })
  }
  return out
}

registerCardActions(textCardActions)
