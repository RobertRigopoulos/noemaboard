/**
 * Frame around every card: positioning, selection, drag & drop (canvas, columns, nested boards,
 * trash, comment pins), Alt-drag copies, Shift axis lock, resizing, lock state, remote presence
 * outlines, accessibility semantics and edit-mode switching. Card bodies come from the registry.
 */
import { memo, useCallback, useMemo, type ComponentType, type CSSProperties } from 'react'
import { Lock } from 'lucide-react'
import { useBoard, useCard, useCardMap } from './BoardContext'
import { isInDrag, useContextMenu, useDrag, useSelection, useView, type DropTarget, type LocalDrag } from './store'
import {
  elementBoardRect,
  isSpacePanning,
  measuredSize,
  registerCardElement,
  screenToBoard,
  startMarqueeFrom,
  unregisterCardElement,
  type Rect,
} from './geometry'
import { useCardPresence } from './presenceStore'
import { getDefinition } from '../cards/registry'
import type { CardProps } from '../cards/types'
import { MIN_WIDTH, type Card } from '../model/types'
import {
  bringToFront,
  columnChildren,
  deleteCards,
  duplicateCards,
  expandSelection,
  getCardMap,
  insertIntoColumn,
  LOCAL_ORIGIN,
  placeOnCanvas,
  readCard,
  updateCard,
  updateCards,
  type BoardFork,
} from '../model/board'
import { getUser } from '../collab/identity'
import { setLocalPresence } from '../collab/presence'
import { fillForkedBoards, isMoveTargetBoard, moveIntoBoard, snap } from './actions'
import { axisLock, copyDropPlan, keepAspectHeight, shouldToggleOnRelease, type Axis } from './dragMath'
import { useCopyGhosts } from './CopyGhosts'
import { cardLabel } from './keyboardNav'
import { isAttachableType } from '../cards/structure/attach'
import { swallowNextAltKeyup } from './keyboard'
import { lockedBackgroundCard } from './lockRules'

interface Props {
  id: string
  inColumn?: boolean
}

const DRAG_THRESHOLD = 4
/** A dragged comment pins to the card under the pointer after resting this long within REST_PX. */
const ATTACH_REST_MS = 600
const ATTACH_REST_PX = 6

/**
 * Card bodies are memoised: the shell re-renders on every drag/resize step and presence change, but
 * the body only when its own props change.
 */
const memoBodies = new WeakMap<ComponentType<CardProps<any>>, ComponentType<CardProps<any>>>()
function memoBody(c: ComponentType<CardProps<any>>): ComponentType<CardProps<any>> {
  let m = memoBodies.get(c)
  if (!m) memoBodies.set(c, (m = memo(c) as unknown as ComponentType<CardProps<any>>))
  return m
}

/** Accessible name without reading rich text (cheap, for cards that are not selected or focused). */
function quickLabel(card: Card, fallback: string): string {
  const rec = card as unknown as Record<string, unknown>
  for (const k of ['title', 'name', 'label']) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80)
  }
  return fallback
}

