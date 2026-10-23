/**
 * Who fetches a link preview, and when. Only one person per card fetches (the creator, or whoever
 * last changed its URL) so a board with many open peers does not hit the site many times.
 * Pure: no DOM.
 *
 * States: 'idle' (not fetched yet), 'loading', 'done' (full preview), 'basic' (added in a browser,
 * which cannot read other sites: only the host name is known; the desktop app can load the rest),
 * 'error'.
 */

/** A preview stuck in 'loading' this long (app closed mid-fetch) is retried, and shown as failed. */
export const STALE_LOADING_MS = 45_000
/** A failed preview is retried by its owner after this long. */
export const ERROR_RETRY_MS = 10 * 60_000

export type PreviewState = 'idle' | 'loading' | 'done' | 'basic' | 'error'

export interface PreviewFields {
  url?: unknown
  previewState?: unknown
  previewBy?: unknown
  previewFor?: unknown
  /** When the current fetch started ('loading'); older clients do not write it. */
  previewStartedAt?: unknown
  createdBy?: unknown
  updatedAt?: unknown
}

export function previewOwner(c: PreviewFields): string {
  if (typeof c.previewBy === 'string' && c.previewBy) return c.previewBy
  return typeof c.createdBy === 'string' ? c.createdBy : ''
}

/** True when the stored preview belongs to a different URL (e.g. after an undo of a URL change). */
export function isPreviewStale(c: PreviewFields): boolean {
  return typeof c.previewFor === 'string' && c.previewFor !== '' && c.previewFor !== c.url
}

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** When the current fetch started (the card's last change for previews written by older clients). */
export function loadingSince(c: PreviewFields): number {
  return finite(c.previewStartedAt) ?? finite(c.updatedAt) ?? 0
}

/** A 'loading' preview whose fetch was abandoned (the fetching app was closed mid-fetch). */
export function isLoadingStale(c: PreviewFields, now: number): boolean {
  return c.previewState === 'loading' && now - loadingSince(c) > STALE_LOADING_MS
}

/**
 * Whether `userId` should (re)fetch the preview now. The caller also checks that this device itself
 * asked for the preview (see previewClaims): the doc's previewBy is written by peers.
 */
export function needsPreview(c: PreviewFields, userId: string, now: number): boolean {
  if (!userId || previewOwner(c) !== userId) return false
  if (typeof c.url !== 'string' || !c.url) return false
  switch (c.previewState) {
    case 'loading':
      return isLoadingStale(c, now)
    case 'done':
    case 'basic':
      return isPreviewStale(c)
    case 'error':
      // Transient failures (offline, timeouts) get another chance later.
      return isPreviewStale(c) || now - (finite(c.updatedAt) ?? 0) > ERROR_RETRY_MS
    default:
      // 'idle' and anything unexpected a peer may have written
      return true
  }
}
