/** Pure helpers for card drags: Shift axis lock, deferred selection toggles and Alt-drag copies. */
import type { DropTarget } from './store'

export type Axis = 'x' | 'y'

/**
 * Constrains a drag delta to one axis. With no axis chosen yet, the dominant one is picked
 * (|dx| >= |dy| gives 'x'); the caller keeps returning `locked` until Shift is released and then
 * passes null again, so the axis is re-picked when Shift is pressed again.
 */
export function axisLock(dx: number, dy: number, locked: Axis | null): { dx: number; dy: number; locked: Axis } {
  const axis: Axis = locked ?? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y')
  return axis === 'x' ? { dx, dy: 0, locked: axis } : { dx: 0, dy, locked: axis }
}

/**
 * Shift/Mod on a card that was already selected removes it from the selection, but only on release
 * and only when no drag happened, so Shift+drag can move a selection that contains the card.
 */
export function shouldToggleOnRelease(wasSelected: boolean, modifier: boolean, dragged: boolean): boolean {
  return wasSelected && modifier && !dragged
}

/** What an Alt-drag drop does with the copies (they are made first, at the drag offset). */
export type CopyDropPlan =
  /** Dropped on the trash: copying into the trash makes nothing. */
  | { kind: 'none' }
  /** Stay on the canvas. Copies of column children are taken out of their column at the drop spot. */
  | { kind: 'canvas'; placeColumnChildren: boolean }
  | { kind: 'column'; columnId: string; index: number }
  /** Moved into another board after the copy (that move is its own undo step). */
  | { kind: 'board'; boardId: string }

export function copyDropPlan(target: DropTarget | null, fromColumn: boolean): CopyDropPlan {
  switch (target?.kind) {
    case 'trash':
      return { kind: 'none' }
    case 'column':
      return { kind: 'column', columnId: target.columnId, index: target.index }
    case 'board':
      return { kind: 'board', boardId: target.boardId }
    default:
      // No target, or a comment pin target: copies are never pinned, they land where dropped.
      return { kind: 'canvas', placeColumnChildren: fromColumn }
  }
}

/** Height for a width change that keeps the start aspect ratio (Shift+resize, images). */
export function keepAspectHeight(w: number, startW: number, startH: number): number {
  return w * (startH / Math.max(1, startW))
}
