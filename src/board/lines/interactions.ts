/**
 * Pointer interactions for lines: selecting and moving lines, dragging endpoints (attach/detach),
 * bending, and drawing new lines from the connector handle or with the line tool.
 * Module-level functions (like CardShell's) so drags never capture stale React state.
 */
import type { BoardContextValue } from '../BoardContext'
import { useContextMenu, useDrag, useSelection, useView } from '../store'
import { getCanvasElement, isSpacePanning, measuredSize, screenToBoard, type Rect } from '../geometry'
import { useCopyGhosts } from '../CopyGhosts'
import { fillForkedBoards, snap } from '../actions'
import { axisLock, shouldToggleOnRelease, type Axis } from '../dragMath'
import { swallowNextAltKeyup } from '../keyboard'
import {
  bringToFront,
  createCard,
  duplicateCards,
  getCardMap,
  LOCAL_ORIGIN,
  updateCard,
  updateCards,
  type BoardFork,
} from '../../model/board'
import type { LineCard, LineEnd } from '../../model/types'
import { getUser } from '../../collab/identity'
import { setLocalPresence } from '../../collab/presence'
import { bendFromMidpoint, resolveLine, type Point } from './geometry'
import { createRectResolver } from './resolve'
import { useLinePreview, type EndName } from './preview'

type Board = BoardContextValue

const DRAG_THRESHOLD = 4
/** Length of the arrow created by a plain click with the line tool or on the connector. */
export const DEFAULT_LINE_LENGTH = 160
const BROADCAST_INTERVAL = 50

// ---------------------------------------------------------------------------
// Helpers

interface Tracker {
  move: (ev: PointerEvent) => void
  up: (ev: PointerEvent) => void
  cancel: () => void
}

/**
 * Follows one pointer until release. Escape (or losing the window) cancels. Pointer capture keeps
 * hover effects and the cursor stable while the pointer crosses cards.
 */
function trackPointer(pointerId: number, t: Tracker, captureEl?: Element | null) {
  try {
    captureEl?.setPointerCapture(pointerId)
  } catch {
    /* element may already be gone */
  }
  const cleanup = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('blur', onBlur)
    try {
      if (captureEl?.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId)
    } catch {
      /* ignore */
    }
  }
  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) t.move(ev)
  }
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return
    cleanup()
    if (ev.type === 'pointercancel') t.cancel()
    else t.up(ev)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    // Keep the board's Escape shortcut (clear selection / leave tool) out of it.
    ev.preventDefault()
    ev.stopPropagation()
    cleanup()
    t.cancel()
  }
  const onBlur = () => {
    cleanup()
    t.cancel()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('blur', onBlur)
}

/**
 * Topmost (innermost) non-line card under a screen point. Stops at UI that sits above the canvas
 * (panels, popovers) so lines never attach to a card hidden behind them.
 */
export function cardAtPoint(board: Board, clientX: number, clientY: number): string | null {
  const canvas = getCanvasElement()
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    if (canvas && !canvas.contains(el)) break
    const shell = (el as HTMLElement).closest?.('[data-card-id]') as HTMLElement | null
    const id = shell?.dataset.cardId
    if (!id) continue
    const c = board.index.get(id)
    if (!c || c.type === 'line') continue
    return id
  }
  return null
}

const roundPoint = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) })

function committedLine(board: Board, id: string): LineCard | null {
  const c = board.index.get(id)?.card
  return c && c.type === 'line' ? c : null
}

function setBodyClass(name: string, on: boolean) {
  document.body.classList.toggle(name, on)
}

// ---------------------------------------------------------------------------
// Selecting and moving lines

