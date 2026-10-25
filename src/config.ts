/** Product-wide constants. Rename the app here. */
export const APP_NAME = 'NoemaBoard'
/** Custom URL scheme registered by the desktop app for invite links: noema://join#... */
export const PROTOCOL = 'noema'
/** Namespaces signaling topics so we only meet peers running this app. Bump on breaking protocol changes. */
export const APP_ID = 'noema-p2p-v1'
/** True when running inside the Electron shell (preload exposes window.desktop). */
export const IS_DESKTOP = typeof window !== 'undefined' && !!(window as unknown as { desktop?: unknown }).desktop

/** The https address this web build is served from (empty for the desktop app and local development). */
function hostedBase(): string {
  if (typeof location === 'undefined' || IS_DESKTOP) return ''
  if (location.protocol !== 'https:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return ''
  return location.origin + location.pathname.replace(/[^/]*$/, '')
}

/**
 * Public URL of the hosted web app, used to make invite links clickable for people who do not
 * have the desktop app. Baked into builds (VITE_PUBLIC_URL); a hosted web build falls back to the
 * address it is served from. Empty = desktop-only links.
 */
export const PUBLIC_URL: string = (import.meta.env.VITE_PUBLIC_URL as string | undefined) || hostedBase()

/**
 * Team sync server used for shared boards that do not name one. 'same-origin' means the web app
 * is hosted together with the relay (Cloudflare team hosting: <host>/relay). Empty = peer-to-peer only.
 */
const RELAY_SETTING = (import.meta.env.VITE_DEFAULT_RELAY as string | undefined) ?? ''
export const DEFAULT_RELAY: string =
  RELAY_SETTING === 'same-origin' ? (hostedBase() ? `${location.origin}/relay` : '') : RELAY_SETTING

export const HOME_BOARD_ID = 'home'

/** App version from package.json (injected at build time). */
export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) || '0.0.0'

/** Public source repository. Set this after publishing the project (used for docs and "About" links). */
export const REPO_URL = 'https://github.com/RobertRigopoulos/noemaboard'

/** The public website (front page); the web app is at /app/ there. */
export const WEBSITE_URL = 'https://noemaboard.app'

/** Where the public web app lived until October 2026. public/moved.js sends new visitors on to WEBSITE_URL. */
export const OLD_APP_URL = 'https://app.noemaboard.workers.dev/app/'

/** Community server where people report problems and suggest ideas (a never-expiring Discord invite). */
export const COMMUNITY_URL = 'https://discord.gg/4gcUz2GP3w'

export const DEFAULT_STUN = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]
