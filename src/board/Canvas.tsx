/**
 * The infinite canvas: pan (wheel / trackpad / space-drag / middle-drag), zoom (ctrl+wheel / pinch),
 * marquee selection, double-click to add a note, file drops, viewport culling, keyboard focus and
 * screen-reader semantics, and overlays.
 */
import './arrangeActions'
import './canvas.css'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useBoard, useCardIndex } from './BoardContext'
import { CardShell } from './CardShell'
import { clampZoom, useContextMenu, useDrag, usePanels, useSelection, useView, type Viewport } from './store'
import type { CardIndex, IndexedCard } from './cardIndex'
import {
  getCardElement,
  measuredSize,
  normalizeRect,
  rectsIntersect,
  screenToBoard,
  setCanvasElement,
  setMarqueeStarter,
  useLayoutVersion,
  useMeasureVersion,
  visibleBoardRect,
  type Rect,
} from './geometry'
import { allFreeCards, cullCards, useRenderAll } from './culling'
import { isParked } from '../model/board'
import { isActivatableTarget, isTypingTarget } from './keyboard'
import { addCard, setLastPointer, zoomTo } from './actions'
import { useCanvasPrefs } from './prefs'
import { CopyGhosts } from './CopyGhosts'
import { useAnnouncement } from './keyboardNav'
import { CommentPinsLayer, attachmentTarget } from '../cards/structure/commentPins'
import { openImage } from '../cards/media/lightboxStore'
import { getLibraryEntry } from '../collab/library'
import { openBoard } from '../app/router'
import { toast } from '../ui/toast'
import { useBoardTitle } from '../ui/header/BoardTitle'
import { setLocalPresence } from '../collab/presence'
import { RemoteCursors } from './RemoteCursors'
import { LinesLayer } from './lines/LinesLayer'
import { handleCanvasDrop, isFileDrag } from '../cards/media/import'
import { onLineToolPointerDown } from './lines/lineTool'
import { lineInRect } from './lines/resolve'
import { lockedBackgroundCard } from './lockRules'

const CULL_MARGIN = 800
/** Canvas size changes smaller than this (CSS px) do not recompute culling. */
const SIZE_STEP = 50
/** A Space press shorter than this, with no pointer press in between, opens the selected card. */
const SPACE_TAP_MS = 250
/** Grid dots closer than this (screen px) are hidden: they would turn into a grey wash. */
const MIN_DOT_PITCH = 7

/** Space tap on one selected card: open a board, show an image or document full screen. */
function openSelectedCard(index: CardIndex) {
  const sel = useSelection.getState()
  if (sel.selected.size !== 1 || sel.editing || useContextMenu.getState().menu || usePanels.getState().expanded) return
  const c = index.get(sel.selected.values().next().value as string)
  if (!c) return
  const card = c.card
  if (card.type === 'board') {
    if (card.boardId && getLibraryEntry(card.boardId)?.secret) openBoard(card.boardId)
    else toast('This board is not available on this device')
  } else if (card.type === 'image') openImage(c.id)
  else if (card.type === 'document') usePanels.getState().setExpanded(c.id)
}

