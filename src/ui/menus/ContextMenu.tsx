/**
 * Right-click menu for cards (acts on the selection) and for the empty canvas (adds cards at the
 * click point). Opened through useContextMenu; positioned at the pointer with floating-ui.
 *
 * Card menus list the built-in items and every registered card action (src/cards/cardActions.ts)
 * in CARD_ACTION_GROUPS sections, then Move to / Copy to board, then Delete.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react'
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  ExternalLink,
  Eye,
  FileUp,
  FolderInput,
  Grid2x2,
  Grid3x3,
  Group,
  LayoutGrid,
  Magnet,
  Maximize,
  Pencil,
  Plus,
  Redo2,
  ScanSearch,
  Scissors,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  Ungroup,
  Focus,
  type LucideIcon,
} from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { addCard, duplicateSelection, selectAll, setColor, zoomTo, zoomToFit, zoomToSelection } from '../../board/actions'
import { useCanvasPrefs } from '../../board/prefs'
import { getCanvasElement } from '../../board/geometry'
import { useContextMenu, useSelection, useView, type ContextMenuState } from '../../board/store'
import { collectCardActions, type CardAction } from '../../cards/cardActions'
import { CARD_DEFINITIONS } from '../../cards/registry'
import { openBoard } from '../../app/router'
import { CARD_TYPES, type CardType } from '../../model/types'
import { convertTextCard, isTextCardType, TEXT_CARD_TYPES, type TextCardType } from '../../model/convertText'
import { getUser } from '../../collab/identity'
import { toast } from '../toast'
import { importFilesAt } from '../toolbar/importBridge'
import { EDIT_ON_CREATE } from '../toolbar/useRailDrag'
import { useUndoState } from '../header/hooks'
import { useBoardPicker } from '../uiStore'
import { ColorDots, sharedColor } from './ColorDots'
import { copyCardsToClipboard, pasteFromClipboard } from './clipboard'
import { deleteKey, modKey, shiftKey } from './keys'
import { groupActions, withSeparators } from './actionLayout'
import { ActionItem, Item, Sep } from './menuItems'
import { onMenuKeyDown } from './menuKeys'
import { MenuHostProvider, Submenu, useMenuHostState, useNarrowMenus } from './Submenu'
import {
  capabilities,
  cardsFor,
  deleteIds,
  groupSelectionIntoColumn,
  syncSelection,
  turnIntoBoard,
  ungroupColumns,
} from './menuActions'
import './menus.css'

/**
 * Toolbar-only card actions that did not fit in the selection toolbar. "More" opens the card menu
 * with these ids, so the menu lists them even though their provider set inMenu: false. Keyed by the
 * menu state object itself, so they belong to that one menu and nothing has to clear them (an effect
 * cleanup would, under StrictMode's double mount).
 */
const menuExtras = new WeakMap<ContextMenuState, ReadonlySet<string>>()
const NO_EXTRAS: ReadonlySet<string> = new Set()

export function openCardMenu(state: ContextMenuState, extraActionIds: readonly string[] = []) {
  const menu = { ...state }
  if (extraActionIds.length) menuExtras.set(menu, new Set(extraActionIds))
  useContextMenu.getState().open(menu)
}

// ---------------------------------------------------------------------------
// File picking for "Upload files here…" and Add > Image / File. The input lives outside the menu
// popup: the popup is gone by the time the user has chosen files.

const filePicker: { pick?: (at: { x: number; y: number }, accept?: string) => void } = {}

function HiddenFilePicker({ ctx }: { ctx: BoardContextValue }) {
  const input = useRef<HTMLInputElement | null>(null)
  const pending = useRef<{ at: { x: number; y: number }; imagesOnly: boolean } | null>(null)
  useEffect(() => {
    filePicker.pick = (at, accept) => {
      const el = input.current
      if (!el) return
      pending.current = { at, imagesOnly: accept === 'image/*' }
      el.accept = accept ?? ''
      el.click()
    }
    return () => {
      filePicker.pick = undefined
    }
  }, [])
  return (
    <input
      ref={input}
      type="file"
      multiple
      hidden
      tabIndex={-1}
      aria-hidden
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? [])
        // Reset so choosing the same file again still fires a change.
        e.currentTarget.value = ''
        const p = pending.current
        pending.current = null
        if (!p || ctx.readOnly) return
        const picked = p.imagesOnly ? files.filter((f) => f.type.startsWith('image/')) : files
        if (picked.length) void importFilesAt(ctx.doc, picked, p.at)
      }}
    />
  )
}

