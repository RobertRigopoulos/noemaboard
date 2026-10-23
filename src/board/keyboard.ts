/** Focus helpers shared by board keyboard handlers. */

function targetElement(t: EventTarget | null): HTMLElement | null {
  const el = t as HTMLElement | null
  return el && typeof el.closest === 'function' ? el : null
}

/** Typing into a field or rich-text editor: board shortcuts must not react. */
export function isTypingTarget(t: EventTarget | null): boolean {
  return !!targetElement(t)?.closest('input, textarea, select, [contenteditable="true"]')
}

/**
 * A focused control that Enter or Space activates itself (buttons, links, menu items...). Board
 * shortcuts on those keys must leave such keys alone, or keyboard users cannot press the control.
 */
export function isActivatableTarget(t: EventTarget | null): boolean {
  return !!targetElement(t)?.closest(
    'button, a[href], summary, select, input, textarea, [contenteditable="true"], [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="link"]',
  )
}

/**
 * On Windows a lone Alt keyup focuses the app menu bar. After an Alt-drag the Alt release is part
 * of the gesture, so the next keyup is swallowed when it is Alt.
 */
export function swallowNextAltKeyup() {
  if (typeof window === 'undefined') return
  const done = () => {
    window.removeEventListener('keyup', onUp, true)
    clearTimeout(timer)
  }
  const onUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt') e.preventDefault()
    done()
  }
  const timer = setTimeout(done, 10_000)
  window.addEventListener('keyup', onUp, true)
}
