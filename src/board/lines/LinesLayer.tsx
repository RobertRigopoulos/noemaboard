/**
 * Renders all line/arrow cards of the board in board coordinates (inside the transformed world):
 * an SVG below the cards with every line, their labels, and an overlay above the cards with the
 * selected line's handles, the connector handle of a selected card and the label editor.
 * Lines follow cards live while they are dragged here or on a teammate's screen.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import { Plus } from 'lucide-react'
import { useBoard, useCardIndex } from '../BoardContext'
import { useDrag, useSelection, useView, type LocalDrag } from '../store'
import type { IndexedCard } from '../cardIndex'
import { useLayoutVersion } from '../geometry'
import { isParked, updateCard } from '../../model/board'
import type { LineCard } from '../../model/types'
import { getUser } from '../../collab/identity'
import {
  chordNormal,
  cleanLabel,
  dashArray,
  linePaths,
  lineStyle,
  MAX_LABEL_LENGTH,
  resolveLine,
  type LinePaths,
  type LineStyle,
  type Point,
  type Rect,
  type ResolvedLine,
} from './geometry'
import { createRectResolver, type CardOffset, type OffsetMap, type RectResolver } from './resolve'
import { usePeerLineState } from './peerState'
import { useLinePreview } from './preview'
import {
  createDefaultLine,
  onBendPointerDown,
  onConnectorPointerDown,
  onEndpointPointerDown,
  onLineContextMenu,
  onLineDoubleClick,
  onLinePointerDown,
  straightenLine,
} from './interactions'
import { useLineToolOnCards } from './lineTool'
import './lines.css'

type Board = ReturnType<typeof useBoard>

interface LineModel {
  id: string
  line: LineCard
  geo: ResolvedLine
  paths: LinePaths
  style: LineStyle
  /** Changes whenever anything drawn changes; memoised views compare only this. */
  sig: string
}

const DRAFT_ID = '__draft'
const DRAFT_DEFAULTS = { bend: 0, color: null, thickness: 2, dashed: false, arrowStart: false, arrowEnd: true, label: '' }

function buildModel(id: string, line: LineCard, resolver: RectResolver, offset: CardOffset | undefined): LineModel {
  const style = lineStyle(line)
  const geo = resolveLine(line, resolver, offset ?? null)
  const straight = !(Number.isFinite(line.bend) && line.bend !== 0)
  const paths = linePaths(geo, { thickness: style.thickness, arrowStart: style.arrowStart, arrowEnd: style.arrowEnd, straight })
  const sig = [paths.full, paths.stroke, paths.arrows, style.color, style.thickness, style.dashed, style.label].join('|')
  return { id, line, geo, paths, style, sig }
}

function mergeOffsets(local: LocalDrag | null, remote: OffsetMap, index: Board['index']): OffsetMap {
  if (!local) return remote
  const merged = new Map(remote)
  const o: CardOffset = { dx: local.dx, dy: local.dy }
  if (local.w !== undefined) o.w = local.w
  if (local.h !== undefined) o.h = local.h
  for (const id of local.ids) {
    // An Alt-drag leaves the original cards in place, so lines attached to them stay put; dragged
    // lines still show where their copies will land.
    if (local.copy && index.get(id)?.type !== 'line') continue
    merged.set(id, o)
  }
  return merged
}

/**
 * A line with an end on a card that is parked with the Unsorted drawer (in it, in a column that is,
 * or a comment pinned to such a card). It comes back when that card leaves the drawer.
 */
function offCanvas(index: Board['index'], c: IndexedCard): boolean {
  return isParked((id) => index.get(id), c.id)
}

const rectKey = (r: Rect | null) => (r ? `${Math.round(r.x * 2)},${Math.round(r.y * 2)},${Math.round(r.w * 2)},${Math.round(r.h * 2)}` : '-')

function domKey(resolver: RectResolver, ids: Iterable<string>): string {
  const parts: string[] = []
  for (const id of ids) parts.push(`${id}:${rectKey(resolver(id))}`)
  return parts.join(';')
}