export function Canvas({ children }: { children?: ReactNode }) {
  const board = useBoard()
  const index = useCardIndex()
  const viewport = useView((s) => s.viewport)
  const ref = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<Rect | null>(null)
  const [spaceDown, setSpaceDown] = useState(false)
  const [panning, setPanning] = useState(false)
  const [fileOver, setFileOver] = useState(false)
  const tool = useSelection((s) => s.tool)
  const dragging = useDrag((s) => !!s.drag)
  const measureVersion = useMeasureVersion((s) => s.version)
  // Rounded canvas size: culling must follow window resizes (e.g. maximising onto a bigger screen).
  const [canvasSize, setCanvasSize] = useState('')
  const showGrid = useCanvasPrefs((s) => s.showGrid)
  const gridSize = useCanvasPrefs((s) => s.gridSize)
  const renderAll = useRenderAll((s) => s.all)
  const kbFocus = useSelection((s) => s.kbFocus)
  const announcement = useAnnouncement((s) => s.text)
  const title = useBoardTitle(board)

  const setRef = useCallback((el: HTMLDivElement | null) => {
    ref.current = el
    setCanvasElement(el)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      setCanvasSize(`${Math.round(el.clientWidth / SIZE_STEP)}x${Math.round(el.clientHeight / SIZE_STEP)}`)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ----- wheel: pan / zoom (non-passive so we can preventDefault)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      // Let scrollable card contents (long notes, document previews) scroll natively.
      const scrollable = (e.target as HTMLElement).closest?.('.scrollable')
      if (scrollable && !e.ctrlKey && !e.metaKey && scrollable.scrollHeight > scrollable.clientHeight) return
      e.preventDefault()
      const { viewport, setViewport } = useView.getState()
      if (e.ctrlKey || e.metaKey) {
        // Pinch-zoom on trackpads arrives as ctrl+wheel with small deltas.
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
        zoomTo(viewport.zoom * factor, { clientX: e.clientX, clientY: e.clientY })
        return
      }
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1
      let dx = e.deltaX * scale
      let dy = e.deltaY * scale
      if (e.shiftKey && !dx) {
        dx = dy
        dy = 0
      }
      setViewport({ ...viewport, x: viewport.x - dx, y: viewport.y - dy })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // ----- touch: one finger on the background pans, two fingers pinch-zoom, double-tap adds a note.
  // Cards still handle their own single-finger drags (their pointerdown stops propagation), except
  // locked cards, which count as background here too.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const touches = new Map<number, { x: number; y: number }>()
    type Gesture =
      | { kind: 'pan'; x: number; y: number; start: Viewport; moved: boolean }
      | { kind: 'pinch'; dist: number; mid: { x: number; y: number }; start: Viewport }
    let gesture: Gesture | null = null
    let lastTap = { t: 0, x: 0, y: 0 }
    // Locked card the current one-finger gesture started on: a tap selects it instead of clearing.
    let tapCard: string | null = null
    // Locked cards act as background: a one-finger drag on one pans like the empty canvas.
    const onBg = (t: EventTarget | null) =>
      t === el || !!(t as HTMLElement | null)?.classList?.contains('world') || lockedBackgroundCard(t) !== null
    const two = () => Array.from(touches.values()).slice(0, 2)
    const startPinch = () => {
      const [a, b] = two()
      gesture = { kind: 'pinch', dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, start: useView.getState().viewport }
    }
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      if (touches.size === 0 && !onBg(e.target)) return // a card drag: leave it alone
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touches.size === 1) {
        gesture = { kind: 'pan', x: e.clientX, y: e.clientY, start: useView.getState().viewport, moved: false }
        tapCard = lockedBackgroundCard(e.target)
      } else if (touches.size === 2) {
        startPinch()
        e.stopPropagation()
      }
    }
    const move = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      const g = gesture
      if (!g) return
      const { setViewport } = useView.getState()
      if (g.kind === 'pan') {
        const dx = e.clientX - g.x
        const dy = e.clientY - g.y
        if (!g.moved && Math.hypot(dx, dy) < 6) return
        g.moved = true
        setViewport({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
      } else if (touches.size >= 2) {
        const [a, b] = two()
        const r = el.getBoundingClientRect()
        const zoom = clampZoom(g.start.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist))
        const mid = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top }
        // Keep the board point that was under the starting midpoint under the fingers.
        const bx = (g.mid.x - r.left - g.start.x) / g.start.zoom
        const by = (g.mid.y - r.top - g.start.y) / g.start.zoom
        setViewport({ x: mid.x - bx * zoom, y: mid.y - by * zoom, zoom })
      }
    }
    const up = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return
      const g = gesture
      touches.delete(e.pointerId)
      if (touches.size === 1) {
        // Lifting one finger of a pinch continues as a pan with the other.
        const [rest] = Array.from(touches.values())
        gesture = { kind: 'pan', x: rest.x, y: rest.y, start: useView.getState().viewport, moved: true }
        return
      }
      if (touches.size > 0) return
      gesture = null
      if (g?.kind !== 'pan' || g.moved || e.type === 'pointercancel') return
      const sel = useSelection.getState()
      if (tapCard && board.index.get(tapCard)) {
        // A tap on a locked card selects it, as a click does (and never counts towards a double tap).
        if (sel.editing && sel.editing !== tapCard) sel.setEditing(null)
        sel.select([tapCard])
        setLocalPresence(board.awareness, { selection: [tapCard] })
        lastTap = { t: 0, x: 0, y: 0 }
        return
      }
      // A tap on the background: clear the selection; a quick second tap adds a note.
      if (sel.editing) sel.setEditing(null)
      sel.clear()
      const now = performance.now()
      if (now - lastTap.t < 350 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30 && !board.readOnly) {
        const p = screenToBoard(e.clientX, e.clientY)
        addCard(board.doc, 'note', {}, { at: { x: p.x - 20, y: p.y - 20 }, edit: true, centered: false })
        lastTap = { t: 0, x: 0, y: 0 }
      } else lastTap = { t: now, x: e.clientX, y: e.clientY }
    }
    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [board])

  // ----- space to pan; a quick tap opens the selected card instead
  useEffect(() => {
    let tapStart = 0
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return
      // Typing, or Space on a focused button/link/menu item: that control handles it.
      if (isTypingTarget(e.target) || isActivatableTarget(e.target)) return
      e.preventDefault()
      tapStart = performance.now()
      setSpaceDown(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      setSpaceDown(false)
      const tapped = tapStart > 0 && performance.now() - tapStart <= SPACE_TAP_MS
      tapStart = 0
      if (tapped) openSelectedCard(board.index)
    }
    // Any press while Space is down makes it a pan, never a tap.
    const press = () => {
      tapStart = 0
    }
    // The keyup never arrives when focus leaves the window while Space is held.
    const release = () => {
      tapStart = 0
      setSpaceDown(false)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') release()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('pointerdown', press, true)
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('pointerdown', press, true)
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [board.index])

  // ----- keyboard focus ring: any pointer press hands control back to the mouse
  useEffect(() => {
    const clear = () => useSelection.getState().setKbFocus(null)
    window.addEventListener('pointerdown', clear, true)
    return () => window.removeEventListener('pointerdown', clear, true)
  }, [])

  // aria-activedescendant only while the focused card is in the DOM (it may be culled or remounting).
  const layoutVersion = useLayoutVersion((s) => s.version)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (kbFocus && getCardElement(kbFocus)?.isConnected) el.setAttribute('aria-activedescendant', `card-${kbFocus}`)
    else el.removeAttribute('aria-activedescendant')
  }, [kbFocus, layoutVersion])

  // ----- pointer presence (throttled)
  const lastSent = useRef(0)
  const onPointerMove = (e: React.PointerEvent) => {
    const p = screenToBoard(e.clientX, e.clientY)
    setLastPointer(p)
    const now = performance.now()
    if (now - lastSent.current > 60) {
      lastSent.current = now
      setLocalPresence(board.awareness, { pointer: { x: Math.round(p.x), y: Math.round(p.y) } })
    }
  }
  const onPointerLeave = () => {
    setLastPointer(null)
    setLocalPresence(board.awareness, { pointer: null })
  }

  // ----- background pointer down: pan or marquee
  // Browsers may also emit dblclick for a double tap; touch double-taps are handled above.
  const lastPointerType = useRef('mouse')
  const onPointerDown = (e: React.PointerEvent) => {
    lastPointerType.current = e.pointerType
    const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
    if (e.button === 1 || (e.button === 0 && spaceDown)) {
      startPan(e)
      return
    }
    if (!onBackground || e.button !== 0) return
    // Touch on the background pans (handled above) instead of drawing a marquee.
    if (e.pointerType === 'touch' && tool !== 'line') return
    if (tool === 'line' && !board.readOnly) {
      onLineToolPointerDown(e, board)
      return
    }
    // Keyboard navigation (Tab, Alt+Arrow) works from the canvas element.
    ref.current?.focus({ preventScroll: true })
    beginMarquee(e.nativeEvent)
  }

  /** Leaves edit mode, clears the selection unless extending it, and starts a marquee at the press. */
  const beginMarquee = (e: PointerEvent) => {
    const sel = useSelection.getState()
    if (sel.editing) sel.setEditing(null)
    const additive = e.shiftKey || e.metaKey || e.ctrlKey
    if (!additive) sel.clear()
    setLocalPresence(board.awareness, { selection: Array.from(useSelection.getState().selected), editing: null })
    startMarquee(e, additive)
  }
  const beginMarqueeRef = useRef(beginMarquee)
  beginMarqueeRef.current = beginMarquee
  // Locked cards act as background: a drag that starts on one draws a marquee (see CardShell).
  useEffect(() => {
    setMarqueeStarter((e) => beginMarqueeRef.current(e))
    return () => setMarqueeStarter(null)
  }, [])

  const startPan = (e: React.PointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const start = useView.getState().viewport
    setPanning(true)
    const move = (ev: PointerEvent) => {
      useView.getState().setViewport({ ...start, x: start.x + ev.clientX - startX, y: start.y + ev.clientY - startY })
    }
    const up = () => {
      setPanning(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startMarquee = (e: PointerEvent, additive: boolean) => {
    const start = screenToBoard(e.clientX, e.clientY)
    const base = additive ? new Set(useSelection.getState().selected) : new Set<string>()
    let moved = false
    const move = (ev: PointerEvent) => {
      const p = screenToBoard(ev.clientX, ev.clientY)
      const r = normalizeRect(start.x, start.y, p.x, p.y)
      if (!moved && r.w * useView.getState().viewport.zoom < 4 && r.h * useView.getState().viewport.zoom < 4) return
      moved = true
      setMarquee(r)
      const hits = new Set(base)
      const lookup = (id: string) => board.index.get(id)
      for (const c of board.index.getSnapshot()) {
        if (inLiveColumn(board.index, c) || isPinned(board.index, c) || isParked(lookup, c.id)) continue
        if (c.card.type === 'line') {
          // Lines are picked up when both resolved ends are inside the marquee.
          if (lineInRect(board, c.card, r)) hits.add(c.id)
          continue
        }
        const cr = cardRect(c.id, c.type, c.x, c.y, c.w, c.h, c.card)
        if (cr && rectsIntersect(r, cr)) hits.add(c.id)
      }
      useSelection.getState().select(hits)
    }
    const up = () => {
      setMarquee(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) setLocalPresence(board.awareness, { selection: Array.from(useSelection.getState().selected) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (board.readOnly || lastPointerType.current === 'touch') return
    const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
    if (!onBackground) return
    const p = screenToBoard(e.clientX, e.clientY)
    addCard(board.doc, 'note', {}, { at: { x: p.x - 20, y: p.y - 20 }, edit: true, centered: false })
  }

  const onContextMenu = (e: React.MouseEvent) => {
    const onBackground = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('world')
    if (!onBackground) return
    e.preventDefault()
    useContextMenu.getState().open({ x: e.clientX, y: e.clientY, kind: 'canvas', ids: [], at: screenToBoard(e.clientX, e.clientY) })
  }

  // ----- culling: only render free cards near the viewport (all of them while exporting)
  const visible = useMemo(() => {
    const lookup = (id: string) => board.index.get(id)
    if (renderAll) return allFreeCards(index, lookup)
    const v = visibleBoardRect(viewport)
    const m = CULL_MARGIN / viewport.zoom
    const area = { x: v.x - m, y: v.y - m, w: v.w + 2 * m, h: v.h + 2 * m }
    return cullCards(index, area, lookup, measuredSize)
    // Recompute when the viewport moves by a meaningful amount (not on every pixel), when the canvas
    // is resized, and when cards get measured for the first time (their height was unknown).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, Math.round(viewport.x / 200), Math.round(viewport.y / 200), Math.round(viewport.zoom * 20), canvasSize, measureVersion, renderAll])

  // Cards being dragged, edited, open full-screen or focused by keyboard stay mounted even if culled.
  const dragIds = useDrag((s) => s.drag?.ids)
  const editing = useSelection((s) => s.editing)
  const expanded = usePanels((s) => s.expanded)
  const rendered = useMemo(() => {
    const keep = [...(dragIds ?? []), editing, expanded, kbFocus].filter((id): id is string => !!id)
    const set = new Set(visible)
    const lookup = (id: string) => board.index.get(id)
    const extra = keep.filter((id) => {
      const c = board.index.get(id)
      return !!c && !set.has(id) && c.type !== 'line' && !inLiveColumn(board.index, c) && !isParked(lookup, id) && (set.add(id), true)
    })
    const all = extra.length ? [...visible, ...extra] : visible
    // Comments pinned to a card are drawn by the comment pins layer, not as cards.
    const pinned = new Set(
      all.filter((id) => {
        const c = board.index.get(id)
        return !!c && isPinned(board.index, c)
      }),
    )
    return pinned.size ? all.filter((id) => !pinned.has(id)) : all
    // `index` changes whenever a card changes, which is when a pin target may have appeared or gone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dragIds, editing, expanded, kbFocus, board.index, index])

  // Dot grid follows pan/zoom with the snap step; hidden when off or when the dots get too dense.
  // The gradient draws each dot in the middle of its tile: shifting the tiles by half a pitch puts
  // the dots on multiples of gridSize, the points snapping rounds card corners to.
  const grid = gridSize * viewport.zoom
  const gridStyle =
    showGrid && grid >= MIN_DOT_PITCH
      ? {
          backgroundSize: `${grid}px ${grid}px`,
          backgroundPosition: `${viewport.x - grid / 2}px ${viewport.y - grid / 2}px`,
        }
      : { backgroundImage: 'none' }

  return (
    <div
      ref={setRef}
      tabIndex={0}
      role="application"
      aria-roledescription="board"
      aria-label={title}
      className={[
        'canvas',
        spaceDown && 'is-space',
        panning && 'is-panning',
        dragging && 'is-dragging',
        tool !== 'select' && `tool-${tool}`,
        fileOver && 'is-file-over',
      ]
        .filter(Boolean)
        .join(' ')}
      style={gridStyle}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (board.readOnly || e.defaultPrevented || isEditableTarget(e.target) || !isFileDrag(e.dataTransfer)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!fileOver) setFileOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setFileOver(false)
      }}
      onDrop={(e) => {
        setFileOver(false)
        // Text dropped inside a card editor is handled by the editor itself.
        if (board.readOnly || e.defaultPrevented || isEditableTarget(e.target)) return
        e.preventDefault()
        const p = screenToBoard(e.clientX, e.clientY)
        void handleCanvasDrop(board.doc, e.dataTransfer, p)
      }}
    >
      <div
        className="world"
        style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        data-zoom={viewport.zoom < 0.5 ? 'far' : viewport.zoom < 0.8 ? 'mid' : 'near'}
      >
        {rendered.map((id) => (
          <CardShell key={id} id={id} />
        ))}
        <CopyGhosts />
        <LinesLayer />
        <CommentPinsLayer />
        <RemoteCursors />
        {children}
      </div>
      {marquee && <MarqueeBox rect={marquee} />}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  )
}

/** A comment pinned to another card (drawn as a pin on that card, not as a card of its own). */
function isPinned(index: CardIndex, c: IndexedCard): boolean {
  return c.type === 'comment' && attachmentTarget(c.card, (id) => index.get(id)) !== null
}

/** A card shown inside a column (as opposed to an orphan whose column was deleted concurrently). */
function inLiveColumn(index: CardIndex, c: IndexedCard): boolean {
  return !!c.parent && index.get(c.parent)?.type === 'column'
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el?.closest?.('[contenteditable="true"], input, textarea')
}

function MarqueeBox({ rect }: { rect: Rect }) {
  const v = useView((s) => s.viewport)
  return (
    <div
      className="marquee"
      style={{ left: rect.x * v.zoom + v.x, top: rect.y * v.zoom + v.y, width: rect.w * v.zoom, height: rect.h * v.zoom }}
    />
  )
}

/** Board-space rect of a free card using stored or measured size. */
export function cardRect(id: string, _type: string, x: number, y: number, w: number, h: number | undefined, _card?: unknown): Rect {
  return { x, y, w, h: h ?? measuredSize(id)?.h ?? 100 }
}