export const CardShell = memo(function CardShell({ id, inColumn = false }: Props) {
  const board = useBoard()
  const card = useCard(id)
  const map = useCardMap(id)
  const selected = useSelection((s) => s.selected.has(id))
  const editing = useSelection((s) => s.editing === id)
  const kbFocused = useSelection((s) => s.kbFocus === id)
  // Primitive selectors (O(1) membership): a pointer move re-renders only the dragged shells.
  const inLocalDrag = useDrag((s) => isInDrag(s.drag, id))
  const localDx = useDrag((s) => (isInDrag(s.drag, id) ? s.drag!.dx : 0))
  const localDy = useDrag((s) => (isInDrag(s.drag, id) ? s.drag!.dy : 0))
  const localW = useDrag((s) => (isInDrag(s.drag, id) ? s.drag!.w : undefined))
  const localH = useDrag((s) => (isInDrag(s.drag, id) ? s.drag!.h : undefined))
  const childDragged = useDrag((s) => !!s.drag && card?.type === 'column' && s.drag.ids.some((d) => board.index.get(d)?.parent === id))
  const dropHere = useDrag((s) => {
    const t = s.drag?.target
    if (!t) return false
    return (t.kind === 'board' && t.cardId === id) || (t.kind === 'column' && t.columnId === id) || (t.kind === 'attach' && t.cardId === id)
  })
  const remote = useCardPresence(board.awareness, id)

  // React 19 ref cleanup: when a card moves into/out of a column, the new shell registers before the
  // old one is cleaned up, so the cleanup only removes its own element.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return
      registerCardElement(id, el)
      return () => unregisterCardElement(id, el)
    },
    [id],
  )
  const startEditing = useCallback(() => useSelection.getState().setEditing(id), [id])
  const stopEditing = useCallback(() => {
    if (useSelection.getState().editing === id) useSelection.getState().setEditing(null)
  }, [id])

  const def = card ? getDefinition(card.type) : undefined
  const typeLabel = def?.label ?? 'Card'
  // Reading a note's text is not free: only the selected or focused card gets its full label,
  // which is what a screen reader announces (aria-activedescendant). The group role has no
  // aria-selected, so the selection state is part of the name.
  const label = useMemo(() => {
    if (!card) return typeLabel
    const base = selected || kbFocused || editing ? cardLabel(card, map) : quickLabel(card, typeLabel)
    return `${base}${selected ? ', selected' : ''}${card.locked ? ', locked' : ''}`
  }, [card, map, selected, kbFocused, editing, typeLabel])

  if (!card || !map) return null
  if (!def) {
    // A card type from a newer app version: keep its data untouched, just show a placeholder.
    if (inColumn) return <div className="card card-unknown">Update the app to see this card</div>
    return (
      <div className="card card-unknown" style={{ position: 'absolute', left: card.x, top: card.y, width: card.w, zIndex: card.z }}>
        Update the app to see this card
      </div>
    )
  }
  const Body = memoBody(def.Component)

  // ----- geometry
  const drag = inLocalDrag ? { dx: localDx, dy: localDy, w: localW, h: localH } : remote.drag
  const dx = drag?.dx ?? 0
  const dy = drag?.dy ?? 0
  const width = drag?.w ?? card.w
  const height = drag?.h ?? card.h
  const isDragging = inLocalDrag && (localDx !== 0 || localDy !== 0)
  const locked = card.locked === true

  const style: CSSProperties = inColumn
    ? {
        position: 'relative',
        transform: dx || dy ? `translate(${dx}px, ${dy}px)` : undefined,
        zIndex: isDragging ? 10 : undefined,
        height: def.resize === 'both' && height ? height : undefined,
      }
    : {
        position: 'absolute',
        left: card.x,
        top: card.y,
        width,
        height: def.resize === 'both' || card.type === 'swatch' ? height : undefined,
        transform: dx || dy ? `translate(${dx}px, ${dy}px)` : undefined,
        zIndex: isDragging || childDragged ? 1_000_000 : card.z,
      }

  const outline = remote.outline
  const className = [
    'card-shell',
    `card-shell--${card.type}`,
    def.frame === 'paper' ? 'card' : 'card-bare',
    selected && 'is-selected',
    editing && 'is-editing',
    isDragging && 'is-dragging',
    dropHere && 'is-drop-target',
    inColumn && 'in-column',
    locked && 'is-locked',
    kbFocused && 'is-kb-focus',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={setRef}
      id={`card-${id}`}
      role="group"
      aria-roledescription={typeLabel}
      aria-label={label}
      className={className}
      style={{ ...style, ...(outline ? ({ '--peer-color': outline.color } as CSSProperties) : null) }}
      data-color={card.color ?? undefined}
      data-type={card.type}
      data-drop={card.type === 'board' ? 'board' : card.type === 'column' ? 'column' : undefined}
      data-drop-id={card.type === 'board' || card.type === 'column' ? id : undefined}
      onPointerDown={(e) => onCardPointerDown(e, board, card, inColumn)}
      onDoubleClick={(e) => {
        if (board.readOnly || !def.editable) return
        if (useSelection.getState().editing === id) return
        e.stopPropagation()
        useSelection.getState().setEditing(id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const sel = useSelection.getState()
        if (!sel.selected.has(id)) sel.select([id])
        useContextMenu.getState().open({
          x: e.clientX,
          y: e.clientY,
          kind: 'card',
          ids: Array.from(useSelection.getState().selected),
          at: screenToBoard(e.clientX, e.clientY),
        })
      }}
    >
      {outline && (
        <div className={`peer-outline${outline.editing ? ' peer-outline--editing' : ''}`} style={{ borderColor: outline.color }}>
          <span className="peer-tag" style={{ background: outline.color }}>
            {outline.name || 'Someone'}
            {outline.editing ? ' is editing' : ''}
          </span>
        </div>
      )}
      <Body
        id={id}
        card={card}
        map={map}
        selected={selected}
        editing={editing}
        inColumn={inColumn}
        readOnly={board.readOnly}
        startEditing={startEditing}
        stopEditing={stopEditing}
      />
      {locked && (
        <span className="lock-badge" title="Locked. Right-click to unlock" aria-hidden>
          <Lock size={12} strokeWidth={2} aria-hidden />
        </span>
      )}
      {selected && !board.readOnly && !locked && def.resize !== 'none' && !(inColumn && def.resize === 'width') && (
        <div
          className={`resize-handle resize-handle--${def.resize}`}
          onPointerDown={(e) => onResizePointerDown(e, board, card, def.resize === 'both', !!def.keepAspect)}
        />
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Pointer interactions (module-level so they do not capture stale React state)

type Board = ReturnType<typeof useBoard>

let broadcastTimer = 0
function broadcastDrag(board: Board, d: { ids: string[]; dx: number; dy: number; w?: number; h?: number } | null) {
  const now = performance.now()
  if (d && now - broadcastTimer < 50) return
  broadcastTimer = now
  setLocalPresence(board.awareness, { drag: d })
}

function isInteractiveTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('input, textarea, select, button, a[href], [contenteditable="true"], .no-drag, .resize-handle')
}

/** Board rect of a card as currently drawn (before the drag moves it). */
function originalRect(board: Board, id: string): Rect | null {
  const c = board.index.get(id)
  if (!c || c.type === 'line') return null
  if (c.parent && board.index.get(c.parent)?.type === 'column') return elementBoardRect(id)
  return { x: c.x, y: c.y, w: c.w, h: c.h ?? measuredSize(id)?.h ?? elementBoardRect(id)?.h ?? 100 }
}

function onCardPointerDown(e: React.PointerEvent, board: Board, card: Card, inColumn: boolean) {
  // Space held: let the press reach the canvas, which pans.
  if (e.button !== 0 || isSpacePanning()) return
  // Touch on a locked card belongs to the background: the canvas pans, or selects the card on a tap.
  if (e.pointerType === 'touch' && lockedBackgroundCard(e.target)) return
  // Inside a nested card (e.g. a note inside a column) only the innermost shell handles it.
  e.stopPropagation()
  const sel = useSelection.getState()
  const editingThis = sel.editing === card.id
  if (editingThis) return // let the editor handle text selection
  if (isInteractiveTarget(e.target) && sel.selected.has(card.id)) return

  const wasSelected = sel.selected.has(card.id)
  const modifier = e.shiftKey || e.metaKey || e.ctrlKey
  // A locked card acts as background: a click selects it, a drag draws a marquee (Alt-drag copies).
  const background = card.locked === true && !modifier && !board.readOnly

  if (!background) {
    // Shift/Mod on an unselected card adds it right away (so Shift+drag moves the grown selection);
    // on a selected card the toggle waits for the release, and only happens without a drag.
    if (modifier) {
      if (!wasSelected) sel.select([card.id], 'add')
      else if (board.readOnly) sel.select([card.id], 'toggle')
    } else if (!wasSelected) sel.select([card.id])
    if (sel.editing && sel.editing !== card.id) sel.setEditing(null)
    setLocalPresence(board.awareness, { selection: Array.from(useSelection.getState().selected) })
  }

  if (board.readOnly) return
  // Text-like cards: block native text selection while dragging.
  if (!isInteractiveTarget(e.target)) e.preventDefault()

  const press = e.nativeEvent
  const startX = e.clientX
  const startY = e.clientY
  const zoom = useView.getState().viewport.zoom
  const pointerId = e.pointerId
  const target = e.currentTarget as HTMLElement
  let dragging = false
  let cancelled = false
  let ids: string[] = []
  let copy = false
  let axis: Axis | null = null
  let ghosts = new Map<string, Rect>()
  let lastBroadcastCopy = false
  let ghostsFor: { copy: boolean; ids: string[] | null } = { copy: false, ids: null }
  // Comment pinning: where the pointer last came to rest, and the card it rests on.
  let rest = { x: startX, y: startY }
  let restTimer: ReturnType<typeof setTimeout> | null = null
  let attachTo: string | null = null
  // Last pointer position and Shift state, for an Alt press or release without a pointer move.
  let last = { x: startX, y: startY, shift: e.shiftKey }

  const computeIds = (withLocked: boolean) => {
    const selected = Array.from(useSelection.getState().selected)
    // Locked cards stay put (an Alt-drag copies them, though); children of a selected column move
    // with it implicitly; cards in the Unsorted drawer are not on the canvas.
    return selected.filter((sid) => {
      const m = getCardMap(board.doc, sid)
      if (!m || m.get('unsorted') === true) return false
      if (!withLocked && m.get('locked') === true) return false
      const parent = m.get('parent')
      return !(typeof parent === 'string' && selected.includes(parent))
    })
  }

  /** The one free comment being dragged, if that is the whole drag. */
  const draggedComment = () => {
    if (ids.length !== 1) return null
    const c = board.index.get(ids[0])
    return c && c.type === 'comment' && !c.parent ? c.id : null
  }

  const findAttachTarget = (clientX: number, clientY: number): string | null => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const shell = (el as HTMLElement).closest?.('[data-card-id]') as HTMLElement | null
      const cid = shell?.dataset.cardId
      if (!cid || ids.includes(cid)) continue
      const c = board.index.get(cid)
      if (!c || c.unsorted || !isAttachableType(c.type)) return null
      return cid
    }
    return null
  }

  const clearRestTimer = () => {
    if (restTimer) clearTimeout(restTimer)
    restTimer = null
  }

  const armRestTimer = () => {
    clearRestTimer()
    if (copy || !draggedComment()) return
    restTimer = setTimeout(() => {
      restTimer = null
      const d = useDrag.getState().drag
      if (!dragging || cancelled || !d || d.copy) return
      attachTo = findAttachTarget(rest.x, rest.y)
      if (attachTo) useDrag.getState().setDrag({ ...d, target: { kind: 'attach', cardId: attachTo } })
    }, ATTACH_REST_MS)
  }

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('keyup', onKeyUp, true)
    clearRestTimer()
    document.body.classList.remove('is-dragging-cards', 'is-copy-drag')
    useCopyGhosts.getState().set([])
    try {
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
    } catch {
      /* element may be gone */
    }
  }

  const onKey = (ev: KeyboardEvent) => {
    if (!dragging || cancelled) return
    if (ev.key === 'Escape') {
      // Escape cancels the drag (nothing is written) and keeps the board's own Escape out of it.
      ev.preventDefault()
      ev.stopPropagation()
      cancelled = true
      cleanup()
      useDrag.getState().setDrag(null)
      broadcastDrag(board, null)
      return
    }
    // Alt alone switches to copying at once: the preview and cursor follow without a pointer move.
    if (ev.key === 'Alt' && ev.altKey !== copy) update(last.x, last.y, ev.altKey, last.shift)
  }

  const onKeyUp = (ev: KeyboardEvent) => {
    if (ev.key !== 'Alt') return
    // Releasing Alt mid-drag (back to moving) must not open the Windows menu bar.
    ev.preventDefault()
    if (dragging && !cancelled && ev.altKey !== copy) update(last.x, last.y, ev.altKey, last.shift)
  }

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    if (!dragging) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
      if (background && !ev.altKey) {
        // Dragging from a locked card selects like dragging on the empty canvas.
        cleanup()
        startMarqueeFrom(press)
        return
      }
      if (background && !useSelection.getState().selected.has(card.id)) useSelection.getState().select([card.id])
      copy = ev.altKey
      ids = computeIds(copy)
      if (!ids.length) return
      dragging = true
      try {
        target.setPointerCapture(pointerId)
      } catch {
        /* element may be gone */
      }
      board.undo.stopCapturing()
      document.body.classList.add('is-dragging-cards')
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('keyup', onKeyUp, true)
      // Where every card that may take part sits now: the originals an Alt-drag leaves behind.
      ghosts = new Map()
      for (const gid of computeIds(true)) {
        const r = originalRect(board, gid)
        if (r) ghosts.set(gid, r)
      }
      rest = { x: ev.clientX, y: ev.clientY }
      armRestTimer()
    }
    update(ev.clientX, ev.clientY, ev.altKey, ev.shiftKey)
  }

  /** Moves the preview to a pointer position; `alt` picks copying (held) or moving. */
  const update = (clientX: number, clientY: number, alt: boolean, shift: boolean) => {
    last = { x: clientX, y: clientY, shift }
    if (alt !== copy) {
      // Alt pressed or released mid-drag switches between moving and copying.
      copy = alt
      // Locked cards only take part in a copy: a drag of locked cards alone moves nothing without Alt.
      ids = computeIds(copy)
      attachTo = null
      armRestTimer()
    }
    let ddx = (clientX - startX) / zoom
    let ddy = (clientY - startY) / zoom
    // Shift keeps the drag on one axis, picked when Shift goes down and held until it is released.
    if (shift) {
      const locked = axisLock(ddx, ddy, axis)
      ddx = locked.dx
      ddy = locked.dy
      axis = locked.locked
    } else axis = null
    const cx = startX + ddx * zoom
    const cy = startY + ddy * zoom
    const pointer = screenToBoard(cx, cy)
    let dropTarget = findDropTarget(board, cx, cy, ids, pointer)

    if (Math.hypot(clientX - rest.x, clientY - rest.y) >= ATTACH_REST_PX) {
      rest = { x: clientX, y: clientY }
      attachTo = null
      armRestTimer()
    }
    if (attachTo && !copy) dropTarget = { kind: 'attach', cardId: attachTo }

    document.body.classList.toggle('is-copy-drag', copy)
    if (copy !== ghostsFor.copy || ids !== ghostsFor.ids) {
      ghostsFor = { copy, ids }
      useCopyGhosts.getState().set(copy ? ids.map((i) => ghosts.get(i)).filter((r): r is Rect => !!r) : [])
    }
    useDrag.getState().setDrag({ ids, dx: ddx, dy: ddy, target: dropTarget, pointer, fromColumn: inColumn, copy })
    // Peers see copies appear once, on drop; the originals do not move for them.
    if (copy) {
      if (!lastBroadcastCopy) broadcastDrag(board, null)
      lastBroadcastCopy = true
    } else {
      lastBroadcastCopy = false
      broadcastDrag(board, { ids, dx: ddx, dy: ddy })
    }
  }

  const finish = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    // Alt at the drop decides copy or move, also when it changed after the last pointer move.
    if (dragging && !cancelled && ev.type === 'pointerup' && ev.altKey !== copy) update(ev.clientX, ev.clientY, ev.altKey, ev.shiftKey)
    cleanup()
    if (!dragging) {
      if (ev.type !== 'pointerup') return
      const s = useSelection.getState()
      if (background) {
        if (!wasSelected) {
          s.select([card.id])
          setLocalPresence(board.awareness, { selection: [card.id] })
          return
        }
      } else if (shouldToggleOnRelease(wasSelected, modifier, false)) {
        s.select([card.id], 'toggle')
        setLocalPresence(board.awareness, { selection: Array.from(useSelection.getState().selected) })
        return
      }
      // Click on an already-selected editable card enters edit mode (like a second click).
      const def = getDefinition(card.type)
      if (wasSelected && !modifier && def?.editable && s.selected.size === 1) s.setEditing(card.id)
      return
    }
    const d = useDrag.getState().drag
    useDrag.getState().setDrag(null)
    broadcastDrag(board, null)
    if (!d || cancelled || ev.type === 'pointercancel' || !d.ids.length) return
    // Mod held at the drop: no snapping for this drop.
    const bypass = ev.ctrlKey || ev.metaKey
    if (d.copy) {
      commitCopy(board, d, ghosts, bypass, card.id)
      // Alt is still down: its release ends the gesture and must not open the Windows menu bar.
      if (ev.altKey) swallowNextAltKeyup()
    } else commitDrop(board, d.ids, d.dx, d.dy, d.target, d.pointer, bypass)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
}