export function ContextMenu({ ctx }: { ctx: BoardContextValue }) {
  const menu = useContextMenu((s) => s.menu)
  return (
    <>
      <HiddenFilePicker ctx={ctx} />
      {menu && <MenuPopup key={`${menu.kind}:${menu.x}:${menu.y}:${menu.ids.join(',')}`} ctx={ctx} menu={menu} />}
    </>
  )
}

function MenuPopup({ ctx, menu }: { ctx: BoardContextValue; menu: ContextMenuState }) {
  const close = useContextMenu((s) => s.close)
  const listRef = useRef<HTMLDivElement | null>(null)
  const narrow = useNarrowMenus()
  const closeAll = useCallback(() => close(), [close])
  const host = useMenuHostState(closeAll, narrow)
  const { refs, floatingStyles, isPositioned } = useFloating({
    open: true,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      offset({ mainAxis: 2, alignmentAxis: 2 }),
      flip({ fallbackPlacements: ['left-start', 'right-end', 'left-end'], padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, Math.floor(availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useLayoutEffect(() => {
    const { x, y } = menu
    refs.setPositionReference({ getBoundingClientRect: () => new DOMRect(x, y, 0, 0) })
  }, [menu, refs])

  // Close on outside press (submenus count as inside), viewport pan/zoom, window resize or blur.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || listRef.current?.contains(t) || t.closest?.('[data-submenu]')) return
      close()
    }
    const unsubView = useView.subscribe((s, prev) => {
      if (s.viewport !== prev.viewport) close()
    })
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      unsubView()
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [close])

  // Give focus back on close to whatever had it before the menu opened. The selection toolbar's
  // "More" button is gone by then (the bar hides while the menu is open): the board takes focus.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    return () => {
      if (prev && prev.isConnected && prev !== document.body) prev.focus({ preventScroll: true })
      else if (prev?.closest('.sel-bar')) getCanvasElement()?.focus({ preventScroll: true })
    }
  }, [])
  // Focus the first item once the menu is placed (hidden elements cannot take focus).
  useEffect(() => {
    if (!isPositioned) return
    const first = listRef.current?.querySelector<HTMLElement>('[data-mi]:not(:disabled)')
    first?.focus({ preventScroll: true })
  }, [isPositioned])

  const run: Run = (fn) => {
    close()
    try {
      void Promise.resolve(fn()).catch((err) => console.warn('Menu action failed', err))
    } catch (err) {
      console.warn('Menu action failed', err)
    }
  }

  const content = menu.kind === 'card' ? <CardItems ctx={ctx} menu={menu} run={run} /> : <CanvasItems ctx={ctx} menu={menu} run={run} />

  return (
    <FloatingPortal>
      <div
        ref={(el) => {
          listRef.current = el
          refs.setFloating(el)
        }}
        className="ctx-menu"
        role="menu"
        aria-label={menu.kind === 'card' ? 'Card actions' : 'Board actions'}
        style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
        onKeyDown={(e) => onMenuKeyDown(e, listRef.current, close)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuHostProvider value={host}>{content}</MenuHostProvider>
      </div>
    </FloatingPortal>
  )
}

type Run = (fn: () => unknown) => void

function CardItems({ ctx, menu, run }: { ctx: BoardContextValue; menu: ContextMenuState; run: Run }) {
  const close = useContextMenu((s) => s.close)
  const extraIds = menuExtras.get(menu) ?? NO_EXTRAS
  const cards = cardsFor(ctx, menu.ids)
  const ids = cards.map((c) => c.id)
  // Cards vanished (deleted by a teammate) while the menu was opening.
  useEffect(() => {
    if (!ids.length) close()
  }, [ids.length, close])
  if (!ids.length) return null

  const caps = capabilities(cards)
  const { single } = caps
  const doc = ctx.doc
  const onlyOneColumn = cards.length === 1 && cards[0].type === 'column'

  const builtIns: CardAction[] = []
  if (single && caps.canEdit)
    builtIns.push({ id: 'chrome.edit', label: 'Edit', icon: Pencil, group: 'view', hint: 'Enter', run: () => useSelection.getState().setEditing(single.id) })
  if (single?.card.type === 'board') {
    const boardId = single.card.boardId
    builtIns.push({ id: 'chrome.openBoard', label: 'Open board', icon: ExternalLink, group: 'view', readOnlyOk: true, disabled: !boardId, run: () => openBoard(boardId) })
  }
  builtIns.push(
    { id: 'chrome.duplicate', label: 'Duplicate', icon: CopyPlus, group: 'edit', hint: `${modKey}D`, run: () => duplicateSelection(doc) },
    { id: 'chrome.copy', label: 'Copy', icon: Copy, group: 'edit', hint: `${modKey}C`, readOnlyOk: true, run: () => copyCardsToClipboard(doc) },
    { id: 'chrome.cut', label: 'Cut', icon: Scissors, group: 'edit', hint: `${modKey}X`, run: () => copyCardsToClipboard(doc, true) },
    { id: 'chrome.paste', label: 'Paste', icon: ClipboardPaste, group: 'edit', hint: `${modKey}V`, run: () => pasteFromClipboard(doc, menu.at) },
  )
  if (caps.canGroup) builtIns.push({ id: 'chrome.group', label: 'Group into column', icon: Group, group: 'convert', run: () => groupSelectionIntoColumn(ctx, ids) })
  if (caps.columns.length)
    builtIns.push({
      id: 'chrome.ungroup',
      label: caps.columns.length > 1 ? 'Ungroup columns' : 'Ungroup column',
      icon: Ungroup,
      group: 'convert',
      run: () => ungroupColumns(ctx, caps.columns),
    })
  // A single column gets "Convert to board" from its own actions, which keeps it as one card.
  if (caps.canTurnIntoBoard && !onlyOneColumn)
    builtIns.push({ id: 'chrome.toBoard', label: 'Turn into board', icon: LayoutGrid, group: 'convert', run: () => turnIntoBoard(ctx, ids) })
  // One note, to-do or document becomes one of the others in place (locked cards keep their content).
  if (single && isTextCardType(single.type) && single.card.locked !== true) {
    const id = single.id
    for (const to of TEXT_CARD_TYPES) {
      if (to === single.type) continue
      builtIns.push({ id: `chrome.convert.${to}`, label: `Convert to ${CONVERT_LABELS[to]}`, icon: iconOf(to), group: 'convert', run: () => convertCard(ctx, id, to) })
    }
  }

  // Toolbar-only actions that overflowed the selection toolbar are listed here too.
  const provided = collectCardActions(ctx, cards).map((a) => (a.inMenu === false && extraIds.has(a.id) ? { ...a, inMenu: true } : a))
  const rows = withSeparators(groupActions([...builtIns, ...provided], ctx.readOnly))

  const runAction = (a: CardAction, anchor: DOMRect | null) =>
    run(() => {
      syncSelection(ids)
      return a.run?.(anchor)
    })

  const out: ReactNode[] = []
  if (!ctx.readOnly) {
    if (caps.count > 1) out.push(<div key="label" className="ctx-menu__label">{caps.count} cards selected</div>)
    if (caps.colorable) {
      out.push(
        <div key="colors" className="ctx-menu__colors" data-row="colors">
          <ColorDots
            size="sm"
            menu
            value={sharedColor(cards.map((c) => c.card.color))}
            onChange={(color) => {
              close()
              setColor(doc, ids, color)
            }}
            itemProps={{ 'data-mi': '', 'data-row': 'colors' }}
          />
        </div>,
        <Sep key="s-colors" />,
      )
    }
  }
  for (const r of rows) out.push(r.kind === 'sep' ? <Sep key={r.key} /> : <ActionItem key={r.item.id} action={r.item} onRun={runAction} />)
  if (!ctx.readOnly) {
    const pick = useBoardPicker.getState().open
    out.push(
      <Sep key="s-move" />,
      <Item key="move" icon={FolderInput} label="Move to board…" onSelect={() => run(() => pick('move', ids, ctx.boardId))} />,
      <Item key="copyTo" icon={Copy} label="Copy to board…" onSelect={() => run(() => pick('copy', ids, ctx.boardId))} />,
      <Sep key="s-del" />,
      <Item key="del" icon={Trash2} label="Delete" hint={deleteKey} danger onSelect={() => run(() => deleteIds(ctx, ids))} />,
    )
  }
  return <>{out}</>
}

const CONVERT_LABELS: Record<TextCardType, string> = { note: 'note', todo: 'to-do', document: 'document' }

function convertCard(ctx: BoardContextValue, id: string, to: TextCardType) {
  ctx.undo.stopCapturing()
  if (!convertTextCard(ctx.doc, id, to, getUser().id)) toast('This card has content from a newer version and can’t be converted.', 'error', 6000)
}

const ADD_HINTS: Partial<Record<CardType, string>> = { note: 'N', todo: 'T', board: 'B', column: 'C', link: 'L', comment: 'M' }
const ADD_LABELS: Partial<Record<CardType, string>> = { swatch: 'Color swatch', image: 'Image…', file: 'File…' }
/** Every card type the canvas menu can add, in rail order. */
const ADD_TYPES: CardType[] = ['note', 'link', 'todo', 'board', 'column', 'comment', 'document', 'swatch', 'sketch', 'image', 'file'].filter(
  (t): t is CardType => (CARD_TYPES as readonly string[]).includes(t) && t !== 'line',
)

function CanvasItems({ ctx, menu, run }: { ctx: BoardContextValue; menu: ContextMenuState; run: Run }) {
  const doc = ctx.doc
  const { canUndo, canRedo } = useUndoState(ctx.undo)
  const hasSelection = useSelection((s) => s.selected.size > 0)

  const add = (type: CardType) =>
    run(() => {
      if (type === 'image' || type === 'file') return filePicker.pick?.(menu.at, type === 'image' ? 'image/*' : undefined)
      ctx.undo.stopCapturing()
      addCard(doc, type, {}, { at: menu.at, centered: false, edit: EDIT_ON_CREATE.has(type) })
    })

  // Read-only boards only get the view items, without a submenu around them.
  if (ctx.readOnly) return <ViewItems ctx={ctx} run={run} hasSelection={hasSelection} />
  return (
    <>
      <Submenu icon={Plus} label="Add">
        {ADD_TYPES.map((type) => (
          <Item key={type} icon={iconOf(type)} label={ADD_LABELS[type] ?? CARD_DEFINITIONS[type].label} hint={ADD_HINTS[type]} onSelect={() => add(type)} />
        ))}
      </Submenu>
      <Item icon={FileUp} label="Upload files here…" onSelect={() => run(() => filePicker.pick?.(menu.at))} />
      <Item icon={ClipboardPaste} label="Paste here" hint={`${modKey}V`} onSelect={() => run(() => pasteFromClipboard(doc, menu.at))} />
      <Sep />
      <Item icon={Undo2} label="Undo" hint={`${modKey}Z`} disabled={!canUndo} onSelect={() => run(() => ctx.undo.undo())} />
      <Item icon={Redo2} label="Redo" hint={`${modKey}${shiftKey}Z`} disabled={!canRedo} onSelect={() => run(() => ctx.undo.redo())} />
      <Sep />
      <Submenu icon={Eye} label="View">
        <ViewItems ctx={ctx} run={run} hasSelection={hasSelection} />
      </Submenu>
    </>
  )
}

const iconOf = (type: CardType): LucideIcon => CARD_DEFINITIONS[type]?.icon ?? Plus

function ViewItems({ ctx, run, hasSelection }: { ctx: BoardContextValue; run: Run; hasSelection: boolean }) {
  const prefs = useCanvasPrefs()
  return (
    <>
      <Item icon={Maximize} label="Zoom to fit" hint={`${shiftKey}1`} onSelect={() => run(() => zoomToFit(ctx.doc))} />
      <Item icon={ScanSearch} label="Zoom to 100%" hint={`${modKey}0`} onSelect={() => run(() => zoomTo(1))} />
      {hasSelection && <Item icon={Focus} label="Zoom to selection" hint={`${shiftKey}2`} onSelect={() => run(() => zoomToSelection(ctx.doc))} />}
      <Sep />
      <Item icon={Grid3x3} label="Show dot grid" checked={prefs.showGrid} onSelect={() => run(() => prefs.set({ showGrid: !prefs.showGrid }))} />
      <Item icon={Magnet} label="Snap to grid" checked={prefs.snapToGrid} onSelect={() => run(() => prefs.set({ snapToGrid: !prefs.snapToGrid }))} />
      <Item icon={Grid3x3} label="Small grid (10)" checked={prefs.gridSize === 10} onSelect={() => run(() => prefs.set({ gridSize: 10 }))} />
      <Item icon={Grid2x2} label="Medium grid (20)" checked={prefs.gridSize === 20} onSelect={() => run(() => prefs.set({ gridSize: 20 }))} />
      <Sep />
      <Item icon={SquareDashedMousePointer} label="Select all" hint={`${modKey}A`} onSelect={() => run(() => selectAll(ctx.doc))} />
    </>
  )
}