export function onLinePointerDown(e: React.PointerEvent, board: Board, lineId: string) {
  if (e.button !== 0 || isSpacePanning()) return
  e.stopPropagation()
  const sel = useSelection.getState()
  const wasSelected = sel.selected.has(lineId)
  const modifier = e.shiftKey || e.metaKey || e.ctrlKey
  // Same rule as cards: Shift/Mod adds an unselected line at once (so Shift+drag moves the grown
  // selection); removing a selected one waits for a release without a drag.
  if (modifier) {
    if (!wasSelected) sel.select([lineId], 'add')
    else if (board.readOnly) sel.select([lineId], 'toggle')
  } else if (!wasSelected) sel.select([lineId])
  if (sel.editing && sel.editing !== lineId) sel.setEditing(null)
  if (board.readOnly) return
  e.preventDefault()
  startGroupMove(board, e.clientX, e.clientY, e.pointerId, () => {
    if (shouldToggleOnRelease(wasSelected, modifier, false)) useSelection.getState().select([lineId], 'toggle')
  })
}

/**
 * Ids that move when a drag starts on a line: the selection minus locked cards (kept when copying),
 * column children and cards in the Unsorted drawer. Lines attached to cards are moved by moving
 * their cards, so a selection made only of attached lines does not move at all.
 */
function movableIds(board: Board, withLocked: boolean): string[] | null {
  const ids = Array.from(useSelection.getState().selected).filter((id) => {
    const c = board.index.get(id)
    return !!c && (withLocked || !c.card.locked) && !c.parent && !c.unsorted
  })
  const movesAsWhole = ids.some((id) => {
    const c = board.index.get(id)!
    if (c.card.type !== 'line') return true
    return !c.card.from.card && !c.card.to.card
  })
  return movesAsWhole ? ids : null
}

/**
 * Moves the selection from a press on a line. Alt/Option copies instead (switchable mid-drag),
 * Shift keeps the movement on one axis, Mod at the drop skips snapping. `onClick` runs when the
 * press ends without a drag.
 */
function startGroupMove(board: Board, startX: number, startY: number, pointerId: number, onClick?: () => void) {
  const zoom = useView.getState().viewport.zoom
  let ids: string[] | null = null
  let blocked = false
  let copy = false
  let axis: Axis | null = null
  let lastBroadcast = 0
  let broadcastCopy = false
  let ghostsShown = false
  // Last pointer position and Shift state, for an Alt press or release without a pointer move.
  let last = { x: startX, y: startY, shift: false }

  // Alt alone switches between moving and copying at once: the preview and cursor follow without a
  // pointer move. Its release must not open the Windows menu bar.
  const onAltDown = (ev: KeyboardEvent) => {
    if (ev.key === 'Alt' && ids && ev.altKey !== copy) update(last.x, last.y, ev.altKey, last.shift)
  }
  const onAltUp = (ev: KeyboardEvent) => {
    if (ev.key !== 'Alt') return
    ev.preventDefault()
    if (ids && ev.altKey !== copy) update(last.x, last.y, ev.altKey, last.shift)
  }

  const end = () => {
    useCopyGhosts.getState().set([])
    useDrag.getState().setDrag(null)
    setLocalPresence(board.awareness, { drag: null })
    setBodyClass('is-dragging-cards', false)
    setBodyClass('is-copy-drag', false)
    window.removeEventListener('keydown', onAltDown, true)
    window.removeEventListener('keyup', onAltUp, true)
  }

  /** Moves the preview to a pointer position; `alt` picks copying (held) or moving. */
  const update = (clientX: number, clientY: number, alt: boolean, shift: boolean) => {
    if (!ids) return
    last = { x: clientX, y: clientY, shift }
    if (alt !== copy) {
      // Locked cards only take part in a copy: without Alt they may leave nothing to move.
      copy = alt
      ids = movableIds(board, copy) ?? []
    }
    let dx = (clientX - startX) / zoom
    let dy = (clientY - startY) / zoom
    if (shift) {
      const locked = axisLock(dx, dy, axis)
      dx = locked.dx
      dy = locked.dy
      axis = locked.locked
    } else axis = null
    setBodyClass('is-copy-drag', copy)
    if (copy !== ghostsShown) {
      ghostsShown = copy
      useCopyGhosts.getState().set(copy ? originalRects(board, ids) : [])
    }
    const pointer = screenToBoard(startX + dx * zoom, startY + dy * zoom)
    useDrag.getState().setDrag({ ids, dx, dy, target: null, pointer, fromColumn: false, copy })
    // Peers see copies appear once, on drop; the originals do not move for them.
    if (copy) {
      if (!broadcastCopy) setLocalPresence(board.awareness, { drag: null })
      broadcastCopy = true
      return
    }
    broadcastCopy = false
    const now = performance.now()
    if (now - lastBroadcast >= BROADCAST_INTERVAL) {
      lastBroadcast = now
      setLocalPresence(board.awareness, { drag: { ids, dx, dy } })
    }
  }

  trackPointer(pointerId, {
    move(ev) {
      if (blocked) return
      if (!ids) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return
        copy = ev.altKey
        ids = movableIds(board, copy)
        if (!ids) {
          blocked = true
          return
        }
        board.undo.stopCapturing()
        setBodyClass('is-dragging-cards', true)
        window.addEventListener('keydown', onAltDown, true)
        window.addEventListener('keyup', onAltUp, true)
      }
      update(ev.clientX, ev.clientY, ev.altKey, ev.shiftKey)
    },
    up(ev) {
      if (!ids) {
        if (!blocked) onClick?.()
        return
      }
      // Alt at the drop decides copy or move, also when it changed after the last pointer move.
      if (ev.altKey !== copy) update(ev.clientX, ev.clientY, ev.altKey, ev.shiftKey)
      const d = useDrag.getState().drag
      end()
      if (!d || !d.ids.length) return
      const bypass = ev.ctrlKey || ev.metaKey
      if (d.copy) {
        commitCopy(board, d.ids, d.dx, d.dy, bypass)
        // Alt is still down: its release ends the gesture and must not open the Windows menu bar.
        if (ev.altKey) swallowNextAltKeyup()
      } else commitMove(board, d.ids, d.dx, d.dy, bypass)
    },
    cancel() {
      if (ids) end()
    },
  })
}