/** Board ids the dragged cards (with column children) point to; cached per drag (ids array). */
const draggedBoardIds = new WeakMap<readonly string[], ReadonlySet<string>>()
function boardIdsIn(board: Board, ids: string[]): ReadonlySet<string> {
  let set = draggedBoardIds.get(ids)
  if (!set) {
    const out = new Set<string>()
    for (const id of expandSelection(board.doc, ids)) {
      const c = board.index.get(id)?.card
      if (c && c.type === 'board' && c.boardId) out.add(c.boardId)
    }
    draggedBoardIds.set(ids, (set = out))
  }
  return set
}

/** Finds what is under the pointer (excluding the dragged cards). */
function findDropTarget(board: Board, clientX: number, clientY: number, ids: string[], pointer: { x: number; y: number }): DropTarget | null {
  const stack = document.elementsFromPoint(clientX, clientY)
  const dragged = new Set(ids)
  for (const el of stack) {
    const h = el as HTMLElement
    const shell = h.closest?.('[data-card-id]') as HTMLElement | null
    if (shell && dragged.has(shell.dataset.cardId!)) continue
    // Ancestors of a dragged element (e.g. its column) are still valid targets.
    const kind = h.dataset?.drop
    if (kind === 'trash') return { kind: 'trash' }
    if (kind === 'board') {
      const cardId = h.dataset.dropId!
      const c = board.index.get(cardId)?.card
      // Only boards that can actually receive the cards: a valid, known board that is neither this
      // board nor one of the dragged board cards (a board cannot be moved into itself).
      if (
        c &&
        c.type === 'board' &&
        !dragged.has(cardId) &&
        !boardIdsIn(board, ids).has(c.boardId) &&
        isMoveTargetBoard(board.doc, c.boardId)
      )
        return { kind: 'board', cardId, boardId: c.boardId }
      continue
    }
    if (kind === 'crumb') {
      // A breadcrumb in the header: move the cards up to that parent board.
      const boardId = h.dataset.boardId ?? ''
      if (!boardIdsIn(board, ids).has(boardId) && isMoveTargetBoard(board.doc, boardId)) return { kind: 'board', cardId: '', boardId }
      continue
    }
    if (kind === 'column') {
      const columnId = h.dataset.dropId!
      if (dragged.has(columnId)) continue
      // Columns cannot contain columns or lines.
      const movable = ids.filter((i) => {
        const t = board.index.get(i)?.type
        return t && t !== 'column' && t !== 'line'
      })
      if (!movable.length) return null
      const col = board.index.get(columnId)?.card
      if (col && col.type === 'column' && col.collapsed) return { kind: 'column', columnId, index: Number.MAX_SAFE_INTEGER }
      const children = columnChildren(board.doc, columnId).filter((c) => !dragged.has(c))
      let index = children.length
      for (let i = 0; i < children.length; i++) {
        const r = elementBoardRect(children[i])
        if (r && pointer.y < r.y + r.h / 2) {
          index = i
          break
        }
      }
      return { kind: 'column', columnId, index }
    }
  }
  return null
}

