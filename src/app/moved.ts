/**
 * NoemaBoard's move from its first web address to noemaboard.app (October 2026). Browsers keep
 * boards separately for each address, so people who used the old one keep their boards there until
 * they move them with a backup. public/moved.js sends everyone else on before the app starts.
 */
import { OLD_APP_URL, WEBSITE_URL } from '../config'

const hostOf = (url: string) => new URL(url).hostname

/** True at the old address (only people who already have boards there still end up here). */
export function atOldAddress(hostname: string = location.hostname): boolean {
  return hostname === hostOf(OLD_APP_URL)
}

/** True at noemaboard.app. */
export function atNewAddress(hostname: string = location.hostname): boolean {
  return hostname === hostOf(WEBSITE_URL)
}

/** Until then, new profiles at the new address hear that boards made at the old one are still there. */
export const MOVE_HINT_UNTIL = Date.UTC(2027, 4, 1)
