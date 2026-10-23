/**
 * Space and Enter on a focused button must activate that button. The board listens for both on
 * the window (Space = hold to pan, Enter = edit the selected card) and cancels their default, which
 * would otherwise swallow the activation. Chrome drawn over the canvas (header, rail, selection
 * toolbar, zoom pill, welcome card, presentation exit) stops these keys at its own element.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Controls a keyboard user activates with Space or Enter. */
export const ACTIVATABLE_SELECTOR = [
  'button',
  'a[href]',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="tab"]',
].join(', ')

export interface KeyEventLike {
  key: string
  code?: string
  target: EventTarget | null
}

export function isActivationKey(e: Pick<KeyEventLike, 'key' | 'code'>): boolean {
  return e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space'
}

/** True when Space/Enter is aimed at a button-like control. */
export function activatesControl(e: KeyEventLike): boolean {
  if (!isActivationKey(e)) return false
  const t = e.target as { closest?: (selector: string) => unknown } | null
  return !!t && typeof t.closest === 'function' && !!t.closest(ACTIVATABLE_SELECTOR)
}

/**
 * onKeyDown for chrome containers: keeps Space/Enter on their controls from reaching the board's
 * window shortcuts, so the browser's normal button activation happens. Other keys pass through.
 */
export function keepControlKeys(e: ReactKeyboardEvent) {
  if (activatesControl(e)) e.stopPropagation()
}
