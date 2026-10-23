import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type * as Y from 'yjs'
import { PenLine } from 'lucide-react'
import type { CardProps } from '../types'
import type { CardMap, SketchCard as SketchCardData, SketchStroke } from '../../model/types'
import { DEFAULT_SIZE } from '../../model/types'
import { useBoard, useYVersion } from '../../board/BoardContext'
import { useSelection, useView } from '../../board/store'
import { newId } from '../../model/ids'
import { isHex6 } from './color'
import { clearStrokes, getStrokesArray, pushStroke, removeStrokes } from './sketchDoc'
import {
  clampToMargin,
  clientToSketch,
  finalizePoints,
  INK,
  MAX_STROKE_POINTS,
  MAX_STROKE_SIZE,
  MIN_STROKE_SIZE,
  pointerPressure,
  readStrokes,
  round2,
  stepPenSize,
  strokePathData,
  strokesHit,
  validDim,
  type ParsedStroke,
} from './sketchMath'
import { SketchToolStrip, type SketchMode } from './SketchToolStrip'
import './sketch.css'

/** Eraser reach around the pointer, in screen pixels (matches the eraser cursor). */
const ERASER_SCREEN_RADIUS = 8
/** Taps right after entering edit mode are the tail of the double-click, not dots. */
const EDIT_GRACE_MS = 400
/** Screen pixels a press may wobble and still count as a tap. */
const TAP_SLOP = 3

interface LiveStroke {
  pointerId: number
  erasing: boolean
  points: number[]
  color: string
  /** Stroke size in drawing units. */
  size: number
  last: { x: number; y: number }
  startClient: { x: number; y: number }
  /** Moved further than a tap would. */
  moved: boolean
  startedAt: number
  /** Board units per drawing unit, fixed for the gesture. */
  kx: number
  ky: number
  zoom: number
  erased: Set<string>
}

/** Strokes this person drew per card during this session, for "Undo stroke". */
const sessionStrokes = new Map<string, string[]>()

/** The card's strokes Y.Array; follows the field if a peer ever replaces it. */
function useStrokesArray(map: CardMap): Y.Array<unknown> | null {
  const store = useMemo(
    () => ({
      subscribe: (cb: () => void) => {
        const h = (e: Y.YMapEvent<unknown>) => {
          if (e.keysChanged.has('strokes')) cb()
        }
        map.observe(h)
        return () => map.unobserve(h)
      },
      get: () => getStrokesArray(map),
    }),
    [map],
  )
  return useSyncExternalStore(store.subscribe, store.get)
}

/**
 * Freehand sketch. Strokes are stored in drawing units (vw × vh), so the drawing scales with the
 * card. Not editing: strokes sit directly on the canvas. Editing: a translucent drawing surface
 * plus a floating tool strip; each finished stroke is pushed to the shared Y.Array once.
 */
