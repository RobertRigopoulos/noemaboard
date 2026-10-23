/**
 * Comment pins: comments attached to a card render as small markers on the card's top-right corner
 * instead of as free cards. The layer lives inside the canvas `.world`, so markers pan and zoom with
 * the board (scaled to stay readable); a marker opens its thread in a floating popover, and dragging
 * a marker moves the thread to another card, back onto the canvas, or into the trash.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
} from '@floating-ui/react'
import { MessageSquare } from 'lucide-react'
import * as Y from 'yjs'
import { useBoard, useCard, useCardIndex, useCardMap, useYVersion, type BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { cardBounds, getCanvasElement, screenToBoard, useLayoutVersion, type Rect } from '../../board/geometry'
import { isInDrag, useDrag, useSelection, useView } from '../../board/store'
import { snap } from '../../board/actions'
import { deleteCards, getCardMap, isTrashed, SYSTEM_ORIGIN, updateCard, updateCards, xmlToText } from '../../model/board'
import type { CommentCard as CommentData } from '../../model/types'
import { getUser } from '../../collab/identity'
import { keepControlKeys } from '../../ui/keyGuard'
import { getDefinition } from '../registry'
import { discardEmptyCard } from '../text/discardEmpty'
import { CommentThread, remindUnsent } from './CommentCard'
import { attachmentTarget, groupPins, isAttachableType, isUnsortedCard, MARKER_SIZE, markerPositions, markerScale, type PinEntry } from './attach'
import { draftKey, hasUnsentText } from './commentDrafts'
import { cleanTitle, countLabel } from './helpers'
import { takeFreshPin, usePins } from './pinStore'
import { hiddenReason } from './reveal'
import { getThread, readThread, showsMarker } from './thread'
import './comment.css'

export { attachmentTarget } from './attach'

const DRAG_THRESHOLD = 4
const LABEL_MAX = 40

/** Short description of a card for marker labels: 'note "Groceries"', 'image "beach.jpg"'. */
function targetLabel(board: BoardContextValue, t: IndexedCard): string {
  const fields = t.card as unknown as Record<string, unknown>
  let text = ''
  for (const k of ['title', 'name', 'label', 'url', 'hex']) {
    const v = fields[k]
    if (typeof v === 'string' && v.trim()) {
      text = v
      break
    }
  }
  if (!text) {
    const m = getCardMap(board.doc, t.id)
    const frag = m?.get('content') ?? m?.get('caption')
    if (frag instanceof Y.XmlFragment) text = xmlToText(frag).split('\n')[0] ?? ''
  }
  const type = (getDefinition(t.type)?.label ?? 'card').toLocaleLowerCase()
  const clean = cleanTitle(text, LABEL_MAX)
  return clean ? `${type} "${clean}"` : type
}

/**
 * Closes the open popover after the person dismissed it: an unsent reply is offered for sending
 * (and a fresh pin stays fresh), and a pin left without any message is removed again when this
 * person made it, a moment ago or in an earlier session.
 */
export function closePinWithChecks(board: BoardContextValue, commentId: string) {
  usePins.getState().closePin()
  if (board.readOnly) return
  const key = draftKey(board.boardId, commentId)
  if (hasUnsentText(key)) {
    remindUnsent(board.doc, commentId, key)
    return
  }
  const fresh = takeFreshPin(commentId)
  const map = getCardMap(board.doc, commentId)
  if (!map || isTrashed(map) || readThread(getThread(map)).length) return
  const me = getUser().id
  if (fresh || map.get('createdBy') === me) discardEmptyCard(board.doc, board.undo, commentId, me)
}

/**
 * Where keyboard focus goes after a thread closed from inside its popover: back to its marker, or,
 * when the pin is gone (an empty pin discarded, the thread deleted), to the card it was on, so the
 * person keeps their place on the board.
 */
function focusAfterClose(board: BoardContextValue, commentId: string, targetId: string, anchor: HTMLElement) {
  const m = getCardMap(board.doc, commentId)
  if (m && !isTrashed(m) && m.get('attachedTo') === targetId && anchor.isConnected) {
    anchor.focus({ preventScroll: true })
    return
  }
  getCanvasElement()?.focus({ preventScroll: true })
  if (!board.index.get(targetId)) return
  const sel = useSelection.getState()
  sel.select([targetId])
  sel.setKbFocus(targetId)
}

