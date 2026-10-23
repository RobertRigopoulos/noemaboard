/**
 * Keyboard focus for text toolbars (Alt+F10 in the editor, Escape back to the text).
 */
import type { Editor } from '@tiptap/core'
import { rovingIndex, type RovingOptions } from './rovingIndex'

/** Attribute on every focusable control of a roving toolbar or menu. */
export const ROVING_ITEM = 'data-rt-item'
/** Attribute on docked text toolbars (rail, document bar, bottom bar). */
export const DOCKED_TOOLBAR = 'data-rt-docked'

function visible(el: Element): boolean {
  return el.getClientRects().length > 0
}

/** Focusable items of a roving group, in DOM order (nested menus excluded). */
export function rovingItems(root: Element): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(`[${ROVING_ITEM}]`)).filter(
    (el) => el.closest('[role="toolbar"], [role="menu"], [role="listbox"]') === root,
  )
}

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true'
}

/**
 * Moves focus inside a roving group for an arrow, Home or End key. Returns the newly focused item,
 * or null when the key does not move focus (the caller then leaves the event alone).
 */
export function moveRovingFocus(root: Element, key: string, opts?: RovingOptions): HTMLElement | null {
  const items = rovingItems(root)
  const current = items.indexOf(document.activeElement as HTMLElement)
  const next = rovingIndex(key, current, items.map(isDisabled), opts)
  if (next === null) return null
  const el = items[next]
  focusRovingItem(root, el)
  return el
}

/** Makes `el` the group's tab stop and focuses it. */
export function focusRovingItem(root: Element, el: HTMLElement): void {
  for (const item of rovingItems(root)) item.tabIndex = item === el ? 0 : -1
  el.focus({ preventScroll: true })
}

/** Focuses the group's current tab stop (or its first enabled item). True when something took focus. */
export function focusRovingGroup(root: Element, which: 'current' | 'first' = 'current'): boolean {
  const items = rovingItems(root).filter((el) => !isDisabled(el))
  const target = (which === 'current' && items.find((el) => el.tabIndex === 0)) || items[0]
  if (!target) return false
  focusRovingItem(root, target)
  return true
}

/** Alt+F10 without a selection bubble: focuses the visible docked text toolbar. */
export function focusDockedToolbar(): boolean {
  const bars = Array.from(document.querySelectorAll(`[${DOCKED_TOOLBAR}]`)).filter(visible)
  return bars.length > 0 && focusRovingGroup(bars[0])
}

/**
 * Gives focus back to the text. ProseMirror keeps the selection in its state while the editor is
 * blurred (mapped through every change since), so focusing without a position restores it exactly.
 */
export function returnToText(editor: Editor | null | undefined): void {
  if (!editor || editor.isDestroyed) return
  editor.commands.focus(null, { scrollIntoView: false })
}