export function SketchCard({ id, card, map, selected, editing, inColumn, readOnly, stopEditing }: CardProps<SketchCardData>) {
  const board = useBoard()
  const arr = useStrokesArray(map)
  const version = useYVersion(arr)
  const strokes = useMemo(() => (arr ? readStrokes(arr.toArray()) : []), [arr, version])
  const strokeIds = useMemo(() => new Set(strokes.map((s) => s.id)), [strokes])
  const vw = validDim(card.vw, card.w)
  const vh = validDim(card.vh, card.h ?? DEFAULT_SIZE.sketch.h ?? 300)
  const canEdit = editing && !readOnly

  const storeColor = useSelection((s) => s.penColor)
  const storeSize = useSelection((s) => s.penSize)
  const penColor = isHex6(storeColor) ? storeColor : INK
  const penSize = Number.isFinite(storeSize) && storeSize > 0 ? Math.min(storeSize, 64) : 4

  const [mode, setMode] = useState<SketchMode>('pen')
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const live = useRef<LiveStroke | null>(null)
  const [, setFrame] = useState(0)
  const frameReq = useRef(0)
  const editStartedAt = useRef(0)

  // Pointer handlers run between renders: read the latest strokes through a ref.
  const latestStrokes = useRef(strokes)
  latestStrokes.current = strokes

  const sessionKey = `${board.boardId}:${id}`

  useEffect(() => {
    if (canEdit) editStartedAt.current = performance.now()
    else setMode('pen')
  }, [canEdit])

  useEffect(() => () => cancelAnimationFrame(frameReq.current), [])

  const scheduleFrame = () => {
    if (frameReq.current) return
    frameReq.current = requestAnimationFrame(() => {
      frameReq.current = 0
      setFrame((f) => f + 1)
    })
  }

  const commitStroke = (s: LiveStroke, dot: boolean) => {
    const points = finalizePoints(s.points, { dot })
    if (!points) return
    const stroke: SketchStroke = { id: newId(), points, color: s.color, size: round2(s.size) }
    // Each stroke is its own undo step, however quickly the next one follows.
    board.undo.stopCapturing()
    pushStroke(board.doc, map, stroke)
    const list = sessionStrokes.get(sessionKey) ?? []
    list.push(stroke.id)
    if (list.length > 500) list.splice(0, list.length - 500)
    sessionStrokes.set(sessionKey, list)
  }

  const toLocal = (clientX: number, clientY: number, rect: DOMRect) => {
    const p = clientToSketch(clientX, clientY, rect, vw, vh)
    return clampToMargin(p.x, p.y, vw, vh)
  }

  const erase = (s: LiveStroke, a: { x: number; y: number }, b: { x: number; y: number }) => {
    const hits = strokesHit(latestStrokes.current, a.x, a.y, b.x, b.y, {
      tolerance: ERASER_SCREEN_RADIUS / s.zoom,
      kx: s.kx,
      ky: s.ky,
    }).filter((sid) => !s.erased.has(sid))
    if (!hits.length) return
    for (const sid of hits) s.erased.add(sid)
    removeStrokes(board.doc, map, hits)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canEdit) return // not editing: the shell selects / drags the card
    const penEraser = e.pointerType === 'pen' && (e.button === 5 || (e.buttons & 32) !== 0)
    if (e.button !== 0 && !penEraser) return // middle-drag still pans, right-click opens the menu
    e.stopPropagation()
    e.preventDefault()
    if (live.current) return // ignore a second finger / pen while drawing
    const el = e.currentTarget
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
    const rect = el.getBoundingClientRect()
    const zoom = useView.getState().viewport.zoom || 1
    const boardW = Math.max(1e-6, rect.width / zoom)
    const boardH = Math.max(1e-6, rect.height / zoom)
    const kx = boardW / vw
    const ky = boardH / vh
    const p = toLocal(e.clientX, e.clientY, rect)
    const erasing = mode === 'eraser' || penEraser
    const s: LiveStroke = {
      pointerId: e.pointerId,
      erasing,
      points: erasing ? [] : [p.x, p.y, pointerPressure(e.pointerType, e.pressure)],
      color: penColor,
      // Pen sizes are in board units; convert so strokes look the same however the card was resized.
      size: Math.min(MAX_STROKE_SIZE, Math.max(MIN_STROKE_SIZE, penSize / ((kx + ky) / 2))),
      last: p,
      startClient: { x: e.clientX, y: e.clientY },
      moved: false,
      startedAt: performance.now(),
      kx,
      ky,
      zoom,
      erased: new Set(),
    }
    live.current = s
    board.undo.stopCapturing()
    if (erasing) erase(s, p, p)
    else scheduleFrame()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = live.current
    if (!s || e.pointerId !== s.pointerId) return
    const el = surfaceRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const native = e.nativeEvent
    // Coalesced events keep fast pen strokes smooth on high-frequency digitizers.
    const coalesced = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : []
    const events = coalesced.length ? coalesced : [native]
    for (const ev of events) {
      const p = toLocal(ev.clientX, ev.clientY, rect)
      if (p.x === s.last.x && p.y === s.last.y) continue
      if (!s.moved && Math.hypot(ev.clientX - s.startClient.x, ev.clientY - s.startClient.y) > TAP_SLOP) s.moved = true
      if (s.erasing) erase(s, s.last, p)
      else {
        const pressure = pointerPressure(ev.pointerType, ev.pressure)
        s.points.push(p.x, p.y, pressure)
        if (s.points.length >= MAX_STROKE_POINTS * 3) {
          // Very long stroke: store it and continue seamlessly with a new one.
          commitStroke(s, false)
          s.points = [p.x, p.y, pressure]
        }
      }
      s.last = p
    }
    if (!s.erasing) scheduleFrame()
  }

  const finish = (e: React.PointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const s = live.current
    if (!s || e.pointerId !== s.pointerId) return
    live.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    if (!s.erasing && !cancelled) {
      const doubleClickTail = !s.moved && s.startedAt - editStartedAt.current < EDIT_GRACE_MS
      // A press that never really moved is stored as a dot.
      if (!doubleClickTail) commitStroke(s, true)
    }
    scheduleFrame()
  }

  const undoStroke = () => {
    const list = sessionStrokes.get(sessionKey)
    if (!list) return
    while (list.length) {
      const sid = list.pop()!
      if (strokeIds.has(sid)) {
        board.undo.stopCapturing()
        removeStrokes(board.doc, map, [sid])
        break
      }
    }
  }

  const clearAll = () => {
    board.undo.stopCapturing()
    clearStrokes(board.doc, map)
  }

  const setPen = useSelection((s) => s.setPen)

  // Drawing shortcuts. Capture phase so board quick-add letters and Delete don't fire meanwhile.
  useEffect(() => {
    if (!canEdit) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const k = e.key.toLowerCase()
      if (k === 'e') setMode((m) => (m === 'eraser' ? 'pen' : 'eraser'))
      else if (k === 'p') setMode('pen')
      else if (k === '[' || k === ']') {
        const { penSize: cur, setPen: set } = useSelection.getState()
        set({ size: stepPenSize(cur, k === ']' ? 1 : -1) })
        setMode('pen')
      } else if (k !== 'delete' && k !== 'backspace') return
      // Delete/Backspace are swallowed so a stray key press can't remove the drawing being made.
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canEdit])

  const canUndo = !!sessionStrokes.get(sessionKey)?.some((sid) => strokeIds.has(sid))

  const l = live.current
  const livePath = l && !l.erasing && l.points.length ? strokePathData(l.points, l.size, false) : ''
  const empty = strokes.length === 0 && !livePath

  // Sketches normally have an explicit height; old/malformed cards fall back to the drawing's aspect.
  // In a column the width is the column's, so the height follows the drawing's aspect too (the
  // stored height would stretch it; sketch.css lets the shell grow with it).
  const rootStyle: CSSProperties = card.h === undefined || inColumn ? { aspectRatio: `${vw} / ${vh}` } : { height: '100%' }

  const className = [
    'sketch-card',
    selected && 'is-selected',
    canEdit && 'is-editing',
    canEdit && mode === 'eraser' && 'is-erasing',
    empty && 'is-empty',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div ref={setRoot} className={className} style={rootStyle}>
      <div
        ref={surfaceRef}
        className="sketch-card__surface"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onLostPointerCapture={(e) => finish(e, false)}
        onDoubleClick={canEdit ? (e) => e.stopPropagation() : undefined}
      >
        <svg
          className="sketch-card__svg"
          viewBox={`0 0 ${vw} ${vh}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          role="img"
          aria-label={strokes.length ? `Sketch with ${strokes.length} stroke${strokes.length === 1 ? '' : 's'}` : 'Empty sketch'}
        >
          <StrokePaths strokes={strokes} />
          {livePath && <path d={livePath} className={l!.color === INK ? 'is-ink' : undefined} fill={l!.color === INK ? undefined : l!.color} />}
        </svg>
        {empty && !canEdit && (
          <div className="sketch-card__empty">
            <PenLine size={18} aria-hidden="true" />
            <span>{readOnly ? 'Empty sketch' : 'Double-click to draw'}</span>
          </div>
        )}
        {empty && canEdit && (
          <div className="sketch-card__hint" aria-hidden="true">
            Draw here
          </div>
        )}
      </div>
      {canEdit && root && (
        <SketchToolStrip
          anchor={root}
          mode={mode}
          onMode={setMode}
          color={penColor}
          size={penSize}
          onPen={setPen}
          canUndo={canUndo}
          onUndo={undoStroke}
          canClear={strokes.length > 0}
          onClear={clearAll}
          onDone={stopEditing}
        />
      )}
    </div>
  )
}

/** Committed strokes (memoized: the live stroke re-renders every frame while drawing). */
const StrokePaths = memo(function StrokePaths({ strokes }: { strokes: ParsedStroke[] }) {
  const seen = new Map<string, number>()
  return (
    <>
      {strokes.map((s) => {
        // Peers could send duplicate ids; keep React keys unique anyway.
        const n = seen.get(s.id) ?? 0
        seen.set(s.id, n + 1)
        const ink = s.color === INK
        return <path key={n ? `${s.id}~${n}` : s.id} d={s.d} className={ink ? 'is-ink' : undefined} fill={ink ? undefined : s.color} />
      })}
    </>
  )
})
