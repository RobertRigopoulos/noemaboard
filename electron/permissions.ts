/** Which web permissions the renderer gets (pure, so the policy is unit-tested). */

/**
 * Granted only to the trusted app page itself (app://bundle/ main frame), never to embedded frames.
 * - clipboard-read: the board's "Paste" / "Paste here" menu items read the clipboard.
 * - clipboard-sanitized-write: "Copy" puts cards on the clipboard.
 */
export const APP_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'notifications',
  'persistent-storage',
])

export interface PermissionContext {
  /** The requesting page is the app itself (app://bundle/ or the dev server). */
  trusted: boolean
  /** Only known for permission requests; checks pass undefined. */
  isMainFrame?: boolean
}

export function isPermissionAllowed(permission: string, ctx: PermissionContext): boolean {
  // Fullscreen is harmless and needed by embedded video players.
  if (permission === 'fullscreen') return true
  if (ctx.isMainFrame === false) return false
  return ctx.trusted && APP_PERMISSIONS.has(permission)
}