/** Where the free cards of an Alt-drag are now (the originals stay there), for the copy outlines. */
function originalRects(board: Board, ids: readonly string[]): Rect[] {
  const out: Rect[] = []
  for (const id of ids) {
    const c = board.index.get(id)
    if (!c || c.type === 'line' || c.parent) continue
    out.push({ x: c.x, y: c.y, w: c.w, h: c.h ?? measuredSize(id)?.h ?? 100 })
  }
  return out
}

/** Same rules as CardShell's free move: cards snap to the grid, free line ends move exactly. */
function commitMove(board: Board, ids: string[], dx: number, dy: number, bypassSnap: boolean) {
  if (!dx && !dy) return
  const patches: Record<string, Record<string, unknown>> = {}
  for (const id of ids) {
    const c = board.index.get(id)
    if (!c) continue
    const card = c.card
    if (card.type === 'line') {
      patches[id] = {
        from: card.from.card ? card.from : { card: null, x: Math.round(card.from.x + dx), y: Math.round(card.from.y + dy) },
        to: card.to.card ? card.to : { card: null, x: Math.round(card.to.x + dx), y: Math.round(card.to.y + dy) },
      }
    } else {
      patches[id] = { x: snap(c.x + dx, bypassSnap), y: snap(c.y + dy, bypassSnap) }
    }
  }
  updateCards(board.doc, patches, getUser().id)
}

/**
 * Alt-drag drop started on a line: copies the dragged cards and lines at the drag offset in ONE
 * transaction (one undo step) and selects the copies. Only lines move exactly; with cards in the
 * drag the first card's copy lands where a move would put that card (its position snaps, not the
 * delta), and the other copies keep their places relative to it.
 */
function commitCopy(board: Board, ids: string[], dx: number, dy: number, bypassSnap: boolean) {
  const doc = board.doc
  const user = getUser()
  const anchor = ids.map((id) => board.index.get(id)).find((c) => !!c && c.type !== 'line' && !c.parent)
  const offset = anchor
    ? { x: snap(anchor.x + dx, bypassSnap) - anchor.x, y: snap(anchor.y + dy, bypassSnap) - anchor.y }
    : { x: Math.round(dx), y: Math.round(dy) }
  board.undo.stopCapturing()
  const forks: BoardFork[] = []
  let copies: string[] = []
  doc.transact(() => {
    copies = duplicateCards(doc, ids, user.id, offset, { forks })
    bringToFront(doc, copies.filter((id) => !getCardMap(doc, id)?.get('parent')), user.id)
  }, LOCAL_ORIGIN)
  void fillForkedBoards(doc.guid, forks)
  const top = copies.filter((id) => !getCardMap(doc, id)?.get('parent'))
  if (copies.length) useSelection.getState().select(top.length ? top : copies)
}

