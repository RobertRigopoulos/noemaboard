/**
 * The board's Unsorted drawer: cards moved into this board (and, on Home, boards shared with you)
 * wait here until someone drags them onto the canvas or into a column. A side panel on wide
 * windows, a bottom sheet on narrow ones.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownToLine, Inbox, Trash2, X } from 'lucide-react'
import { useCardIndex, type BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { viewCenter } from '../../board/actions'
import { elementBoardRect, getCanvasElement, measuredSize, screenToBoard } from '../../board/geometry'
import { useDrag, usePanels, useSelection } from '../../board/store'
import { CARD_DEFINITIONS } from '../../cards/registry'
import { useBlobUrl } from '../../collab/blobs'
import { getUser } from '../../collab/identity'
import { columnChildren, deleteCards, insertIntoColumn, LOCAL_ORIGIN, restoreTrashEntry } from '../../model/board'
import { isBlobHash } from '../../model/blobRefs'
import { placeFromUnsorted } from '../../model/unsorted'
import { estimateCardHeight } from '../../templates/writer'
import { COLUMN_CHILD_TYPES, type CardType } from '../../model/types'
import { BoardIcon } from '../icons/BoardIcon'
import { cardText } from '../search/collect'
import { computeDropIndex } from '../toolbar/dropIndex'
import { toast } from '../toast'
import { actionIds, clickSelect, EMPTY_SELECTION, moveFocus, pruneSelection, type ListSelection } from './unsortedSelection'
import './panels.css'

const DRAG_THRESHOLD = 5
/** The ghost's top-left sits this far up-left of the pointer; drops place the cards there. */
const GHOST_OFFSET = 14

/** Drawer cards in drawer order, from the reactive card index. */
export function useUnsortedCards(ctx: BoardContextValue): IndexedCard[] {
  const all = useCardIndex()
  return useMemo(
    () =>
      all
        .filter((c) => c.unsorted && !c.parent && c.type !== 'line')
        .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1)),
    // ctx.index identity is stable per board; `all` is its snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [all, ctx.index],
  )
}

export function UnsortedPanel({ ctx }: { ctx: BoardContextValue }) {
  const open = usePanels((s) => s.panel === 'unsorted')
  const presenting = usePanels((s) => s.presenting)
  if (!open || presenting) return null
  return <UnsortedPanelBody ctx={ctx} />
}

interface RowInfo {
  id: string
  type: CardType
  title: string
  kind: string
  /** Image thumbnail blob. */
  thumb: string | null
  boardIcon: string | null
}

function describe(ctx: BoardContextValue, c: IndexedCard): RowInfo {
  const def = CARD_DEFINITIONS[c.type]
  const raw = c.card as unknown as Record<string, unknown>
  const m = ctx.cards.get(c.id)
  let title = ''
  try {
    title = (m && cardText(m)?.title) || ''
  } catch {
    title = ''
  }
  if (c.type === 'board') title = (typeof raw.title === 'string' && raw.title.trim()) || 'Untitled board'
  const thumbRaw = c.type === 'image' ? (isBlobHash(raw.thumb) ? raw.thumb : isBlobHash(raw.blob) ? raw.blob : null) : null
  return {
    id: c.id,
    type: c.type,
    title: title.replace(/\s+/g, ' ').trim().slice(0, 140) || def?.label || 'Card',
    kind: def?.label ?? 'Card',
    thumb: thumbRaw,
    boardIcon: c.type === 'board' && typeof raw.icon === 'string' ? raw.icon : null,
  }
}

type DropTarget =
  | { kind: 'none' }
  | { kind: 'panel' }
  | { kind: 'canvas'; at: { x: number; y: number } }
  | { kind: 'column'; at: { x: number; y: number }; columnId: string; index: number }