function commitDrop(
  board: Board,
  ids: string[],
  dx: number,
  dy: number,
  target: DropTarget | null,
  pointer: { x: number; y: number },
  bypassSnap: boolean,
) {
  const user = getUser()
  const doc = board.doc
  if (target?.kind === 'trash') {
    deleteCards(doc, ids, user.id)
    useSelection.getState().clear()
    return
  }
  if (target?.kind === 'board') {
    void moveIntoBoard(doc, ids, target.boardId)
    return
  }
  if (target?.kind === 'attach') {
    const [comment] = ids
    if (comment && ids.length === 1 && board.index.get(target.cardId)) {
      // A pinned comment leaves its column in the same undoable step, so Ctrl+Z restores it fully.
      updateCard(doc, comment, { attachedTo: target.cardId, parent: null, order: undefined }, user.id, LOCAL_ORIGIN)
      return
    }
  }
  if (target?.kind === 'column') {
    insertIntoColumn(doc, ids, target.columnId, target.index, user.id)
    // Lines or columns in the selection still move normally.
    const rest = ids.filter((i) => {
      const t = getCardMap(doc, i)?.get('type')
      return t === 'column' || t === 'line'
    })
    if (rest.length) moveFree(board, rest, dx, dy, pointer, bypassSnap)
    return
  }
  moveFree(board, ids, dx, dy, pointer, bypassSnap)
}

