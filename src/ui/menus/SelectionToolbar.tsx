/**
 * Floating bar above the current selection with quick actions (color, card actions, duplicate,
 * delete, more). A single selected line gets line styling controls instead. Hidden while dragging,
 * editing, pressing on the canvas, or while the context menu is open.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { flip, offset, shift, useFloating } from '@floating-ui/react'
import { ArrowLeft, ArrowRight, CopyPlus, Ellipsis, Minus, Trash2 } from 'lucide-react'
import { useCardIndex, type BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { duplicateSelection, setColor } from '../../board/actions'
import { boardToScreen, canvasRect, cardBounds, getCanvasElement, rectsIntersect, unionRects, useLayoutVersion, type Rect } from '../../board/geometry'
import { useContextMenu, useDrag, usePanels, useSelection, useView } from '../../board/store'
import { collectCardActions, type CardAction } from '../../cards/cardActions'
import { getUser } from '../../collab/identity'
import { updateCard } from '../../model/board'
import { CARD_COLORS, type LineCard } from '../../model/types'
import { ColorDots, sharedColor } from './ColorDots'
import { deleteKey, modKey } from './keys'
import { capabilities, deleteIds, syncSelection } from './menuActions'
import { splitToolbarActions } from './actionLayout'
import { ActionDropdown } from './ActionDropdown'
import { actionHint } from './menuItems'
import { openCardMenu } from './ContextMenu'
import { keepControlKeys } from '../keyGuard'
import './menus.css'

export function SelectionToolbar({ ctx }: { ctx: BoardContextValue }) {
  const selected = useSelection((s) => s.selected)
  const editing = useSelection((s) => s.editing)
  const dragging = useDrag((s) => !!s.drag)
  const menuOpen = useContextMenu((s) => !!s.menu)
  const presenting = usePanels((s) => s.presenting)
  const pressing = useCanvasPress()
  if (ctx.readOnly || presenting || !selected.size || editing || dragging || menuOpen || pressing) return null
  return <SelectionBar ctx={ctx} ids={selected} />
}

const PRESS_MOVE_PX = 4

/**
 * True while the primary button is held and moving on the canvas (marquee, pan): the selection
 * changes under the pointer then, so the bar would jump around. Plain clicks do not hide it.
 */
function useCanvasPress(): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let start: { x: number; y: number; id: number } | null = null
    const onDown = (e: PointerEvent) => {
      const canvas = getCanvasElement()
      if (e.button === 0 && canvas && canvas.contains(e.target as Node)) start = { x: e.clientX, y: e.clientY, id: e.pointerId }
    }
    const onMove = (e: PointerEvent) => {
      if (!start || e.pointerId !== start.id) return
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) >= PRESS_MOVE_PX) setActive(true)
    }
    const onUp = () => {
      start = null
      setActive(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('pointermove', onMove, true)
    window.addEventListener('pointerup', onUp, true)
    window.addEventListener('pointercancel', onUp, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('pointermove', onMove, true)
      window.removeEventListener('pointerup', onUp, true)
      window.removeEventListener('pointercancel', onUp, true)
    }
  }, [])
  return active
}

/** The toolbar's controls in order (dropdown menus are portaled, so their items are not included). */
function barItems(bar: HTMLElement): HTMLButtonElement[] {
  return Array.from(bar.querySelectorAll<HTMLButtonElement>('button')).filter((b) => !b.disabled)
}

/** One tab stop for the whole toolbar: `active` (the last focused control) or the first one. */
function applyRovingTabIndex(bar: HTMLElement, active: HTMLElement | null): HTMLButtonElement | null {
  const items = barItems(bar)
  const current = items.find((b) => b === active) ?? items[0] ?? null
  for (const b of bar.querySelectorAll<HTMLButtonElement>('button')) b.tabIndex = b === current ? 0 : -1
  return current
}

/** Moves focus into the selection toolbar (Alt+F10). False when no toolbar is shown. */
export function focusSelectionToolbar(): boolean {
  const bar = document.querySelector<HTMLElement>('.sel-bar[role="toolbar"]')
  if (!bar || bar.style.visibility === 'hidden') return false
  const target = barItems(bar).find((b) => b.tabIndex === 0) ?? barItems(bar)[0]
  target?.focus({ preventScroll: true })
  return !!target
}

const ROVING_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

/**
 * Toolbar keys: Left/Right/Home/End move between controls, Escape returns to the board (keeping the
 * selection). Space/Enter stay with the focused control. Returns true when the key was handled.
 */
