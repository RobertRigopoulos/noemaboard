/**
 * What a modal dialog does with a key pressed while focus is *outside* it (pure, unit-tested).
 *
 * Board shortcuts are window listeners, so a dialog that only isolates keys typed inside its own
 * element stops protecting the board as soon as focus slips out (a click on the backdrop, a focused
 * element that was removed, a toast). Dialog.tsx runs this from a capture-phase window listener
 * while any dialog is open; every action except 'ignore' also stops the event from propagating.
 */

/** Elements that stay usable above an open modal (toasts). */
export const MODAL_EXEMPT_SELECTOR = '[data-modal-exempt]'

export type StrayKeyAction =
  /** Not ours to handle: the key is inside the dialog (its own handlers run) or in an exempt overlay. */
  | 'ignore'
  /** Tab / Shift+Tab: move focus to the first / last control of the dialog. */
  | 'tab'
  /** Escape: close the dialog if it is dismissible. */
  | 'dismiss'
  /**
   * Put focus back into the dialog, keeping the key's default so a typed character lands in the
   * dialog's text field and browser shortcuts still work.
   */
  | 'refocus'
  /** Same, but cancel the default: Enter/Space must not activate whatever receives focus. */
  | 'refocus-block'

export interface KeyLike {
  key: string
}

export function strayKeyAction(e: KeyLike, inDialog: boolean, exempt: boolean): StrayKeyAction {
  if (inDialog) return 'ignore'
  // Tab always leads back into the dialog, even from a toast.
  if (e.key === 'Tab') return 'tab'
  if (exempt) return 'ignore'
  if (e.key === 'Escape') return 'dismiss'
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') return 'refocus-block'
  return 'refocus'
}