function resolveDrop(ctx: BoardContextValue, types: readonly CardType[], clientX: number, clientY: number): DropTarget {
  const stack = document.elementsFromPoint(clientX, clientY)
  if (!stack.length) return { kind: 'none' }
  if (stack[0].closest('.unsorted-panel')) return { kind: 'panel' }
  const canvas = getCanvasElement()
  // The topmost element must belong to the canvas (not the rail, header, another panel or a menu).
  if (!canvas || !canvas.contains(stack[0])) return { kind: 'none' }
  const at = screenToBoard(clientX - GHOST_OFFSET, clientY - GHOST_OFFSET)
  if (types.every((t) => COLUMN_CHILD_TYPES.has(t))) {
    const pointer = screenToBoard(clientX, clientY)
    for (const el of stack) {
      const h = el as HTMLElement
      if (h.dataset?.drop !== 'column') continue
      const columnId = h.dataset.dropId
      const col = columnId ? ctx.index.get(columnId) : undefined
      if (!columnId || !col || col.card.type !== 'column') continue
      const children = columnChildren(ctx.doc, columnId)
      const index = col.card.collapsed ? children.length : computeDropIndex(children.map(elementBoardRect), pointer.y)
      return { kind: 'column', at, columnId, index }
    }
  }
  return { kind: 'canvas', at }
}

/** Takes drawer cards out onto the board (or into a column) as one undoable step, and selects them. */
export function placeDrawerCards(ctx: BoardContextValue, ids: readonly string[], at: { x: number; y: number }, column?: { columnId: string; index: number }) {
  if (!ids.length || ctx.readOnly) return []
  const user = getUser().id
  let placed: string[] = []
  ctx.undo.stopCapturing()
  ctx.doc.transact(() => {
    // Drawer cards are not on the canvas: a size measured earlier, else an estimate from their text.
    const heightOf = (id: string) => measuredSize(id)?.h ?? estimateCardHeight(ctx.doc, id)
    placed = placeFromUnsorted(ctx.doc, ids, at, user, { heightOf })
    if (column && placed.length) insertIntoColumn(ctx.doc, placed, column.columnId, column.index, user)
  }, LOCAL_ORIGIN)
  if (placed.length) useSelection.getState().select(placed)
  return placed
}

interface Ghost {
  x: number
  y: number
  count: number
  info: RowInfo
  target: DropTarget['kind']
}

