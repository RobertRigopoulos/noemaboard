/** Header, toolbar, panels, menus and board dialogs drawn over the canvas. */
import { useEffect } from 'react'
import type { BoardContextValue } from '../board/BoardContext'
import { boardToScreen, canvasRect, cardBounds, getCanvasElement, screenToBoard, unionRects, type Rect } from '../board/geometry'
import { usePanels, useSelection } from '../board/store'
import { isTypingTarget } from '../board/keyboard'
import { desktop } from '../lib/desktop'
import { boardOverlays } from '../cards/cardActions'
import { breadcrumbs } from '../collab/boards'
import { openBoard } from '../app/router'
import { Toolbar } from './toolbar/Toolbar'
import { ContextMenu, openCardMenu } from './menus/ContextMenu'
import { cardsFor } from './menus/menuActions'
import { focusSelectionToolbar, SelectionToolbar } from './menus/SelectionToolbar'
import { TrashPanel } from './panels/TrashPanel'
import { UnsortedPanel } from './panels/UnsortedPanel'
import { UnsortedPill } from './panels/UnsortedPill'
import { ZoomControls } from './panels/ZoomControls'
import { HomeEmptyState } from './panels/HomeEmptyState'
import { PresentationOverlay } from './panels/PresentationOverlay'
import { Header } from './header/Header'
import { openQuickNote } from './header/QuickNote'
import { ShareDialog } from './dialogs/ShareDialog'
import { BoardPicker } from './dialogs/BoardPicker'
import { hasOpenDialog } from './dialogs/Dialog'
import { SearchPanel } from './search/SearchPanel'
import { openSearch } from './search/searchState'
import { useApplyPendingFocus } from './search/focusTarget'
import { ExportDialog } from './export/ExportDialog'
import { ImageExportDialog } from './export/ImageExportDialog'
import { TemplatesDialog } from './dialogs/TemplatesDialog'
import { printBoard } from './export/exportActions'
import { useDialogs } from './uiStore'
import { chromeKeyAction, mouseNavAction, parentInChain } from './chromeKeys'
import './export/print.css'

/** A browser that navigated by itself after a side-button press. */
const NATIVE_NAV_GRACE_MS = 120
/** How long after Shift+F10 / the menu key the browser's own contextmenu event may still arrive. */
const KEY_MENU_EVENT_MS = 1000

/** Inside a modal dialog or an open menu: those keep their keys and clicks. */
const inDialogOrMenu = (t: EventTarget | null) => hasOpenDialog() || !!(t as HTMLElement | null)?.closest?.('[role="dialog"], [role="menu"]')

/** Focus on the board itself (the canvas, a card, the selection toolbar) rather than other chrome. */
function onBoardSurface(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || el === document.body || el === document.documentElement) return true
  return !!getCanvasElement()?.contains(el) || !!el.closest?.('.sel-bar')
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Opens the card menu for the selection, beside its top-right corner (kept on the canvas). */
function openSelectionMenu(ctx: BoardContextValue) {
  const cards = cardsFor(ctx, Array.from(useSelection.getState().selected))
  if (!cards.length) return
  const c = canvasRect()
  let x = c.left + c.width / 2
  let y = c.top + c.height / 2
  const rect = unionRects(cards.map(cardBounds).filter((r): r is Rect => !!r))
  if (rect) {
    const tl = boardToScreen(rect.x, rect.y)
    const br = boardToScreen(rect.x + rect.w, rect.y + rect.h)
    x = clamp(br.x, c.left + 8, Math.max(c.left + 8, c.right - 8))
    y = clamp(tl.y, c.top + 8, Math.max(c.top + 8, c.bottom - 8))
  }
  openCardMenu({ x, y, kind: 'card', ids: cards.map((card) => card.id), at: screenToBoard(x, y) })
  // Some systems still send the key's contextmenu event (on key up): it must not open the canvas menu.
  const until = performance.now() + KEY_MENU_EVENT_MS
  const swallow = (ev: MouseEvent) => {
    window.removeEventListener('contextmenu', swallow, true)
    if (performance.now() > until) return
    ev.preventDefault()
    ev.stopPropagation()
  }
  window.addEventListener('contextmenu', swallow, true)
  setTimeout(() => window.removeEventListener('contextmenu', swallow, true), KEY_MENU_EVENT_MS)
}

/**
 * App-level keys that work on every board: search, print, the shortcut reference, the quick note,
 * history (back / forward / parent board), the card menu and selection toolbar from the keyboard,
 * and the mouse's side buttons.
 */