/** Mounted by the canvas inside `.world`. */
export function CommentPinsLayer() {
  const board = useBoard()
  const index = useCardIndex()
  const zoom = useView((s) => s.viewport.zoom)
  // Card sizes (and the positions of cards inside columns) change without an index change.
  const layoutVersion = useLayoutVersion((s) => s.version)
  const drag = useDrag((s) => s.drag)
  const open = usePins((s) => s.open)
  const openId = open?.commentId ?? null

  const { groups, inColumn } = useMemo(() => {
    const entries: PinEntry[] = []
    const stale: string[] = []
    for (const c of index) {
      if (c.type !== 'comment') continue
      const target = attachmentTarget(c.card, (id) => board.index.get(id))
      if (!target) continue
      entries.push({ id: c.id, target, createdAt: c.card.createdAt })
      if (c.parent) stale.push(c.id)
    }
    return { groups: groupPins(entries), inColumn: stale }
  }, [index, board.index])

  // A pinned comment that still names a column as its parent (an attach by an older version, or a
  // drop that only set attachedTo) leaves the column: the column does not draw it, and keeping it
  // there would skew drop positions and keyboard reordering, which count the column's children.
  useEffect(() => {
    if (board.readOnly || !inColumn.length) return
    const patches: Record<string, Record<string, unknown>> = {}
    for (const id of inColumn) patches[id] = { parent: null, order: undefined }
    updateCards(board.doc, patches, getUser().id, SYSTEM_ORIGIN)
  }, [inColumn, board])

  // An open thread closes when it is no longer pinned (detached elsewhere, deleted, target gone), or
  // when its card is folded away (a collapsed column): it would pop up again on expand.
  useEffect(() => {
    if (!openId) return
    for (const [targetId, ids] of groups) {
      if (!ids.includes(openId)) continue
      const t = board.index.get(targetId)
      const reason = t ? hiddenReason(board, t) : 'unsorted'
      // A read-only viewer may peek into a collapsed column, which then draws its cards after all.
      if (t && (!reason || (reason === 'collapsed' && cardBounds(t)))) return
      closePinWithChecks(board, openId)
      return
    }
    usePins.getState().closePin()
  }, [openId, groups, board])

  // Empty threads started by someone else get no marker (they are still being written).
  const shown = useMemo(() => {
    const me = getUser().id
    const out = new Map<string, string[]>()
    for (const [targetId, ids] of groups) {
      const keep = ids.filter((id) => {
        if (id === openId) return true
        const m = getCardMap(board.doc, id)
        return !!m && showsMarker(m, me)
      })
      if (keep.length) out.set(targetId, keep)
    }
    return out
    // The index changes with every message (they touch the card's updatedAt).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, index, openId, board])

  const labels = useMemo(() => {
    const out = new Map<string, string>()
    for (const targetId of shown.keys()) {
      const t = board.index.get(targetId)
      if (t) out.set(targetId, targetLabel(board, t))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, index, board])

  const scale = markerScale(zoom)
  const markers: React.ReactNode[] = []
  for (const [targetId, ids] of shown) {
    const t = board.index.get(targetId)
    // In the Unsorted drawer: not on the canvas. (A card in a collapsed column has no rect.)
    if (!t || hiddenReason(board, t) === 'unsorted') continue
    let rect: Rect | null = cardBounds(t)
    if (!rect) continue
    // Markers ride along with a moved card (a copy-drag leaves the original, and its pins, in place).
    if (drag && !drag.copy && !t.parent && isInDrag(drag, targetId)) rect = { ...rect, x: rect.x + drag.dx, y: rect.y + drag.dy }
    const positions = markerPositions(rect, ids.length, scale)
    ids.forEach((id, i) =>
      markers.push(
        <PinMarker
          key={id}
          commentId={id}
          targetId={targetId}
          label={labels.get(targetId) ?? 'card'}
          x={positions[i].x}
          y={positions[i].y}
          scale={scale}
          isOpen={openId === id}
          focusComposer={openId === id && !!open?.focusComposer}
        />,
      ),
    )
  }
  void layoutVersion

  if (!markers.length) return null
  return (
    <div className="cmt-pins" onKeyDown={keepControlKeys}>
      {markers}
    </div>
  )
}

type DropResult = { kind: 'attach'; id: string } | { kind: 'detach' } | { kind: 'trash' } | null

/** What a marker dropped at a screen point lands on: a card, empty canvas, the trash, or nothing. */
function dropTargetAt(board: BoardContextValue, commentId: string, clientX: number, clientY: number): DropResult {
  const canvas = getCanvasElement()
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const h = el as HTMLElement
    if (h.closest?.('.cmt-pin')) continue
    if (h.dataset?.drop === 'trash') return { kind: 'trash' }
    const shell = h.closest?.('[data-card-id]') as HTMLElement | null
    if (shell) {
      const id = shell.dataset.cardId ?? ''
      const c = board.index.get(id)
      if (c && id !== commentId && isAttachableType(c.type) && !isUnsortedCard(c.card)) return { kind: 'attach', id }
      continue
    }
    if (canvas && (h === canvas || canvas.contains(h))) return { kind: 'detach' }
    return null
  }
  return null
}

interface MarkerProps {
  commentId: string
  targetId: string
  label: string
  x: number
  y: number
  scale: number
  isOpen: boolean
  focusComposer: boolean
}

const PinMarker = memo(function PinMarker({ commentId, targetId, label, x, y, scale, isOpen, focusComposer }: MarkerProps) {
  const board = useBoard()
  const map = useCardMap(commentId)
  const card = useCard(commentId) as CommentData | undefined
  const thread = map ? getThread(map) : null
  const version = useYVersion(thread)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => readThread(thread), [thread, version])
  const [button, setButton] = useState<HTMLButtonElement | null>(null)
  const [dragAt, setDragAt] = useState<{ x: number; y: number } | null>(null)
  const [hover, setHover] = useState<Rect | null>(null)
  const dragged = useRef(false)

  const count = messages.length
  const resolved = card?.resolved === true
  const ring = messages[0]?.authorColor
  const ariaLabel = `Comment thread on ${label}, ${countLabel(count, 'message')}${resolved ? ', resolved' : ''}`

  const toggle = () => {
    if (dragged.current) {
      dragged.current = false
      return
    }
    if (isOpen) {
      closePinWithChecks(board, commentId)
      // A marker pressed from the keyboard may have just been removed with its empty pin.
      if (button && document.activeElement === button) focusAfterClose(board, commentId, targetId, button)
    } else usePins.getState().openPin(commentId)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    dragged.current = false
    if (board.readOnly) return
    const startX = e.clientX
    const startY = e.clientY
    const pointerId = e.pointerId
    const el = e.currentTarget
    let dragging = false
    let result: DropResult = null

    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('keydown', onKey, true)
      setDragAt(null)
      setHover(null)
    }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) <= DRAG_THRESHOLD) return
        dragging = true
        dragged.current = true
        try {
          el.setPointerCapture(pointerId)
        } catch {
          /* the marker may be gone */
        }
        if (usePins.getState().open?.commentId === commentId) usePins.getState().closePin()
      }
      const p = screenToBoard(ev.clientX, ev.clientY)
      setDragAt({ x: p.x - MARKER_SIZE / 2, y: p.y - MARKER_SIZE / 2 })
      result = dropTargetAt(board, commentId, ev.clientX, ev.clientY)
      const t = result?.kind === 'attach' ? board.index.get(result.id) : undefined
      setHover(t ? cardBounds(t) : null)
    }
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      cleanup()
      if (!dragging || ev.type === 'pointercancel') return
      result = dropTargetAt(board, commentId, ev.clientX, ev.clientY)
      commitDrop(board, commentId, targetId, result, screenToBoard(ev.clientX, ev.clientY))
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !dragging) return
      ev.preventDefault()
      ev.stopPropagation()
      cleanup()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('keydown', onKey, true)
  }

  const style = {
    left: dragAt?.x ?? x,
    top: dragAt?.y ?? y,
    '--pin-scale': scale,
    ...(ring ? { '--pin-ring': ring } : null),
  } as CSSProperties

  return (
    <>
      {hover && <div className="cmt-pin-drop" style={{ left: hover.x, top: hover.y, width: hover.w, height: hover.h }} aria-hidden />}
      <button
        ref={setButton}
        type="button"
        className={`cmt-pin${resolved ? ' is-resolved' : ''}${isOpen ? ' is-open' : ''}${dragAt ? ' is-dragging' : ''}${ring ? ' has-ring' : ''}`}
        style={style}
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
        onClick={toggle}
      >
        <MessageSquare size={14} strokeWidth={2} aria-hidden />
        {count > 1 && (
          <span className="cmt-pin__count" aria-hidden>
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {isOpen && button && card && map && !dragAt && (
        <PinPopover board={board} commentId={commentId} targetId={targetId} card={card} map={map} anchor={button} focusComposer={focusComposer} />
      )}
    </>
  )
})

