/** URL helpers for link cards, drops and pastes. Pure: no DOM, safe to unit test in Node. */

export const MAX_URL_LENGTH = 2048

/** At most this many links are created from one drop of a URI list. */
export const MAX_URIS_PER_DROP = 20

const SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
const SCHEME = /^[a-z][a-z0-9+.-]*:/i
/** `host:port/...` looks like a scheme but is a host with a port. */
const HOST_WITH_PORT = /^[a-z0-9][a-z0-9.-]*:\d{1,5}(?:[/?#]|$)/i

/**
 * Turns user input into a canonical http(s) URL, or null when it is not a usable web link.
 * Adds https:// when the scheme is missing, rejects every other scheme and any embedded
 * credentials (user:pass@host), which are a classic phishing trick.
 */
export function normalizeUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  // Wrappers people copy along from mail clients and markdown: <https://...>, "https://..."
  const wrapped = /^<(.+)>$/s.exec(s) ?? /^"(.+)"$/s.exec(s) ?? /^'(.+)'$/s.exec(s)
  if (wrapped) s = wrapped[1].trim()
  if (!s || s.length > MAX_URL_LENGTH || /\s/.test(s)) return null
  if (s.startsWith('//')) s = 'https:' + s
  else if (!SCHEME_WITH_SLASHES.test(s)) {
    if (SCHEME.test(s) && !HOST_WITH_PORT.test(s)) return null
    s = 'https://' + s
  }
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (!isPlausibleHost(u.hostname)) return null
  return u.href.length > MAX_URL_LENGTH ? null : u.href
}

/** Host names a person would actually type: a dotted name with a real-looking TLD, localhost or an IP. */
export function isPlausibleHost(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '').toLowerCase()
  if (!host) return false
  if (host === 'localhost') return true
  if (host.startsWith('[') && host.endsWith(']')) return true // IPv6 literal (already validated by URL)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true
  if (!host.includes('.')) return false
  return /\.([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(host)
}

/** True for absolute http(s) URLs (used before handing a URL to openExternal or a fetch). */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH) return false
  try {
    const u = new URL(v)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password
  } catch {
    return false
  }
}

/**
 * Text that is exactly one web link (pasted or dropped). Requires an explicit http(s):// or www.
 * prefix so that ordinary words with dots ("notes.txt", "e.g.") stay text.
 */
export function extractSingleUrl(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const s = text.trim()
  if (!s || /\s/.test(s)) return null
  if (!/^(https?:\/\/|www\.)/i.test(s)) return null
  return normalizeUrl(s)
}

/** Parses a text/uri-list payload (RFC 2483): one URI per line, `#` lines are comments. */
export function parseUriList(data: unknown, max = MAX_URIS_PER_DROP): string[] {
  if (typeof data !== 'string' || !data) return []
  const out: string[] = []
  for (const line of data.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (!/^https?:\/\//i.test(s)) continue
    const url = normalizeUrl(s)
    if (url && !out.includes(url)) out.push(url)
    if (out.length >= max) break
  }
  return out
}

/** Host for display: "www.example.com" -> "example.com". Empty string for invalid input. */
export function hostLabel(url: unknown): string {
  if (typeof url !== 'string' || !url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i

/** Whether a URL's path ends in a typical image extension. */
export function looksLikeImageUrl(url: string): boolean {
  try {
    return IMAGE_EXT.test(new URL(url).pathname)
  } catch {
    return false
  }
}
