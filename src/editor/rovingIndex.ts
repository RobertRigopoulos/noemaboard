/**
 * Keyboard movement inside a roving-tabindex group (toolbars, menus, swatch grids): only one item
 * is in the tab order and the arrow keys move between items.
 */

export interface RovingOptions {
  /**
   * Items per row for grids: Up/Down then move a whole row (without wrapping) while Left/Right
   * still step one item. Omit for a plain list, where all four arrows step one item and wrap.
   */
  columns?: number
}

const BACK = new Set(['ArrowLeft', 'ArrowUp'])
const FORWARD = new Set(['ArrowRight', 'ArrowDown'])

/** First enabled index at or after `from` (stepping by `step`), or -1. */
function scan(disabled: readonly boolean[], from: number, step: number, wrap: boolean): number {
  const n = disabled.length
  for (let i = 0, at = from; i < n; i++, at += step) {
    if (wrap) at = ((at % n) + n) % n
    else if (at < 0 || at >= n) return -1
    if (!disabled[at]) return at
  }
  return -1
}

/**
 * Index to focus after `key`, or null when the key does not move focus (or nothing is enabled).
 * Left/Up go back and Right/Down go forward, wrapping around; Home and End jump to the first and
 * last item. Disabled items are skipped. `current` may be -1 when no item has focus yet.
 */
export function rovingIndex(key: string, current: number, disabled: readonly boolean[], opts: RovingOptions = {}): number | null {
  const n = disabled.length
  if (!n) return null
  let next = -1
  if (key === 'Home') next = scan(disabled, 0, 1, false)
  else if (key === 'End') next = scan(disabled, n - 1, -1, false)
  else if (opts.columns && opts.columns > 1 && (key === 'ArrowUp' || key === 'ArrowDown')) {
    if (current < 0) next = scan(disabled, key === 'ArrowDown' ? 0 : n - 1, key === 'ArrowDown' ? 1 : -1, false)
    else {
      const step = key === 'ArrowDown' ? opts.columns : -opts.columns
      next = scan(disabled, current + step, step, false)
      if (next < 0) return current
    }
  } else if (FORWARD.has(key)) next = current < 0 ? scan(disabled, 0, 1, false) : scan(disabled, current + 1, 1, true)
  else if (BACK.has(key)) next = current < 0 ? scan(disabled, n - 1, -1, false) : scan(disabled, current - 1, -1, true)
  else return null
  return next < 0 ? null : next
}