/** Applies a drag delta to free cards and takes column children out onto the canvas. */
function moveFree(board: Board, ids: string[], dx: number, dy: number, pointer: { x: number; y: number }, bypassSnap: boolean) {
  const user = getUser()
  const doc = board.doc
  const patches: Record<string, Record<string, unknown>> = {}
  let stackY = 0
  for (const id of ids) {
    const m = getCardMap(doc, id)
    if (!m) continue
    const c = readCard(m)
    if (c.type === 'line') {
      patches[id] = {
        from: c.from.card ? c.from : { ...c.from, x: Math.round(c.from.x + dx), y: Math.round(c.from.y + dy) },
        to: c.to.card ? c.to : { ...c.to, x: Math.round(c.to.x + dx), y: Math.round(c.to.y + dy) },
      }
      continue
    }
    if (c.parent) {
      // Leaving a column: drop where the card visually is (its rect moved by the drag delta).
      const r = elementBoardRect(id)
      const x = r ? r.x : pointer.x
      const y = r ? r.y : pointer.y + stackY
      stackY += (r?.h ?? 100) + 10
      patches[id] = { parent: null, x: snap(x, bypassSnap), y: snap(y, bypassSnap), w: c.w }
      continue
    }
    patches[id] = { x: snap(c.x + dx, bypassSnap), y: snap(c.y + dy, bypassSnap) }
  }
  updateCards(doc, patches, user.id)
  bringToFront(doc, ids.filter((i) => !getCardMap(doc, i)?.get('parent')), user.id)
}

