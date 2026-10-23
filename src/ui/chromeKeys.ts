/**
 * App-level keys handled by the board chrome (pure decision; BoardChrome runs the action).
 * Card and canvas keys live in src/board/shortcuts.ts; with a selection, Mod+[ and Mod+] belong to
 * the canvas (z-order), without one they navigate history here.
 */

export type ChromeAction =
  | 'search-all'
  | 'search-board'
  | 'print'
  | 'shortcuts'
  | 'quick-note'
  | 'back'
  | 'forward'
  | 'parent'
  | 'card-menu'
  | 'selection-toolbar'

export interface ChromeKeyEvent {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export interface ChromeKeyState {
  /** Focus is in a text field or a card editor. */
  typing: boolean
  /** Cards are selected on the board. */
  hasSelection: boolean
  presenting: boolean
  isHome: boolean
}

export function chromeKeyAction(e: ChromeKeyEvent, s: ChromeKeyState): ChromeAction | null {
  const mod = e.ctrlKey || e.metaKey
  const letter = (l: string) => e.code === `Key${l}` || e.key.toLowerCase() === l.toLowerCase()
  if (mod && !e.altKey && letter('F')) {
    // Replaces the browser's find-in-page, which cannot see cards outside the viewport anyway.
    if (s.presenting) return null
    return e.shiftKey ? 'search-board' : 'search-all'
  }
  if (mod && !e.altKey && !e.shiftKey && letter('P')) return 'print'
  if (s.typing) return null
  // Cards are focused through the canvas (aria-activedescendant), so the browser's own keyboard
  // context menu would target the canvas: with a selection these keys open the card menu instead.
  // Presentation mode hides both the menu and the toolbar.
  const withCards = s.hasSelection && !s.presenting
  if (!mod && !e.altKey && ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return withCards ? 'card-menu' : null
  if (e.altKey && !mod && !e.shiftKey && e.key === 'F10') return withCards ? 'selection-toolbar' : null
  if (e.key === '?' && !mod && !e.altKey) return 'shortcuts'
  // Option changes e.key on macOS: match the physical key.
  if (mod && e.altKey && !e.shiftKey && e.code === 'KeyN') return 'quick-note'
  if (mod && !e.altKey && !e.shiftKey && (e.key === '[' || e.key === ']' || e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    if (s.hasSelection) return null
    return e.key === '[' || (e.key !== ']' && e.code === 'BracketLeft') ? 'back' : 'forward'
  }
  if (mod && !e.altKey && !e.shiftKey && letter('U') && !s.isHome) return 'parent'
  return null
}

/** The board to open for "parent board": the one before the current board in its breadcrumb chain. */
export function parentInChain(chain: readonly { id: string }[], currentId: string): string | null {
  const i = chain.findIndex((c) => c.id === currentId)
  return i > 0 ? chain[i - 1].id : null
}

/** Mouse button 3 is "back", 4 is "forward" (the side buttons of most mice). */
export function mouseNavAction(button: number): 'back' | 'forward' | null {
  return button === 3 ? 'back' : button === 4 ? 'forward' : null
}
