/** Platform-aware labels for keyboard shortcut hints. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** Prefix for Ctrl/Cmd shortcuts: '⌘' on Apple platforms, 'Ctrl+' elsewhere. */
export const modKey = isMac ? '⌘' : 'Ctrl+'

export const shiftKey = isMac ? '⇧' : 'Shift+'

export const deleteKey = isMac ? '⌫' : 'Del'