export function onLineDoubleClick(e: React.MouseEvent, board: Board, lineId: string) {
  e.stopPropagation()
  if (board.readOnly || !committedLine(board, lineId)) return
  useSelection.getState().setEditing(lineId)
}

export function onLineContextMenu(e: React.MouseEvent, lineId: string) {
  e.preventDefault()
  e.stopPropagation()
  const sel = useSelection.getState()
  if (!sel.selected.has(lineId)) sel.select([lineId])
  useContextMenu.getState().open({
    x: e.clientX,
    y: e.clientY,
    kind: 'card',
    ids: Array.from(useSelection.getState().selected),
    at: screenToBoard(e.clientX, e.clientY),
  })
}

// ---------------------------------------------------------------------------
// Endpoint and bend handles

export function onEndpointPointerDown(e: React.PointerEvent, board: Board, lineId: string, end: EndName) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const line = committedLine(board, lineId)
  if (!line || board.readOnly || line.locked) return
  const other = end === 'from' ? line.to.card : line.from.card
  const startX = e.clientX
  const startY = e.clientY
  let moved = false
  let value: LineEnd | null = null

  trackPointer(
    e.pointerId,
    {
      move(ev) {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return
        moved = true
        const p = roundPoint(screenToBoard(ev.clientX, ev.clientY))
        const hit = cardAtPoint(board, ev.clientX, ev.clientY)
        // Both ends on the same card is not allowed: show the line snapping back instead.
        if (hit && hit === other) {
          value = null
          useLinePreview.getState().set({ endpoint: null, target: null })
          return
        }
        value = { card: hit, x: p.x, y: p.y }
        useLinePreview.getState().set({ endpoint: { lineId, end, value }, target: hit })
      },
      up() {
        useLinePreview.getState().reset()
        if (!moved || !value) return
        board.undo.stopCapturing()
        updateCard(board.doc, lineId, { [end]: value }, getUser().id)
      },
      cancel() {
        useLinePreview.getState().reset()
      },
    },
    e.currentTarget,
  )
}

/**
 * Drags the curve's midpoint. `a`/`b` are the current ends and `mid` the current curve midpoint;
 * the grab offset is kept so a handle drawn beside the curve (next to a label) does not jump.
 */
export function onBendPointerDown(e: React.PointerEvent, board: Board, lineId: string, a: Point, b: Point, mid: Point) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  const line = committedLine(board, lineId)
  if (!line || board.readOnly || line.locked) return
  const zoom = useView.getState().viewport.zoom
  const startX = e.clientX
  const startY = e.clientY
  const grab = screenToBoard(startX, startY)
  const gx = grab.x - mid.x
  const gy = grab.y - mid.y
  let moved = false

  trackPointer(
    e.pointerId,
    {
      move(ev) {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return
        moved = true
        const p = screenToBoard(ev.clientX, ev.clientY)
        let bend = bendFromMidpoint(a, b, { x: p.x - gx, y: p.y - gy })
        // Snap back to straight near the chord (curve midpoint within ~6 screen px).
        if (Math.abs(bend) * zoom < 12) bend = 0
        useLinePreview.getState().set({ bend: { lineId, bend } })
      },
      up() {
        const pv = useLinePreview.getState().bend
        useLinePreview.getState().reset()
        if (!moved || !pv) return
        const bend = Math.round(pv.bend)
        if (bend === committedLine(board, lineId)?.bend) return
        board.undo.stopCapturing()
        updateCard(board.doc, lineId, { bend }, getUser().id)
      },
      cancel() {
        useLinePreview.getState().reset()
      },
    },
    e.currentTarget,
  )
}

export function straightenLine(board: Board, lineId: string) {
  const line = committedLine(board, lineId)
  if (!line || board.readOnly || line.locked || !line.bend) return
  board.undo.stopCapturing()
  updateCard(board.doc, lineId, { bend: 0 }, getUser().id)
}

