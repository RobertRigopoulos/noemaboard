/** Keyboard model shared by the context menu, its submenus and the selection toolbar dropdowns. */
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Focusable items of `root` itself: items inside a nested (non-inline) menu belong to that menu. */
export function menuItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-mi]')).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.closest('[role="menu"]') === root,
  )
}

export function focusFirstItem(root: HTMLElement | null) {
  if (root) menuItems(root)[0]?.focus({ preventScroll: true })
}

/**
 * Roving focus: Up/Down move between rows (a row is a single item, or the colour swatches),
 * Left/Right move within a row, Home/End jump, Tab cycles, Escape closes.
 */
export function onMenuKeyDown(e: ReactKeyboardEvent, root: HTMLElement | null, close: () => void) {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  if (!root) return
  const items = menuItems(root)
  if (!items.length) return
  const cur = items.indexOf(document.activeElement as HTMLElement)
  const rowOf = (i: number) => items[i]?.dataset.row ?? `item-${i}`
  const focus = (i: number) => items[(i + items.length) % items.length]?.focus({ preventScroll: false })
  const nextRowStart = (from: number, dir: 1 | -1) => {
    const row = rowOf(from)
    let i = from
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length
      if (rowOf(i) !== row) break
    }
    // Moving up lands on the first item of the previous row.
    if (dir === -1) while (i > 0 && rowOf(i - 1) === rowOf(i)) i--
    return i
  }
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      focus(cur < 0 ? 0 : nextRowStart(cur, 1))
      break
    case 'ArrowUp':
      e.preventDefault()
      focus(cur < 0 ? items.length - 1 : nextRowStart(cur, -1))
      break
    case 'Tab':
      e.preventDefault()
      focus(cur < 0 ? 0 : nextRowStart(cur, e.shiftKey ? -1 : 1))
      break
    case 'ArrowRight':
    case 'ArrowLeft': {
      if (cur < 0) return
      const dir = e.key === 'ArrowRight' ? 1 : -1
      if (rowOf(cur + dir) === rowOf(cur) && cur + dir >= 0 && cur + dir < items.length) {
        e.preventDefault()
        focus(cur + dir)
      }
      break
    }
    case 'Home':
      e.preventDefault()
      focus(0)
      break
    case 'End':
      e.preventDefault()
      focus(items.length - 1)
      break
  }
  // Keep board shortcuts (N, T, Delete...) from firing while the menu has focus.
  e.stopPropagation()
}
