/**
 * Ctrl+Shift+V (Cmd+Shift+V) pastes plain text: no Markdown conversion on the board or in open text.
 * A paste event does not say how it was started, so the shortcut is noted when its key goes down;
 * the paste event follows right after it.
 */

/** How long after the shortcut's key press its paste event is expected. */
const PASTE_WINDOW_MS = 1000

let plainAt = 0

type PasteKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>

/** Notes a paste shortcut (window keydown, capture phase). Exported for tests. */
export function notePasteKey(e: PasteKey, now: number = Date.now()): void {
  const v = e.code === 'KeyV' || e.key === 'v' || e.key === 'V'
  if (!v || !(e.ctrlKey || e.metaKey)) return
  plainAt = e.shiftKey && !e.altKey ? now : 0
}

/** True while a paste started with the plain-text shortcut is being handled. */
export function isPlainTextPaste(now: number = Date.now()): boolean {
  return plainAt > 0 && now - plainAt < PASTE_WINDOW_MS
}

/** Forgets the shortcut once its paste has been handled, so a later paste from a menu is not plain. */
export function endPlainPaste(): void {
  plainAt = 0
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => notePasteKey(e), true)
  window.addEventListener(
    'paste',
    () => {
      // After every handler of this paste (they run during the event) has seen it.
      if (plainAt) window.setTimeout(endPlainPaste, 0)
    },
    true,
  )
}