export function LinesLayer() {
  const board = useBoard()
  const index = useCardIndex()
  const layoutVersion = useLayoutVersion((s) => s.version)
  const localDrag = useDrag((s) => s.drag)
  const peers = usePeerLineState(board.awareness, board.index)
  const endpoint = useLinePreview((s) => s.endpoint)
  const bend = useLinePreview((s) => s.bend)
  const draft = useLinePreview((s) => s.draft)
  const target = useLinePreview((s) => s.target)
  const selected = useSelection((s) => s.selected)
  const editing = useSelection((s) => s.editing)
  const tool = useSelection((s) => s.tool)
  const zoom = useView((s) => s.viewport.zoom)
  // Bumped when rects read from the DOM (cards inside columns) changed after the cards committed.
  const [domFix, bumpDomFix] = useReducer((x: number) => x + 1, 0)

  useLineToolOnCards(board, tool)

  const lines = useMemo(() => index.filter((c) => c.card.type === 'line' && !offCanvas(board.index, c)), [index, board.index])
  const offsets = useMemo(() => mergeOffsets(localDrag, peers.drags, board.index), [localDrag, peers.drags, board.index])

  const computed = useMemo(() => {
    void layoutVersion
    void domFix
    const resolver = createRectResolver(board.index, offsets)
    const models: LineModel[] = []
    for (const c of lines) {
      if (c.card.type !== 'line') continue
      let line: LineCard = c.card
      if (endpoint?.lineId === c.id) line = { ...line, [endpoint.end]: endpoint.value }
      if (bend?.lineId === c.id) line = { ...line, bend: bend.bend }
      models.push(buildModel(c.id, line, resolver, offsets.get(c.id)))
    }
    let draftModel: LineModel | null = null
    if (draft) {
      const line = { ...DRAFT_DEFAULTS, id: DRAFT_ID, type: 'line', from: draft.from, to: draft.to } as unknown as LineCard
      draftModel = buildModel(DRAFT_ID, line, resolver, undefined)
    }
    const domIds = Array.from(resolver.domIds)
    return { models, draftModel, resolver, domIds, domKey: domKey(resolver, domIds) }
  }, [lines, offsets, endpoint, bend, draft, board.index, layoutVersion, domFix])

  // Cards inside columns are measured from the DOM, which this render may have read before the
  // cards themselves committed (e.g. a column moved). Re-check after commit; converges in one pass.
  const fixes = useRef({ count: 0, frame: 0 })
  useLayoutEffect(() => {
    if (!computed.domIds.length) return
    const fresh = createRectResolver(board.index, offsets)
    if (domKey(fresh, computed.domIds) === computed.domKey) return
    const f = fixes.current
    if (f.count > 3) return
    f.count++
    if (!f.frame)
      f.frame = requestAnimationFrame(() => {
        f.count = 0
        f.frame = 0
      })
    bumpDomFix()
  })
  useEffect(() => () => cancelAnimationFrame(fixes.current.frame), [])

  const byId = useMemo(() => new Map(computed.models.map((m) => [m.id, m])), [computed.models])

  // ----- overlay state
  const single = selected.size === 1 ? (selected.values().next().value as string) : null
  const singleLine = single ? byId.get(single) ?? null : null
  const editingLine = editing && !board.readOnly ? byId.get(editing) ?? null : null
  const handlesFor = singleLine && !board.readOnly && !singleLine.line.locked && !localDrag ? singleLine : null

  let connector: { id: string; at: Point } | null = null
  if (single && !singleLine && !editing && !board.readOnly && !localDrag && !draft && tool === 'select') {
    const c = board.index.get(single)
    if (c && c.card.type !== 'line' && !c.parent) {
      const r = computed.resolver(single)
      // Clear of the card's width-resize grip (6 board units outside the edge) at any zoom.
      if (r) connector = { id: single, at: { x: r.x + r.w + 6 + 15 / zoom, y: r.y + r.h / 2 } }
    }
  }
  const targetRect = target ? computed.resolver(target) : null

  return (
    <>
      <svg className="lines-layer" width="1" height="1" style={{ '--line-hit': `${12 / zoom}px` } as CSSProperties} aria-hidden>
        {computed.models.map((m) => (
          <LineView key={m.id} board={board} model={m} selected={selected.has(m.id)} peerColor={peers.selectedBy.get(m.id) ?? null} interactive />
        ))}
        {computed.draftModel && (
          <LineView board={board} model={computed.draftModel} selected={false} peerColor={null} interactive={false} />
        )}
      </svg>
      <div className="lines-labels">
        {computed.models.map((m) =>
          m.style.label && editingLine?.id !== m.id && !m.paths.degenerate ? (
            <LineLabel
              key={m.id}
              board={board}
              id={m.id}
              text={m.style.label}
              x={m.paths.mid.x}
              y={m.paths.mid.y}
              selected={selected.has(m.id)}
            />
          ) : null,
        )}
      </div>
      <div className="lines-overlay">
        <svg className="lines-overlay__svg" width="1" height="1">
          {targetRect && (
            <rect
              className="line-attach-target"
              x={targetRect.x - 4 / zoom}
              y={targetRect.y - 4 / zoom}
              width={targetRect.w + 8 / zoom}
              height={targetRect.h + 8 / zoom}
              rx={6 / zoom}
              strokeWidth={2 / zoom}
            />
          )}
          {handlesFor && <LineHandles board={board} model={handlesFor} zoom={zoom} showBend={editingLine?.id !== handlesFor.id} />}
        </svg>
        {connector && <ConnectorHandle board={board} cardId={connector.id} at={connector.at} zoom={zoom} />}
        {editingLine && <LabelEditor key={editingLine.id} board={board} lineId={editingLine.id} initial={editingLine.style.label} at={editingLine.paths.mid} />}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------

interface LineViewProps {
  board: Board
  model: LineModel
  selected: boolean
  peerColor: string | null
  interactive: boolean
}

const LineView = memo(
  function LineView({ board, model, selected, peerColor, interactive }: LineViewProps) {
    const { paths, style } = model
    if (paths.degenerate && !interactive) return null
    const className = [
      'noema-line',
      !interactive && 'noema-line--draft',
      selected && 'is-selected',
      peerColor && !selected && 'is-peer-selected',
    ]
      .filter(Boolean)
      .join(' ')
    const vars = { '--line-color': style.color, '--line-t': style.thickness, '--peer-color': peerColor ?? undefined } as CSSProperties
    return (
      <g className={className} style={vars} data-line-id={interactive ? model.id : undefined}>
        <path className="noema-line__halo" d={paths.full} strokeWidth={style.thickness + 8} />
        <path
          className="noema-line__stroke"
          d={paths.stroke}
          strokeWidth={style.thickness}
          strokeDasharray={style.dashed ? dashArray(style.thickness) : undefined}
        />
        {paths.arrows && <path className="noema-line__arrow" d={paths.arrows} />}
        {interactive && (
          <path
            className="noema-line__hit"
            d={paths.full}
            onPointerDown={(e) => onLinePointerDown(e, board, model.id)}
            onDoubleClick={(e) => onLineDoubleClick(e, board, model.id)}
            onContextMenu={(e) => onLineContextMenu(e, model.id)}
          />
        )}
      </g>
    )
  },
  (a, b) =>
    a.model.sig === b.model.sig &&
    a.selected === b.selected &&
    a.peerColor === b.peerColor &&
    a.interactive === b.interactive &&
    a.board === b.board,
)

const LineLabel = memo(function LineLabel({
  board,
  id,
  text,
  x,
  y,
  selected,
}: {
  board: Board
  id: string
  text: string
  x: number
  y: number
  selected: boolean
}) {
  return (
    <div
      className={`line-label${selected ? ' is-selected' : ''}`}
      style={{ left: x, top: y }}
      title={text.length > 30 ? text : undefined}
      onPointerDown={(e) => onLinePointerDown(e, board, id)}
      onDoubleClick={(e) => onLineDoubleClick(e, board, id)}
      onContextMenu={(e) => onLineContextMenu(e, id)}
    >
      {text}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Overlay: handles, connector, label editor

function LineHandles({ board, model, zoom, showBend }: { board: Board; model: LineModel; zoom: number; showBend: boolean }) {
  const s = 1 / zoom
  const { a, b } = model.geo
  let mid = model.paths.mid
  if (model.style.label) {
    // Keep the label readable: sit the bend handle just outside the label pill, on the bulge side.
    const n = chordNormal(a, b)
    if (n) {
      const side = model.line.bend < 0 ? -1 : 1
      const off = side * (12 + 8 * s)
      mid = { x: mid.x + n.x * off, y: mid.y + n.y * off }
    }
  }
  return (
    <g
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <EndHandle
        at={a}
        s={s}
        attached={!!model.line.from.card}
        label="Line start: drag to move, or drop on a card to connect"
        onPointerDown={(e) => onEndpointPointerDown(e, board, model.id, 'from')}
      />
      <EndHandle
        at={b}
        s={s}
        attached={!!model.line.to.card}
        label="Line end: drag to move, or drop on a card to connect"
        onPointerDown={(e) => onEndpointPointerDown(e, board, model.id, 'to')}
      />
      {showBend && !model.paths.degenerate && (
        <g
          className="line-handle line-handle--bend"
          transform={`translate(${mid.x} ${mid.y})`}
          onPointerDown={(e) => onBendPointerDown(e, board, model.id, a, b, model.paths.mid)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            straightenLine(board, model.id)
          }}
        >
          <title>Drag to curve the line, double-click to straighten</title>
          <circle className="line-handle__hit" r={9 * s} />
          <circle className="line-handle__dot" r={4 * s} strokeWidth={1.5 * s} />
        </g>
      )}
    </g>
  )
}

function EndHandle({
  at,
  s,
  attached,
  label,
  onPointerDown,
}: {
  at: Point
  s: number
  attached: boolean
  label: string
  onPointerDown: (e: React.PointerEvent) => void
}) {
  return (
    <g
      className={`line-handle line-handle--end${attached ? ' is-attached' : ''}`}
      transform={`translate(${at.x} ${at.y})`}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <title>{label}</title>
      <circle className="line-handle__hit" r={10 * s} />
      <circle className="line-handle__dot" r={5.5 * s} strokeWidth={2 * s} />
    </g>
  )
}

function ConnectorHandle({ board, cardId, at, zoom }: { board: Board; cardId: string; at: Point; zoom: number }) {
  return (
    <button
      type="button"
      className="line-connector"
      style={{ left: at.x, top: at.y, transform: `translate(-50%, -50%) scale(${1 / zoom})` }}
      aria-label="Connect to another card with a line"
      title="Drag to another card to connect it (click to add an arrow)"
      onPointerDown={(e) => onConnectorPointerDown(e, board, cardId)}
      onClick={(e) => {
        // Pointer clicks are handled on pointer-up; this is the keyboard path (Enter / Space).
        if (e.detail === 0) createDefaultLine(board, cardId, at)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Plus size={13} strokeWidth={2.5} aria-hidden />
    </button>
  )
}

function LabelEditor({ board, lineId, initial, at }: { board: Board; lineId: string; initial: string; at: Point }) {
  const [value, setValue] = useState(initial)
  const valueRef = useRef(initial)
  // The label when editing started: only a real change is written (and becomes an undo step).
  const initialRef = useRef(initial)
  const done = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const commit = useCallback(() => {
    if (done.current) return
    done.current = true
    const next = cleanLabel(valueRef.current).trim()
    if (next === initialRef.current) return
    board.undo.stopCapturing()
    updateCard(board.doc, lineId, { label: next }, getUser().id)
  }, [board, lineId])
  const stopEditing = () => {
    const sel = useSelection.getState()
    if (sel.editing === lineId) sel.setEditing(null)
  }

  useEffect(() => {
    done.current = false
    const el = inputRef.current
    el?.focus()
    el?.select()
    // Leaving edit mode by clicking elsewhere unmounts the input before it blurs: save then.
    return commit
  }, [commit])

  return (
    <input
      ref={inputRef}
      className="line-label-input"
      style={{ left: at.x, top: at.y, width: `${Math.min(40, Math.max(8, value.length + 3))}ch` }}
      value={value}
      maxLength={MAX_LABEL_LENGTH}
      placeholder="Label"
      aria-label="Line label"
      spellCheck
      onChange={(e) => {
        valueRef.current = e.target.value
        setValue(e.target.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
          stopEditing()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          done.current = true
          stopEditing()
        }
      }}
      onBlur={() => {
        commit()
        stopEditing()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    />
  )
}
