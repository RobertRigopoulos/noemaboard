import { useEffect } from 'react'
import type { BoardContextValue } from './BoardContext'
import type { IndexedCard } from './cardIndex'
import { useContextMenu, usePanels, useSelection } from './store'
import {
  addCard,
  addCardBelow,
  arrange,
  copySelection,
  cutSelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  pasteCards,
  pasteTarget,
  selectAll,
  stepZOrder,
  zoomBy,
  zoomTo,
  zoomToFit,
  zoomToSelection,
} from './actions'
import { handlePaste } from '../cards/media/paste'
import { copyImageCardToClipboard } from '../cards/media/clipboardImage'
import { blobUnavailable } from '../cards/media/blobAvailability'
import { collectCardActions, flattenActions, matchesKeys } from '../cards/cardActions'
import { isActivatableTarget, isTypingTarget } from './keyboard'
import { getCanvasElement, getCardElement } from './geometry'
import { moveFocus, reorderInColumn, tabToCard } from './keyboardNav'

function isTyping(e: Event): boolean {
  return isTypingTarget(e.target)
}

const ARROW_DIRS = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const

function selectedCards(board: BoardContextValue): IndexedCard[] {
  const out: IndexedCard[] = []
  for (const id of useSelection.getState().selected) {
    const c = board.index.get(id)
    if (c) out.push(c)
  }
  return out
}

/** Runs the first offered card action whose `keys` match. Returns true when one ran. */
function dispatchCardAction(board: BoardContextValue, e: KeyboardEvent): boolean {
  if (e.repeat || useContextMenu.getState().menu || usePanels.getState().expanded) return false
  const cards = selectedCards(board)
  if (!cards.length) return false
  const action = flattenActions(collectCardActions(board, cards)).find((a) => a.keys && !a.disabled && a.run && matchesKeys(a.keys, e))
  if (!action?.run) return false
  e.preventDefault()
  board.undo.stopCapturing()
  void action.run(null)
  return true
}

/**
 * Board keyboard shortcuts and clipboard. Text editing inside cards keeps its native behaviour.
 */