/**
 * The cards duplicateCards copies for `ids`, in the order it inserts the copies: the expanded
 * selection, minus lines with an end on a card outside it. Used to pair each copy with its source.
 */
function duplicationSources(board: Board, ids: string[]): string[] {
  const all = expandSelection(board.doc, ids)
  return Array.from(all).filter((id) => {
    const m = getCardMap(board.doc, id)
    if (!m) return false
    if (m.get('type') !== 'line') return true
    const c = readCard(m)
    if (c.type !== 'line') return true
    return (!c.from.card || all.has(c.from.card)) && (!c.to.card || all.has(c.to.card))
  })
}

/**
 * Offset of the copies of an Alt-drag, by the same rule as a move (which snaps each card's position,
 * not the drag delta): the pressed card's copy, or else the first free card's, lands where a move
 * would put that card; the other copies keep their places relative to it. Off-grid originals
 * (pasted, placed by a peer or before snapping was on) thus get copies on the grid.
 */
function copyOffset(board: Board, d: LocalDrag, originals: ReadonlyMap<string, Rect>, pressedId: string, bypassSnap: boolean) {
  const free = (id: string) => {
    const c = board.index.get(id)
    return !!c && c.type !== 'line' && !(c.parent && board.index.get(c.parent)?.type === 'column')
  }
  const anchorId = d.ids.includes(pressedId) && free(pressedId) ? pressedId : d.ids.find(free)
  const a = anchorId ? originals.get(anchorId) : undefined
  if (!a) return { x: snap(d.dx, bypassSnap), y: snap(d.dy, bypassSnap) }
  return { x: snap(a.x + d.dx, bypassSnap) - a.x, y: snap(a.y + d.dy, bypassSnap) - a.y }
}

