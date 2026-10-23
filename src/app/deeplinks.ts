/** Routes invite deep links from the desktop shell (noema://join/...) into the app. */
import { desktop } from '../lib/desktop'
import { navigate } from './router'

/**
 * Maps a deep link (noema://join/<payload>, or any link containing join/<payload>) to the
 * in-app route `/join/<payload>`. Returns null for anything else.
 */
export function deepLinkToRoute(url: unknown): string | null {
  if (typeof url !== 'string' || url.length > 8192) return null
  const m = url.match(/join\/([A-Za-z0-9_-]{8,4096})(?![A-Za-z0-9_-])/)
  return m ? `/join/${m[1]}` : null
}

let initialized = false

export function initDeepLinks(): void {
  if (initialized || !desktop) return
  initialized = true
  const api = desktop
  const open = (url: string) => {
    const route = deepLinkToRoute(url)
    if (route) navigate(route)
  }
  // Subscribe first so a link arriving while we fetch the pending one is not lost.
  api.onOpenUrl(open)
  void api
    .takePendingOpenUrl()
    .then((url) => {
      if (url) open(url)
    })
    .catch(() => {})
}