function useChromeKeys(ctx: BoardContextValue) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      // Dialogs keep their keys (they stop propagation too; this also covers non-React listeners).
      if (inDialogOrMenu(e.target)) return
      const action = chromeKeyAction(e, {
        typing: isTypingTarget(e.target),
        hasSelection: useSelection.getState().selected.size > 0,
        presenting: usePanels.getState().presenting,
        isHome: ctx.isHome,
      })
      if (!action) return
      if (action === 'card-menu' || action === 'selection-toolbar') {
        // Elsewhere (header, panels) these keys keep their usual meaning.
        if (!onBoardSurface(e.target)) return
        e.preventDefault()
        if (e.repeat) return
        if (action === 'card-menu') openSelectionMenu(ctx)
        else focusSelectionToolbar()
        return
      }
      e.preventDefault()
      switch (action) {
        case 'search-all':
          openSearch('all')
          break
        case 'search-board':
          openSearch('board')
          break
        case 'print':
          // Same as Export > Print…: fit the whole board on the page instead of printing the current
          // view. Handled here (not by a menu accelerator) so it works in the desktop app too.
          if (!e.repeat) printBoard(ctx.doc)
          break
        case 'shortcuts':
          useDialogs.getState().open('shortcuts')
          break
        case 'quick-note':
          // The note popover lives in the header, which presentation mode hides.
          if (!usePanels.getState().presenting) openQuickNote()
          break
        case 'back':
          history.back()
          break
        case 'forward':
          history.forward()
          break
        case 'parent': {
          const parent = parentInChain(breadcrumbs(ctx.boardId), ctx.boardId)
          if (parent) openBoard(parent)
          break
        }
      }
    }

    // Side mouse buttons, in the browser only: the desktop shell owns them (app commands on Windows
    // and Linux, its preload on macOS). Browsers may still navigate on their own: only navigate when
    // that did not happen right away.
    let lastNav = 0
    let pressedAt = 0
    const onNav = () => {
      lastNav = performance.now()
    }
    const onMouseDown = (e: MouseEvent) => {
      if (desktop) return
      if (mouseNavAction(e.button)) pressedAt = performance.now()
    }
    const onMouseUp = (e: MouseEvent) => {
      if (desktop) return
      const dir = mouseNavAction(e.button)
      if (!dir) return
      e.preventDefault()
      const since = pressedAt || performance.now()
      pressedAt = 0
      // Like the keyboard: no board switch under an open dialog or menu.
      if (inDialogOrMenu(e.target)) return
      setTimeout(() => {
        if (lastNav >= since || hasOpenDialog()) return
        if (dir === 'back') history.back()
        else history.forward()
      }, NATIVE_NAV_GRACE_MS)
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mouseup', onMouseUp)
    window.addEventListener('popstate', onNav)
    window.addEventListener('hashchange', onNav)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('popstate', onNav)
      window.removeEventListener('hashchange', onNav)
    }
  }, [ctx])
}

/**
 * Presentation mode (usePanels.presenting) hides the chrome; PresentationOverlay owns entering/leaving
 * it and collapses --header-h/--toolbar-w through :root[data-presenting].
 */
export function BoardChrome({ ctx }: { ctx: BoardContextValue }) {
  const presenting = usePanels((s) => s.presenting)
  useChromeKeys(ctx)
  useApplyPendingFocus(ctx)

  return (
    <>
      {!presenting && (
        <>
          <Header ctx={ctx} />
          <Toolbar ctx={ctx} />
          <ContextMenu ctx={ctx} />
          <SelectionToolbar ctx={ctx} />
          <TrashPanel ctx={ctx} />
          <UnsortedPill ctx={ctx} />
          <UnsortedPanel ctx={ctx} />
          <ZoomControls ctx={ctx} />
          {ctx.isHome && <HomeEmptyState ctx={ctx} />}
        </>
      )}
      {/* Feature folders' overlays (lightbox, popovers, notifiers) render for every open board. */}
      {boardOverlays().map(({ key, overlay: Overlay }) => (
        <Overlay key={key} ctx={ctx} />
      ))}
      <PresentationOverlay ctx={ctx} />
      <ShareDialog ctx={ctx} />
      <SearchPanel currentBoardId={ctx.boardId} />
      <ExportDialog ctx={ctx} />
      <ImageExportDialog ctx={ctx} />
      <BoardPicker ctx={ctx} />
      <TemplatesDialog ctx={ctx} />
    </>
  )
}