function commitDrop(board: BoardContextValue, commentId: string, currentTarget: string, result: DropResult, at: { x: number; y: number }) {
  if (!result) return
  const userId = getUser().id
  board.undo.stopCapturing()
  if (result.kind === 'attach') {
    // A pinned comment is never a column child (a column would count it without drawing it).
    if (result.id !== currentTarget) updateCard(board.doc, commentId, { attachedTo: result.id, parent: null, order: undefined }, userId)
  } else if (result.kind === 'detach') {
    updateCard(board.doc, commentId, { attachedTo: null, parent: null, x: snap(at.x - MARKER_SIZE / 2), y: snap(at.y - MARKER_SIZE / 2) }, userId)
    takeFreshPin(commentId)
    useSelection.getState().select([commentId])
  } else {
    deleteCards(board.doc, [commentId], userId)
  }
  board.undo.stopCapturing()
}

interface PopoverProps {
  board: BoardContextValue
  commentId: string
  targetId: string
  card: CommentData
  map: Y.Map<unknown>
  anchor: HTMLElement
  focusComposer: boolean
}

function PinPopover({ board, commentId, targetId, card, map, anchor, focusComposer }: PopoverProps) {
  const [editing, setEditing] = useState(focusComposer)
  const dialogRef = useRef<HTMLDivElement | null>(null)

  const requestClose = useCallback(() => closePinWithChecks(board, commentId), [board, commentId])

  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) requestClose()
    },
    elements: { reference: anchor },
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      offset(10),
      flip({ padding: 8, fallbackPlacements: ['left-start', 'bottom', 'top'] }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(180, availableHeight)}px`
        },
      }),
    ],
    // The canvas pans with CSS transforms, which only an animation-frame loop notices.
    whileElementsMounted: (reference, floating, update) => autoUpdate(reference, floating, update, { animationFrame: true }),
  })
  const dismiss = useDismiss(context, {
    // Escape is handled below (it must not reach the board, which would clear the selection).
    escapeKey: false,
    // The mention list is portaled on its own: picking from it is not an outside press.
    outsidePress: (e) => !(e.target as Element | null)?.closest?.('.cmt-mention'),
  })
  const { getFloatingProps } = useInteractions([dismiss])

  const setFloating = useCallback(
    (el: HTMLDivElement | null) => {
      dialogRef.current = el
      refs.setFloating(el)
    },
    [refs],
  )

  const detach = () => {
    const t = board.index.get(targetId)
    const r = t ? cardBounds(t) : null
    board.undo.stopCapturing()
    updateCard(
      board.doc,
      commentId,
      { attachedTo: null, parent: null, ...(r ? { x: snap(r.x + r.w + 20), y: snap(r.y) } : null) },
      getUser().id,
    )
    board.undo.stopCapturing()
    takeFreshPin(commentId)
    usePins.getState().closePin()
    useSelection.getState().select([commentId])
  }

  return (
    <FloatingPortal>
      {/* Focus goes back to the marker on Escape (below); after a click elsewhere it stays there. */}
      <FloatingFocusManager context={context} modal={false} initialFocus={focusComposer ? -1 : dialogRef} returnFocus={false} closeOnFocusOut={false}>
        <div
          ref={setFloating}
          style={floatingStyles}
          className="cmt-pop"
          role="dialog"
          aria-label="Comment thread"
          tabIndex={-1}
          {...getFloatingProps({
            onKeyDown: (e) => {
              // Keys typed here never reach the board shortcuts (Delete, arrows, Escape...).
              e.stopPropagation()
              if (e.key === 'Escape' && !e.defaultPrevented) {
                e.preventDefault()
                requestClose()
                focusAfterClose(board, commentId, targetId, anchor)
              }
            },
            // React events bubble through portals: keep them away from the marker and the canvas.
            onPointerDown: (e) => e.stopPropagation(),
            onDoubleClick: (e) => e.stopPropagation(),
            onContextMenu: (e) => e.stopPropagation(),
          })}
        >
          <CommentThread
            id={commentId}
            card={card}
            map={map}
            selected
            editing={editing}
            inColumn={false}
            readOnly={board.readOnly}
            startEditing={() => setEditing(true)}
            stopEditing={() => setEditing(false)}
            variant="popover"
            onDetach={detach}
            onClose={() => {
              usePins.getState().closePin()
              focusAfterClose(board, commentId, targetId, anchor)
            }}
          />
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  )
}
