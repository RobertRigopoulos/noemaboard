/** Deep link helpers for the `noema://` scheme (pure, unit-tested). */

export const MAX_DEEP_LINK_LENGTH = 8192

/** Normalizes a candidate deep link; returns null unless it uses our scheme and looks sane. */
export function normalizeDeepLink(value: unknown, scheme: string): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v.length === 0 || v.length > MAX_DEEP_LINK_LENGTH) return null
  if (!v.toLowerCase().startsWith(`${scheme.toLowerCase()}:`)) return null
  // No whitespace or control characters: a deep link is always one URL-safe token.
  // oxlint-disable-next-line no-control-regex -- matching control characters is intended
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return null
  return v
}

/**
 * Holds invite links until the renderer listens for them. The newest unread link wins: if
 * several arrive before the app is ready, only the last click matters to the user.
 */
export class DeepLinkInbox {
  private pending: string | null = null
  private deliver: ((url: string) => boolean) | null = null

  push(url: string): void {
    if (this.deliver?.(url)) return
    this.pending = url
  }

  take(): string | null {
    const url = this.pending
    this.pending = null
    return url
  }

  /**
   * Set while the renderer has an onOpenUrl subscriber; null queues links again. The function
   * returns false when it could not deliver (renderer gone), keeping the link pending.
   */
  setDelivery(fn: ((url: string) => boolean) | null): void {
    this.deliver = fn
  }
}

/**
 * Finds a deep link in a process argv (Windows/Linux pass it as an argument on cold start and
 * to the 'second-instance' event). Returns the last match.
 */
export function findDeepLink(argv: readonly string[], scheme: string): string | null {
  for (let i = argv.length - 1; i >= 0; i--) {
    const link = normalizeDeepLink(argv[i], scheme)
    if (link) return link
  }
  return null
}