function onBarKey(e: ReactKeyboardEvent<HTMLElement>): boolean {
  const bar = e.currentTarget
  const target = e.target as HTMLElement
  // Keys from a dropdown menu bubble here through its portal; the menu handles them.
  if (!(target instanceof HTMLElement) || !bar.contains(target)) return false
  if (e.key === 'Escape') {
    e.preventDefault()
    getCanvasElement()?.focus({ preventScroll: true })
    return true
  }
  if (!ROVING_KEYS.has(e.key) || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false
  const items = barItems(bar)
  if (!items.length) return false
  const i = items.indexOf(target.closest('button') as HTMLButtonElement)
  const step = e.key === 'ArrowRight' ? 1 : -1
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : i < 0
          ? step > 0
            ? 0
            : items.length - 1
          : (i + step + items.length) % items.length
  // The arrows would otherwise nudge the selected cards.
  e.preventDefault()
  e.stopPropagation()
  items[next].focus({ preventScroll: true })
  return true
}

function subscribeResize(cb: () => void) {
  window.addEventListener('resize', cb)
  return () => window.removeEventListener('resize', cb)
}
const windowWidth = () => window.innerWidth

function SelectionBar({ ctx, ids }: { ctx: BoardContextValue; ids: ReadonlySet<string> }) {
  const board = ctx
  const all = useCardIndex()
  const viewport = useView((s) => s.viewport)
  const layoutVersion = useLayoutVersion((s) => s.version)
  const winWidth = useSyncExternalStore(subscribeResize, windowWidth)

  const cards = useMemo(() => {
    const out: IndexedCard[] = []
    for (const id of ids) {
      const c = board.index.get(id)
      if (c) out.push(c)
    }
    return out
    // `all` changes whenever any card changes, which is when these snapshots go stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, all, board.index])

  // Screen rect of the selection, recomputed when cards move, sizes change or the view moves.
  const screen = useMemo(() => {
    const rect = unionRects(cards.map(cardBounds).filter((r): r is Rect => !!r))
    if (!rect) return null
    const tl = boardToScreen(rect.x, rect.y, viewport)
    const br = boardToScreen(rect.x + rect.w, rect.y + rect.h, viewport)
    return { x: tl.x, y: tl.y, w: Math.max(1, br.x - tl.x), h: Math.max(1, br.y - tl.y) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, viewport, layoutVersion])

  const canvas = getCanvasElement()
  const { refs, floatingStyles, isPositioned } = useFloating({
    open: true,
    placement: 'top',
    strategy: 'fixed',
    middleware: [
      offset(12),
      flip({ boundary: canvas ?? undefined, padding: 8, fallbackPlacements: ['bottom'] }),
      // crossAxis keeps the bar on screen (over the cards) when the selection is taller than the view.
      shift({ boundary: canvas ?? undefined, padding: 8, crossAxis: true }),
    ],
  })

  useLayoutEffect(() => {
    if (!screen) return
    const r = new DOMRect(screen.x, screen.y, screen.w, screen.h)
    refs.setPositionReference({ getBoundingClientRect: () => r })
  }, [screen, refs])

  // Controls come and go with the selection: keep exactly one of them in the tab order.
  const barRef = useRef<HTMLDivElement | null>(null)
  const activeItem = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (barRef.current) activeItem.current = applyRovingTabIndex(barRef.current, activeItem.current)
  })
  const setBar = useCallback(
    (el: HTMLDivElement | null) => {
      barRef.current = el
      refs.setFloating(el)
    },
    [refs],
  )

  if (!cards.length || !screen) return null
  const c = canvasRect()
  if (!rectsIntersect(screen, { x: c.left, y: c.top, w: c.width, h: c.height })) return null

  const idList = cards.map((x) => x.id)
  const single = cards.length === 1 ? cards[0] : null
  const isLine = single?.card.type === 'line'

  return (
    <div
      ref={setBar}
      className="sel-bar"
      role="toolbar"
      aria-label={isLine ? 'Line options' : 'Selection actions'}
      aria-keyshortcuts="Alt+F10"
      style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onFocus={(e) => {
        const btn = (e.target as HTMLElement).closest?.('button')
        if (btn && e.currentTarget.contains(btn)) activeItem.current = applyRovingTabIndex(e.currentTarget, btn)
      }}
      onKeyDown={(e) => {
        if (onBarKey(e)) return
        // Space/Enter on Duplicate/Delete/More must activate them, not pan or start editing the card.
        keepControlKeys(e)
      }}
    >
      {isLine && single ? (
        <LineControls ctx={ctx} line={single.card as LineCard} />
      ) : (
        <CardControls ctx={ctx} cards={cards} ids={idList} canvasWidth={c.width} windowWidth={winWidth} />
      )}
    </div>
  )
}

/** Approximate widths (px) used to decide whether every provider button fits. */
const BAR_PADDING = 8
const BUTTON_W = 32
const DOT_W = 19
const SEP_W = 9

function CardControls({
  ctx,
  cards,
  ids,
  canvasWidth,
  windowWidth,
}: {
  ctx: BoardContextValue
  cards: IndexedCard[]
  ids: string[]
  canvasWidth: number
  windowWidth: number
}) {
  const caps = capabilities(cards)
  const actions = collectCardActions(ctx, cards).filter((a) => a.inToolbar === true)
  const dots = caps.colorable ? (CARD_COLORS.length + 1) * DOT_W + 8 + SEP_W : 0
  const fixed = BAR_PADDING + dots + 3 * BUTTON_W + (actions.length ? SEP_W : 0)
  const { shown, overflow } = splitToolbarActions(actions, { available: canvasWidth - 32, fixed, button: BUTTON_W, windowWidth })

  const runAction = (a: CardAction, anchor: DOMRect | null) => {
    syncSelection(ids)
    try {
      void Promise.resolve(a.run?.(anchor)).catch((err) => console.warn('Card action failed', err))
    } catch (err) {
      console.warn('Card action failed', err)
    }
  }

  return (
    <>
      {caps.colorable && (
        <>
          <ColorDots size="sm" value={sharedColor(cards.map((c) => c.card.color))} onChange={(color) => setColor(ctx.doc, ids, color)} />
          <span className="sel-bar__sep" aria-hidden />
        </>
      )}
      {shown.map((a) =>
        a.children?.length ? (
          <ActionDropdown key={a.id} action={a} onRun={runAction} />
        ) : (
          <ActionButton key={a.id} action={a} onRun={runAction} />
        ),
      )}
      {shown.length > 0 && <span className="sel-bar__sep" aria-hidden />}
      <BarButton
        label={`Duplicate (${modKey}D)`}
        onClick={() => {
          syncSelection(ids)
          duplicateSelection(ctx.doc)
        }}
      >
        <CopyPlus size={16} strokeWidth={1.75} />
      </BarButton>
      <BarButton label={`Delete (${deleteKey})`} danger onClick={() => deleteIds(ctx, ids)}>
        <Trash2 size={16} strokeWidth={1.75} />
      </BarButton>
      <MoreButton ids={ids} extra={overflow.map((a) => a.id)} />
    </>
  )
}

function ActionButton({ action, onRun }: { action: CardAction; onRun: (a: CardAction, anchor: DOMRect | null) => void }) {
  const hint = actionHint(action)
  const Icon = action.icon
  return (
    <BarButton
      label={action.label}
      title={hint ? `${action.label} (${hint})` : action.label}
      pressed={action.pressed}
      danger={action.danger}
      disabled={action.disabled || !action.run}
      onClick={(e) => onRun(action, e.currentTarget.getBoundingClientRect())}
    >
      <Icon size={16} strokeWidth={1.75} />
    </BarButton>
  )
}

function MoreButton({ ids, extra = [] }: { ids: string[]; extra?: string[] }) {
  return (
    <BarButton
      label="More actions"
      onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const at = useView.getState().viewport
        const c = canvasRect()
        openCardMenu(
          {
            x: r.left,
            y: r.bottom + 4,
            kind: 'card',
            ids,
            at: { x: (r.left - c.left - at.x) / at.zoom, y: (r.bottom - c.top - at.y) / at.zoom },
          },
          extra,
        )
      }}
    >
      <Ellipsis size={16} strokeWidth={1.75} />
    </BarButton>
  )
}

