/**
 * URL policy for links inside rich text. Link marks arrive from untrusted peers, so every href is
 * checked before it is rendered or opened: only absolute http(s) and mailto URLs are clickable.
 */

const MAX_URL_LENGTH = 2048
// Whitespace and control characters browsers ignore inside a scheme ("java\tscript:").
// Built from code points so the source stays plain ASCII.
const IGNORED_CHARS = new RegExp(
  `[${[
    [0x00, 0x20],
    [0x7f, 0xa0],
    [0x1680, 0x1680],
    [0x180e, 0x180e],
    [0x2000, 0x2029],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
  ]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
  'g',
)
const SCHEME = /^([a-z][a-z0-9+.-]*):/i

function stripIgnored(url: string): string {
  return url.replace(IGNORED_CHARS, '')
}

/** True for absolute http(s)/mailto URLs that may be opened or rendered as a clickable href. */
export function isSafeHref(url: unknown): url is string {
  if (typeof url !== 'string' || !url || url.length > MAX_URL_LENGTH) return false
  const compact = stripIgnored(url)
  const m = SCHEME.exec(compact)
  if (!m) return false
  const scheme = m[1].toLowerCase()
  if (scheme === 'mailto') return compact.length > 7
  if (scheme !== 'http' && scheme !== 'https') return false
  try {
    const parsed = new URL(url.trim())
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !!parsed.hostname
  } catch {
    return false
  }
}

/**
 * Policy for the TipTap link mark: anything with a scheme must be http(s)/mailto; scheme-less values
 * (e.g. autolinked "example.com") are allowed because they are normalised before use.
 */
export function isAllowedLinkTarget(url: unknown): boolean {
  if (url === null || url === undefined || url === '') return true
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return false
  const m = SCHEME.exec(stripIgnored(url))
  if (!m) return true
  return /^(https?|mailto)$/i.test(m[1])
}

const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/
const BARE_HOST = /^(localhost|[\w-]+(\.[\w-]+)+)(:\d{1,5})?([/?#]\S*)?$/i

/**
 * Turns what a person typed into a link field (or a scheme-less href from a peer) into a safe
 * absolute URL, or null. "example.com/x" becomes "https://example.com/x", "a@b.co" becomes a mailto.
 */
export function normalizeLinkInput(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (!value || value.length > MAX_URL_LENGTH || /\s/.test(value)) return null
  if (SCHEME.test(stripIgnored(value)) && !/^[\w.-]+:\d/.test(value)) return isSafeHref(value) ? value : null
  if (value.startsWith('//')) return isSafeHref(`https:${value}`) ? `https:${value}` : null
  if (EMAIL.test(value)) return `mailto:${value}`
  if (!BARE_HOST.test(value)) return null
  const url = `https://${value}`
  return isSafeHref(url) ? url : null
}

/** Attributes every rendered link gets, regardless of what a peer stored on the mark. */
export const LINK_HTML_ATTRIBUTES = { rel: 'noopener noreferrer nofollow', target: '_blank' } as const