function useDrawerDrag(ctx: BoardContextValue) {
  const [ghost, setGhost] = useState<Ghost | null>(null)
  const suppressClick = useRef(false)
  const cleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => cleanupRef.current?.(), [])

  const start = useCallback(
    (e: ReactPointerEvent, ids: string[], info: RowInfo, types: CardType[]) => {
      if (e.button !== 0 || ctx.readOnly || !ids.length) return
      cleanupRef.current?.()
      const startX = e.clientX
      const startY = e.clientY
      const pointerId = e.pointerId
      let dragging = false
      let target: DropTarget = { kind: 'none' }

      const update = (clientX: number, clientY: number) => {
        target = resolveDrop(ctx, types, clientX, clientY)
        setGhost({ x: clientX, y: clientY, count: ids.length, info, target: target.kind })
        const drag = useDrag.getState()
        // Lets the column under the pointer show where the cards will land.
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
        }
        update(ev.clientX, ev.clientY)
      }
      const finish = (commit: boolean) => {
        cleanup()
        if (!dragging) return
        if (commit && target.kind === 'canvas') placeDrawerCards(ctx, ids, target.at)
        else if (commit && target.kind === 'column') placeDrawerCards(ctx, ids, target.at, { columnId: target.columnId, index: target.index })
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

  const consumeClick = useCallback(() => {
    if (!suppressClick.current) return false
    suppressClick.current = false
    return true
  }, [])

  const ghostNode = ghost ? createPortal(<DrawerGhost ghost={ghost} />, document.body) : null
  return { start, consumeClick, ghostNode }
}

function DrawerGhost({ ghost }: { ghost: Ghost }) {
  const Icon = CARD_DEFINITIONS[ghost.info.type]?.icon
  return (
    <div
      className={`drawer-ghost drawer-ghost--over-${ghost.target}`}
      style={{ transform: `translate(${ghost.x - GHOST_OFFSET}px, ${ghost.y - GHOST_OFFSET}px)` }}
      aria-hidden
    >
      {Icon && <Icon size={16} strokeWidth={1.75} />}
      <span className="drawer-ghost__title">{ghost.info.title}</span>
      {ghost.count > 1 && <span className="drawer-ghost__count">+{ghost.count - 1}</span>}
    </div>
  )
}

function UnsortedPanelBody({ ctx }: { ctx: BoardContextValue }) {
  const cards = useUnsortedCards(ctx)
  const rows = useMemo(() => cards.map((c) => describe(ctx, c)), [cards, ctx])
  const ids = useMemo(() => rows.map((r) => r.id), [rows])
  const [sel, setSel] = useState<ListSelection>(EMPTY_SELECTION)
  const prevIds = useRef<string[]>(ids)
  const panelRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const listId = useId()
  const drag = useDrawerDrag(ctx)
  const readOnly = ctx.readOnly
  const close = () => usePanels.getState().setPanel(null)
  /** Closes from the keyboard: focus goes back to the pill, which hides once an empty drawer closes. */
  const closeAndReturnFocus = () => {
    close()
    if (rows.length > 0) document.querySelector<HTMLElement>('.unsorted-pill')?.focus({ preventScroll: true })
    else getCanvasElement()?.focus({ preventScroll: true })
  }

  // Rows leave when anyone places or deletes them.
  useEffect(() => {
    setSel((s) => pruneSelection(s, ids, prevIds.current))
    prevIds.current = ids
  }, [ids])

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])

  // Keep the focused row focused (roving tabindex) after keyboard moves and list changes.
  const focusRow = useCallback((id: string | null) => {
    if (!id) return
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: false }))
  }, [])

  const place = (target: string[]) => {
    if (!target.length) return
    const c = viewCenter()
    const first = ctx.index.get(target[0])
    const w = first?.w ?? 300
    const placed = placeDrawerCards(ctx, target, { x: c.x - w / 2, y: c.y - 60 })
    if (placed.length) toast(placed.length === 1 ? 'Placed 1 card on the board' : `Placed ${placed.length} cards on the board`, 'success')
  }

  const remove = (target: string[]) => {
    if (!target.length) return
    ctx.undo.stopCapturing()
    const doc = ctx.doc
    const group = deleteCards(doc, target, getUser().id)
    if (!group) return
    // Restores exactly these cards (back into the drawer), whatever was done or opened since.
    toast(target.length === 1 ? 'Moved 1 card to the trash' : `Moved ${target.length} cards to the trash`, 'info', 6000, {
      label: 'Undo',
      run: () => {
        if (!doc.isDestroyed) restoreTrashEntry(doc, group, getUser().id)
      },
    })
  }

  const onListKeyDown = (e: ReactKeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    let next: ListSelection | null = null
    if (e.key === 'ArrowDown') next = moveFocus(sel, ids, 1, e.shiftKey)
    else if (e.key === 'ArrowUp') next = moveFocus(sel, ids, -1, e.shiftKey)
    else if (e.key === 'Home') next = moveFocus(sel, ids, 'first', e.shiftKey)
    else if (e.key === 'End') next = moveFocus(sel, ids, 'last', e.shiftKey)
    else if (e.key === ' ' && sel.focus) next = clickSelect(sel, ids, sel.focus, { range: false, toggle: true })
    else if (mod && e.key.toLowerCase() === 'a') next = { selected: new Set(ids), anchor: ids[0] ?? null, focus: sel.focus ?? ids[0] ?? null }
    else if (!readOnly && e.key === 'Enter') {
      e.preventDefault()
      place(actionIds(sel, ids, sel.focus))
      return
    } else if (!readOnly && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      remove(actionIds(sel, ids, sel.focus))
      return
    }
    if (!next) return
    e.preventDefault()
    setSel(next)
    focusRow(next.focus)
  }

  const selectedCount = ids.filter((id) => sel.selected.has(id)).length
  const focusId = sel.focus && ids.includes(sel.focus) ? sel.focus : (ids[0] ?? null)

  return (
    <aside
      ref={panelRef}
      className="side-panel unsorted-panel"
      aria-label="Unsorted"
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          closeAndReturnFocus()
        } else if (!ev.ctrlKey && !ev.metaKey) {
          // Keep board shortcuts (Delete, arrows, N, T...) from acting on the canvas; undo/redo still work.
          ev.stopPropagation()
        } else if (ev.key.toLowerCase() === 'a') ev.stopPropagation()
      }}
    >
      <header className="side-panel__header">
        <h2 className="side-panel__title">
          Unsorted
          {rows.length > 0 && <span className="side-panel__count">{rows.length}</span>}
        </h2>
        <button type="button" className="icon-btn" aria-label="Close Unsorted" title="Close" onClick={closeAndReturnFocus}>
          <X size={18} strokeWidth={1.75} />
        </button>
      </header>

      {rows.length === 0 ? (
        <div className="side-panel__empty">
          <span className="side-panel__empty-icon" aria-hidden>
            <Inbox size={26} strokeWidth={1.5} />
          </span>
          <p className="side-panel__empty-title">Nothing unsorted</p>
          <p className="muted">Cards moved into this board and boards shared with you land here.</p>
        </div>
      ) : (
        <>
          <p className="unsorted-panel__note muted" id={`${listId}-help`}>
            {readOnly ? 'Cards waiting to be placed on this board.' : 'Drag cards onto the board, or select them and press Enter to place them in view.'}
          </p>
          {!readOnly && selectedCount > 0 && (
            <div className="unsorted-panel__actions" role="group" aria-label="Selected cards">
              <span className="unsorted-panel__selected">{selectedCount} selected</span>
              <button type="button" className="btn btn--sm" onClick={() => place(actionIds(sel, ids, null))}>
                <ArrowDownToLine size={14} strokeWidth={1.75} aria-hidden />
                Place selected
              </button>
              <button type="button" className="btn btn--sm btn--ghost btn--danger" onClick={() => remove(actionIds(sel, ids, null))}>
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                Delete selected
              </button>
            </div>
          )}
          <ul
            ref={listRef}
            className="unsorted-list"
            role="listbox"
            aria-label="Unsorted cards"
            aria-multiselectable
            aria-describedby={`${listId}-help`}
            onKeyDown={onListKeyDown}
          >
            {rows.map((r) => (
              <UnsortedRow
                key={r.id}
                ctx={ctx}
                row={r}
                selected={sel.selected.has(r.id)}
                focusable={r.id === focusId}
                readOnly={readOnly}
                onPointerDown={(e) => {
                  if (readOnly) return
                  const target = actionIds(sel, ids, r.id)
                  const types = target.map((id) => ctx.index.get(id)?.type).filter((t): t is CardType => !!t)
                  drag.start(e, target, r, types)
                }}
                onClick={(e) => {
                  if (drag.consumeClick()) return
                  setSel((s) => clickSelect(s, ids, r.id, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey }))
                }}
                onFocus={() => setSel((s) => (s.focus === r.id ? s : { ...s, focus: r.id }))}
                onDoubleClick={() => !readOnly && place([r.id])}
              />
            ))}
          </ul>
        </>
      )}
      {drag.ghostNode}
    </aside>
  )
}