const THIN = 2
const THICK = 4

function LineControls({ ctx, line }: { ctx: BoardContextValue; line: LineCard }) {
  const patch = (p: Partial<LineCard>) => updateCard(ctx.doc, line.id, p as Record<string, unknown>, getUser().id)
  const thick = line.thickness >= 3
  return (
    <>
      <div className="sel-bar__segmented" role="group" aria-label="Line thickness">
        <BarButton label="Thin line" pressed={!thick} onClick={() => patch({ thickness: THIN })}>
          <span className="line-swatch" style={{ height: 1.5 }} />
        </BarButton>
        <BarButton label="Thick line" pressed={thick} onClick={() => patch({ thickness: THICK })}>
          <span className="line-swatch" style={{ height: 3.5 }} />
        </BarButton>
      </div>
      <BarButton label="Dashed line" pressed={line.dashed} onClick={() => patch({ dashed: !line.dashed })}>
        <span className="line-swatch line-swatch--dashed" />
      </BarButton>
      <span className="sel-bar__sep" aria-hidden />
      <BarButton label="Arrow at start" pressed={line.arrowStart} onClick={() => patch({ arrowStart: !line.arrowStart })}>
        {line.arrowStart ? <ArrowLeft size={16} strokeWidth={2} /> : <Minus size={16} strokeWidth={2} />}
      </BarButton>
      <BarButton label="Arrow at end" pressed={line.arrowEnd} onClick={() => patch({ arrowEnd: !line.arrowEnd })}>
        {line.arrowEnd ? <ArrowRight size={16} strokeWidth={2} /> : <Minus size={16} strokeWidth={2} />}
      </BarButton>
      <span className="sel-bar__sep" aria-hidden />
      <ColorDots size="sm" value={sharedColor([line.color])} onChange={(color) => setColor(ctx.doc, [line.id], color)} />
      <span className="sel-bar__sep" aria-hidden />
      <BarButton label={`Delete line (${deleteKey})`} danger onClick={() => deleteIds(ctx, [line.id])}>
        <Trash2 size={16} strokeWidth={1.75} />
      </BarButton>
      <MoreButton ids={[line.id]} />
    </>
  )
}

function BarButton({
  label,
  title,
  pressed,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string
  /** Tooltip; defaults to the label. */
  title?: string
  pressed?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      className={`sel-bar__btn${danger ? ' sel-bar__btn--danger' : ''}`}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}