// ---------------------------------------------------------------------------
// Creating lines

/**
 * Creates a line (end arrow, thin, straight) and selects it. Attached ends store their current
 * edge point as the last known position.
 */
export function createLine(board: Board, from: LineEnd, to: LineEnd): string | null {
  if (board.readOnly) return null
  const r = resolveLine({ from, to, bend: 0 }, createRectResolver(board.index))
  const f: LineEnd = { card: from.card, x: Math.round(r.a.x), y: Math.round(r.a.y) }
  const t: LineEnd = { card: to.card, x: Math.round(r.b.x), y: Math.round(r.b.y) }
  board.undo.stopCapturing()
  const id = createCard(board.doc, 'line', { from: f, to: t }, getUser().id)
  useSelection.getState().select([id])
  return id
}

/** A plain arrow pointing right from a card (connector click / keyboard) or from a free point. */
export function createDefaultLine(board: Board, source: string | null, at: Point): string | null {
  if (source) {
    const rect = createRectResolver(board.index)(source)
    if (rect) {
      const to = { card: null, x: Math.round(rect.x + rect.w + DEFAULT_LINE_LENGTH), y: Math.round(rect.y + rect.h / 2) }
      return createLine(board, { card: source, x: to.x, y: to.y }, to)
    }
  }
  const p = roundPoint(at)
  return createLine(board, { card: null, x: p.x, y: p.y }, { card: null, x: p.x + DEFAULT_LINE_LENGTH, y: p.y })
}

export interface DraftOptions {
  board: Board
  pointerId: number
  clientX: number
  clientY: number
  /** Card the line starts from, or null for a free start point. */
  source: string | null
  /** Screen pixels the pointer must travel before it counts as a drag (a click creates a default arrow). */
  minDrag: number
  captureEl?: Element | null
  /** Started by the line tool: switch back to the select tool afterwards. */
  fromTool: boolean
}

/** Drags out a new line, previewing it live; attaches the end to the card it is released over. */
export function startDraftLine(o: DraftOptions) {
  const { board } = o
  const sel = useSelection.getState()
  if (sel.editing) sel.setEditing(null)
  const start = roundPoint(screenToBoard(o.clientX, o.clientY))
  const from: LineEnd = { card: o.source, x: start.x, y: start.y }
  let active = false

  const endAt = (ev: PointerEvent) => {
    const p = roundPoint(screenToBoard(ev.clientX, ev.clientY))
    const hit = cardAtPoint(board, ev.clientX, ev.clientY)
    return { to: { card: hit && hit !== o.source ? hit : null, x: p.x, y: p.y } as LineEnd, hit }
  }
  const done = () => {
    useLinePreview.getState().reset()
    setBodyClass('is-drawing-line', false)
  }
  const finishTool = () => {
    if (o.fromTool) useSelection.getState().setTool('select')
  }

  trackPointer(
    o.pointerId,
    {
      move(ev) {
        if (!active) {
          if (Math.hypot(ev.clientX - o.clientX, ev.clientY - o.clientY) < o.minDrag) return
          active = true
          setBodyClass('is-drawing-line', true)
        }
        const { to } = endAt(ev)
        useLinePreview.getState().set({ draft: { from, to }, target: to.card })
      },
      up(ev) {
        done()
        if (!active) {
          createDefaultLine(board, o.source, start)
          finishTool()
          return
        }
        const { to, hit } = endAt(ev)
        // Released back on the card it started from: nothing to connect.
        if (o.source && hit === o.source) {
          finishTool()
          return
        }
        createLine(board, from, to)
        finishTool()
      },
      cancel() {
        done()
      },
    },
    o.captureEl,
  )
}

export function onConnectorPointerDown(e: React.PointerEvent, board: Board, cardId: string) {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  if (board.readOnly) return
  startDraftLine({
    board,
    pointerId: e.pointerId,
    clientX: e.clientX,
    clientY: e.clientY,
    source: cardId,
    minDrag: DRAG_THRESHOLD,
    captureEl: e.currentTarget,
    fromTool: false,
  })
}