/**
 * Alt-drag drop: copies the dragged cards in ONE transaction (one undo step) and routes the copies
 * by drop target. The originals never move.
 */
function commitCopy(board: Board, d: LocalDrag, originals: ReadonlyMap<string, Rect>, bypassSnap: boolean, pressedId: string) {
  // Column children in the drag (also when it started on a free card) come out onto the canvas.
  const fromColumn = d.fromColumn || d.ids.some((id) => !!board.index.get(id)?.parent)
  const plan = copyDropPlan(d.target, fromColumn)
  if (plan.kind === 'none') return
  const user = getUser()
  const doc = board.doc
  const { x: dx, y: dy } = copyOffset(board, d, originals, pressedId, bypassSnap)
  const sources = duplicationSources(board, d.ids)
  const dragged = new Set(d.ids)
  board.undo.stopCapturing()
  const forks: BoardFork[] = []
  let copies: string[] = []
  let top: string[] = []
  doc.transact(() => {
    copies = duplicateCards(doc, d.ids, user.id, { x: dx, y: dy }, { forks })
    // Pair copies with their sources (same order); skip pairing if the shapes ever disagree.
    const sourceOf = new Map<string, string>()
    if (copies.length === sources.length) {
      copies.forEach((cid, i) => {
        if (getCardMap(doc, cid)?.get('type') === getCardMap(doc, sources[i])?.get('type')) sourceOf.set(cid, sources[i])
      })
    }
    top = copies.filter((cid) => {
      const src = sourceOf.get(cid)
      return src ? dragged.has(src) : !getCardMap(doc, cid)?.get('parent')
    })
    if (plan.kind === 'canvas' && plan.placeColumnChildren) {
      // Copies of column children land where the dragged shells were dropped, outside the column.
      const positions: Record<string, { x: number; y: number }> = {}
      for (const cid of top) {
        const src = sourceOf.get(cid)
        const r = src ? originals.get(src) : undefined
        if (!r || !getCardMap(doc, cid)?.get('parent')) continue
        positions[cid] = { x: snap(r.x + d.dx, bypassSnap), y: snap(r.y + d.dy, bypassSnap) }
      }
      if (Object.keys(positions).length) placeOnCanvas(doc, positions, user.id)
    }
    if (plan.kind === 'column') {
      // The drop index counts the column's cards without the dragged ones, but the originals stay
      // in it: insert before the same neighbour.
      const copySet = new Set(copies)
      const siblings = columnChildren(doc, plan.columnId).filter((id) => !copySet.has(id))
      const before = siblings.filter((id) => !dragged.has(id))[plan.index]
      const at = before === undefined ? siblings.length : siblings.indexOf(before)
      insertIntoColumn(doc, top, plan.columnId, at, user.id)
    }
    bringToFront(doc, top.filter((cid) => !getCardMap(doc, cid)?.get('parent')), user.id)
  }, LOCAL_ORIGIN)
  void fillForkedBoards(doc.guid, forks)
  if (plan.kind === 'board') {
    void moveIntoBoard(doc, top, plan.boardId)
    return
  }
  useSelection.getState().select(top.length ? top : copies)
}