function UnsortedRow({
  ctx,
  row,
  selected,
  focusable,
  readOnly,
  onPointerDown,
  onClick,
  onFocus,
  onDoubleClick,
}: {
  ctx: BoardContextValue
  row: RowInfo
  selected: boolean
  focusable: boolean
  readOnly: boolean
  onPointerDown: (e: ReactPointerEvent<HTMLLIElement>) => void
  onClick: (e: React.MouseEvent<HTMLLIElement>) => void
  onFocus: () => void
  onDoubleClick: () => void
}) {
  const { url } = useBlobUrl(row.thumb, ctx.boardId)
  const Icon = CARD_DEFINITIONS[row.type]?.icon
  return (
    <li
      className={`unsorted-row${selected ? ' is-selected' : ''}${readOnly ? '' : ' is-draggable'}`}
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      data-row-id={row.id}
      title={readOnly ? row.title : `${row.title} · drag onto the board`}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onFocus={onFocus}
      onDoubleClick={onDoubleClick}
    >
      <span className="unsorted-row__media" aria-hidden>
        {url ? (
          <img src={url} alt="" draggable={false} />
        ) : row.type === 'board' ? (
          <BoardIcon icon={row.boardIcon} size={16} />
        ) : Icon ? (
          <Icon size={16} strokeWidth={1.75} />
        ) : null}
      </span>
      <span className="unsorted-row__text">
        <span className="unsorted-row__title">{row.title}</span>
        <span className="unsorted-row__kind">{row.kind}</span>
      </span>
    </li>
  )
}
