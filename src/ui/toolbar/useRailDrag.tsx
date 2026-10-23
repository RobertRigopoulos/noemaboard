/**
 * Drag a card type from the rail onto the board: a ghost follows the pointer, a column under the
 * pointer highlights as the drop target, and releasing creates the card there. Releasing outside
 * the canvas (or pressing Escape) cancels.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { BoardContextValue } from '../../board/BoardContext'
import { addCard } from '../../board/actions'
import { elementBoardRect, getCanvasElement, screenToBoard } from '../../board/geometry'
import { useDrag, useView } from '../../board/store'
import { getDefinition } from '../../cards/registry'
import { columnChildren, orderKeyAt } from '../../model/board'
import { COLUMN_CHILD_TYPES, DEFAULT_SIZE, type CardType } from '../../model/types'
import { computeDropIndex } from './dropIndex'

const DRAG_THRESHOLD = 5

/** Card types that open in edit mode right after being created from the rail. */
export const EDIT_ON_CREATE: ReadonlySet<CardType> = new Set<CardType>(['note', 'todo', 'link', 'comment', 'column', 'document', 'sketch'])

/** Approximate rendered heights (board units) for the ghost of auto-height cards. */
const GHOST_HEIGHT: Partial<Record<CardType, number>> = {
  note: 72,
  todo: 112,
  link: 104,
  board: 130,
  column: 180,
  comment: 96,
  document: 150,
  image: 200,
  file: 72,
}

type Target =
  | { kind: 'none' }
  | { kind: 'canvas'; at: { x: number; y: number } }
  | { kind: 'column'; at: { x: number; y: number }; columnId: string; index: number }

interface Ghost {
  type: CardType
  x: number
  y: number
  target: Target['kind']
}

function resolveTarget(ctx: BoardContextValue, type: CardType, clientX: number, clientY: number): Target {
  const canvas = getCanvasElement()
  if (!canvas) return { kind: 'none' }
  const stack = document.elementsFromPoint(clientX, clientY)
  // The topmost element must belong to the canvas (not the rail, header, a panel or a menu).
  if (!stack.length || !canvas.contains(stack[0])) return { kind: 'none' }
  const at = screenToBoard(clientX, clientY)
  if (COLUMN_CHILD_TYPES.has(type)) {
    for (const el of stack) {
      const h = el as HTMLElement
      if (h.dataset?.drop !== 'column') continue
      const columnId = h.dataset.dropId
      const col = columnId ? ctx.index.get(columnId) : undefined
      if (!columnId || !col || col.card.type !== 'column') continue
      const children = columnChildren(ctx.doc, columnId)
      const index = col.card.collapsed ? children.length : computeDropIndex(children.map(elementBoardRect), at.y)
      return { kind: 'column', at, columnId, index }
    }
  }
  return { kind: 'canvas', at }
}

/** Creates a card of `type` for a rail drop. Returns the new card id. */
function createAt(ctx: BoardContextValue, type: CardType, target: Exclude<Target, { kind: 'none' }>): string {
  const edit = EDIT_ON_CREATE.has(type)
  ctx.undo.stopCapturing()
  if (target.kind === 'column') {
    // Create directly inside the column (no flash of a free card).
    const siblings = columnChildren(ctx.doc, target.columnId)
    const order = orderKeyAt(ctx.doc, siblings, Math.min(target.index, siblings.length))
    return addCard(ctx.doc, type, { parent: target.columnId, order }, { at: target.at, centered: false, edit })
  }
  return addCard(ctx.doc, type, {}, { at: target.at, centered: false, edit })
}

export function useRailDrag(ctx: BoardContextValue) {
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const suppressClick = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const onPointerDown = useCallback(
    (type: CardType, e: ReactPointerEvent, onDragStart?: () => void) => {
      if (e.button !== 0 || ctx.readOnly) return
      cleanupRef.current?.()
      const startX = e.clientX
      const startY = e.clientY
      const pointerId = e.pointerId
      let dragging = false
      let target: Target = { kind: 'none' }
      // Avoid text selection and native image drags; touch keeps its default for scrolling.
      if (e.pointerType === 'mouse') e.preventDefault()

      const update = (clientX: number, clientY: number) => {
        target = resolveTarget(ctx, type, clientX, clientY)
        setGhost({ type, x: clientX, y: clientY, target: target.kind })
        const drag = useDrag.getState()
        if (target.kind === 'column') {
          drag.setDrag({
            ids: [],
            dx: 0,
            dy: 0,
            target: { kind: 'column', columnId: target.columnId, index: target.index },
            pointer: target.at,
            fromColumn: false,
          })
        } else if (drag.drag && drag.drag.ids.length === 0) drag.setDrag(null)
      }

      const onMove = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
          dragging = true
          suppressClick.current = true
          document.body.classList.add('is-rail-dragging')
          onDragStart?.()
        }
        update(ev.clientX, ev.clientY)
      }
      const finish = (commit: boolean) => {
        cleanup()
        if (!dragging) return
        if (commit && target.kind !== 'none') createAt(ctx, type, target)
        // A click event may still follow on the rail item; drop it after this tick.
        setTimeout(() => {
          suppressClick.current = false
        }, 0)
      }
      const onUp = (ev: PointerEvent) => {
        if (ev.pointerId !== pointerId) return
        if (dragging) update(ev.clientX, ev.clientY)
        finish(ev.type === 'pointerup')
      }
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape' || !dragging) return
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
      // Cancel if the view changes under a touch drag (pinch) or the window loses focus.
      const onBlur = () => finish(false)
      const cleanup = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('blur', onBlur)
        document.body.classList.remove('is-rail-dragging')
        const drag = useDrag.getState()
        if (drag.drag && drag.drag.ids.length === 0) drag.setDrag(null)
        setGhost(null)
        cleanupRef.current = null
      }
      cleanupRef.current = cleanup
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('blur', onBlur)
    },
    [ctx],
  )

  /** Call at the start of a rail item's click handler; true means "this click ended a drag". */
  const consumeClick = useCallback(() => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }, [])

  const ghostNode = ghost ? createPortal(<DragGhost ghost={ghost} />, document.body) : null
  return { onPointerDown, consumeClick, ghostNode }
}

function DragGhost({ ghost }: { ghost: Ghost }) {
  const zoom = useView((s) => s.viewport.zoom)
  const def = getDefinition(ghost.type)
  const Icon = def?.icon
  const size = DEFAULT_SIZE[ghost.type]
  const w = Math.min(360, Math.max(48, size.w * zoom))
  const h = Math.min(280, Math.max(36, (size.h ?? GHOST_HEIGHT[ghost.type] ?? 90) * zoom))
  return (
    <div
      className={`rail-ghost rail-ghost--over-${ghost.target} rail-ghost--${ghost.type}`}
      style={{ transform: `translate(${ghost.x}px, ${ghost.y}px)`, width: w, height: h }}
      aria-hidden
    >
      {Icon && <Icon size={Math.max(14, Math.min(22, 20 * zoom))} strokeWidth={1.75} />}
      {w > 90 && h > 44 && <span>{def?.label}</span>}
    </div>
  )
}