function onResizePointerDown(e: React.PointerEvent, board: Board, card: Card, both: boolean, keepAspect: boolean) {
  // Space held: let the press reach the canvas, which pans.
  if (e.button !== 0 || isSpacePanning()) return
  e.stopPropagation()
  e.preventDefault()
  const startX = e.clientX
  const startY = e.clientY
  const zoom = useView.getState().viewport.zoom
  const el = (e.currentTarget as HTMLElement).parentElement
  const startW = card.w
  // Width-only cards (images) have no stored h: their rendered height gives the current aspect,
  // so a cropped image keeps its new proportions.
  const startH = card.h ?? el?.offsetHeight ?? 100
  const minW = MIN_WIDTH[card.type] ?? 60
  const pointerId = e.pointerId
  const ids = [card.id]
  board.undo.stopCapturing()

  const calc = (ev: PointerEvent) => {
    const bypass = ev.ctrlKey || ev.metaKey
    // Shift on a freely resizable card (sketch, swatch) keeps its proportions.
    const proportional = keepAspect || (both && ev.shiftKey)
    let w = Math.max(minW, startW + (ev.clientX - startX) / zoom)
    let h = both ? Math.max(40, startH + (ev.clientY - startY) / zoom) : undefined
    w = Math.max(minW, snap(w, bypass))
    if (proportional) h = keepAspectHeight(w, startW, startH)
    else if (h !== undefined) h = snap(h, bypass)
    return { w, h }
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    const { w, h } = calc(ev)
    const drag: LocalDrag = { ids, dx: 0, dy: 0, w, h, target: null, pointer: { x: 0, y: 0 }, fromColumn: false }
    useDrag.getState().setDrag(drag)
    broadcastDrag(board, { ids, dx: 0, dy: 0, w, h })
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    useDrag.getState().setDrag(null)
    broadcastDrag(board, null)
    if (ev.type === 'pointercancel') return
    const { w, h } = calc(ev)
    const patch: Record<string, unknown> = { w }
    // Width-only cards (images keep their aspect) derive height from content; a stored h would go stale.
    if (both && h !== undefined) patch.h = Math.round(h)
    updateCards(board.doc, { [card.id]: patch }, getUser().id)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
}