export function useBoardShortcuts(board: BoardContextValue) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.ctrlKey || e.metaKey
      const sel = useSelection.getState()
      const typing = isTyping(e)

      if (e.key === 'Escape') {
        if (useContextMenu.getState().menu) return useContextMenu.getState().close()
        if (usePanels.getState().expanded) return
        if (sel.editing) {
          leaveEditMode(sel.editing)
          return
        }
        if (sel.tool !== 'select') return sel.setTool('select')
        // Out of the cards: the next Tab leaves the board instead of starting over at the first card.
        if (document.activeElement === getCanvasElement()) tabLeavesCanvas = true
        sel.clear()
        return
      }
      if (typing) return

      // ----- Keyboard navigation (read-only boards too)
      if (e.key === 'Tab' && !mod && !e.altKey) {
        const leave = tabLeavesCanvas
        tabLeavesCanvas = false
        const active = document.activeElement
        if (active !== getCanvasElement() && active !== document.body && active !== null) return
        if (useContextMenu.getState().menu || usePanels.getState().expanded) return
        if (leave && !sel.kbFocus) return
        // Past either end, and Shift+Tab before any card is reached, focus leaves the canvas: the
        // default Tab behaviour does that.
        if (tabToCard(board, e.shiftKey)) e.preventDefault()
        return
      }
      if (e.altKey && !mod && e.key in ARROW_DIRS) {
        const dir = ARROW_DIRS[e.key as keyof typeof ARROW_DIRS]
        if (useContextMenu.getState().menu || usePanels.getState().expanded) return
        if (e.shiftKey) {
          if (dir === 'up' || dir === 'down') {
            e.preventDefault()
            reorderInColumn(board, dir === 'up' ? -1 : 1)
          }
          return
        }
        e.preventDefault()
        moveFocus(board, dir)
        return
      }

      // Undo / redo (canvas level; text editors handle their own while focused)
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (board.readOnly) return
        if (e.shiftKey) board.undo.redo()
        else board.undo.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        if (!board.readOnly) board.undo.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        selectAll(board.doc)
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        if (!board.readOnly) duplicateSelection(board.doc)
        return
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        return zoomBy(1.25)
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        return zoomBy(0.8)
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        return zoomTo(1)
      }
      if (e.shiftKey && !mod && !e.altKey && e.key === '!') return zoomToFit(board.doc)
      if (e.shiftKey && !mod && !e.altKey && e.code === 'Digit2') {
        if (!sel.selected.size) return
        e.preventDefault()
        return zoomToSelection(board.doc)
      }
      // Front / back act on a selection; with nothing selected they go back / forward between boards.
      if (mod && !e.altKey && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        if (!sel.selected.size) {
          if (e.key === '[') history.back()
          else history.forward()
          return
        }
        if (board.readOnly) return
        board.undo.stopCapturing()
        return arrange(board.doc, e.key === ']' ? 'front' : 'back')
      }
      if (mod && e.shiftKey && !e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        if (!sel.selected.size) return
        e.preventDefault()
        if (board.readOnly) return
        board.undo.stopCapturing()
        return stepZOrder(board.doc, e.key === 'ArrowUp' ? 'forward' : 'backward')
      }
      // Mod+Enter: the next card below the selected one.
      if (mod && e.key === 'Enter' && !e.altKey && !e.shiftKey) {
        if (board.readOnly || sel.selected.size !== 1 || isActivatableTarget(e.target)) return
        // Lines and pinned comments have nothing to add below: the key falls through.
        if (addCardBelow(board.doc, sel.selected.values().next().value as string)) {
          e.preventDefault()
          return
        }
      }

      if (dispatchCardAction(board, e)) return

      if (board.readOnly || mod || e.altKey) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (sel.selected.size) {
          e.preventDefault()
          deleteSelection(board.doc)
        }
        return
      }
      // Enter on a focused button or link (toolbar, selection toolbar...) activates it instead.
      if (e.key === 'Enter' && sel.selected.size === 1 && !isActivatableTarget(e.target)) {
        e.preventDefault()
        sel.setEditing(Array.from(sel.selected)[0])
        return
      }
      const step = e.shiftKey ? 50 : 10
      if (e.key === 'ArrowLeft') return (e.preventDefault(), nudgeSelection(board.doc, -step, 0))
      if (e.key === 'ArrowRight') return (e.preventDefault(), nudgeSelection(board.doc, step, 0))
      if (e.key === 'ArrowUp') return (e.preventDefault(), nudgeSelection(board.doc, 0, -step))
      if (e.key === 'ArrowDown') return (e.preventDefault(), nudgeSelection(board.doc, 0, step))

      // Quick-add shortcuts (single letters, like many board tools)
      const at = pasteTarget()
      const quick: Record<string, Parameters<typeof addCard>[1]> = { n: 'note', t: 'todo', c: 'column', b: 'board', l: 'link', m: 'comment' }
      const type = quick[e.key.toLowerCase()]
      if (type && !e.shiftKey) {
        e.preventDefault()
        addCard(board.doc, type, {}, { at, edit: type !== 'board', centered: false })
      }
    }

    const onCopy = (e: ClipboardEvent) => {
      const sel = useSelection.getState()
      if (isTyping(e) || !sel.selected.size) return
      copySelection(board.doc, e)
      // A single image also goes out as a picture other apps can paste.
      if (sel.selected.size === 1) {
        const id = sel.selected.values().next().value as string
        if (canOfferImage(board, id)) void copyImageCardToClipboard(board.doc, id, board.boardId)
      }
    }
    const onCut = (e: ClipboardEvent) => {
      if (isTyping(e) || board.readOnly || !useSelection.getState().selected.size) return
      cutSelection(board.doc, e)
    }
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e) || board.readOnly) return
      if (pasteCards(board.doc, e)) return
      void handlePaste(board.doc, e, pasteTarget())
    }

    // Escape's "next Tab leaves" lasts until the pointer is used or focus comes back to the canvas.
    const resetTabExit = () => {
      tabLeavesCanvas = false
    }
    const onFocusIn = (e: FocusEvent) => {
      if (e.target === getCanvasElement()) resetTabExit()
    }

    window.addEventListener('keydown', onKey)
    window.addEventListener('copy', onCopy)
    window.addEventListener('cut', onCut)
    window.addEventListener('paste', onPaste)
    window.addEventListener('pointerdown', resetTabExit, true)
    window.addEventListener('focusin', onFocusIn)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('copy', onCopy)
      window.removeEventListener('cut', onCut)
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('pointerdown', resetTabExit, true)
      window.removeEventListener('focusin', onFocusIn)
      tabLeavesCanvas = false
    }
  }, [board])
}

/** Set by Escape on the canvas: the next Tab uses the browser default, so keyboard users can leave the board. */
let tabLeavesCanvas = false

/**
 * Escape out of a card's editor: focus goes back to the board (not to <body>) with the card as the
 * keyboard-focused one, so a screen reader announces it again and the focus ring shows.
 */
function leaveEditMode(editedId: string) {
  const sel = useSelection.getState()
  sel.setEditing(null)
  const canvas = getCanvasElement()
  const el = getCardElement(editedId)
  if (!canvas || !el || !canvas.contains(el)) {
    // A card outside the canvas (the Unsorted drawer): just leave the editor.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    return
  }
  canvas.focus({ preventScroll: true })
  if (useSelection.getState().selected.has(editedId)) sel.setKbFocus(editedId)
}

/**
 * Ctrl+C on one image card also offers the picture to other apps. The card copy itself already
 * worked, so only try when the picture can go out: the clipboard takes images and the card shows
 * the image from this device (its frame is ready and its bytes are not known missing). Otherwise a
 * failure would show an error for a copy that succeeded.
 */
function canOfferImage(board: BoardContextValue, id: string): boolean {
  const c = board.index.get(id)?.card
  if (!c || c.type !== 'image') return false
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') return false
  if (blobUnavailable(typeof c.blob === 'string' ? c.blob : null)) return false
  return getCardElement(id)?.querySelector('.image-card__frame')?.getAttribute('data-state') === 'ready'
}
