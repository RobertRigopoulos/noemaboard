/**
 * Pure helpers for link previews: content-type/charset handling, HTML <head> metadata
 * extraction (OpenGraph, Twitter cards, <title>, icons) and image type sniffing.
 * Everything returned here is plain text or a validated absolute http(s) URL.
 */
import { Parser } from 'htmlparser2'
import type { LinkPreview } from '../src/lib/desktop'

export const LIMITS = {
  title: 300,
  description: 1000,
  siteName: 120,
  url: 2048,
} as const

export interface ContentType {
  mime: string
  charset: string | null
}

export function parseContentType(header: string | null | undefined): ContentType {
  if (!header) return { mime: '', charset: null }
  const [type, ...params] = header.split(';')
  let charset: string | null = null
  for (const p of params) {
    const m = p.trim().match(/^charset\s*=\s*"?([^";\s]+)"?/i)
    if (m) charset = m[1].toLowerCase()
  }
  return { mime: type.trim().toLowerCase(), charset }
}

export const isHtmlMime = (mime: string) => mime === 'text/html' || mime === 'application/xhtml+xml'

/** Latin-1 view of bytes: safe for ASCII sniffing whatever the real encoding is. */
function latin1(bytes: Uint8Array, max = bytes.length): string {
  let s = ''
  const n = Math.min(max, bytes.length)
  for (let i = 0; i < n; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(n, i + 8192)))
  return s
}

/** Index just past `</head` (case-insensitive) or -1. */
export function findHeadEnd(bytes: Uint8Array, from = 0): number {
  const s = latin1(bytes).toLowerCase()
  const i = s.indexOf('</head', Math.max(0, from))
  return i < 0 ? -1 : i + 6
}

/** Returns true if the text decoder knows this label. */
function isKnownEncoding(label: string): boolean {
  try {
    new TextDecoder(label)
    return true
  } catch {
    return false
  }
}

/**
 * Picks the document encoding like a browser would (simplified): BOM, then HTTP header charset,
 * then <meta charset> / <meta http-equiv> in the first 4 KB, then UTF-8.
 */
export function sniffCharset(bytes: Uint8Array, headerCharset: string | null): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (headerCharset && isKnownEncoding(headerCharset)) return headerCharset
  const head = latin1(bytes, 4096)
  const m =
    head.match(/<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i) ??
    head.match(/<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([a-z0-9_:.-]+)/i)
  if (m) {
    const label = m[1].toLowerCase()
    // A document cannot really declare itself UTF-16 in ASCII-compatible bytes.
    if (label.startsWith('utf-16')) return 'utf-8'
    if (isKnownEncoding(label)) return label
  }
  return 'utf-8'
}

export function decodeHtml(bytes: Uint8Array, headerCharset: string | null): string {
  return new TextDecoder(sniffCharset(bytes, headerCharset)).decode(bytes)
}

/** Collapses whitespace, strips control characters and truncates. */
export function cleanText(s: string | undefined | null, max: number): string {
  if (!s) return ''
  // oxlint-disable-next-line no-control-regex -- matching control characters is intended
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\ufeff]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Resolves a possibly-relative URL and keeps it only if it is http(s) and reasonably short. */
export function absoluteHttpUrl(value: string | undefined | null, base: string): string | null {
  if (!value) return null
  const v = value.trim()
  if (!v || v.length > LIMITS.url) return null
  try {
    const u = new URL(v, base)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    if (u.username || u.password) return null
    const s = u.toString()
    return s.length > LIMITS.url ? null : s
  } catch {
    return null
  }
}

interface HeadData {
  meta: Map<string, string>
  title: string
  icons: { href: string; rel: string; sizes: string }[]
  baseHref: string | null
}

/** Collects metadata from the document head; stops at </head> or the first body content. */
export function extractHead(html: string): HeadData {
  const data: HeadData = { meta: new Map(), title: '', icons: [], baseHref: null }
  let done = false
  let inTitle = false
  let titleSeen = false
  let svgDepth = 0
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (done) return
        if (name === 'svg') svgDepth++
        if (svgDepth > 0) return
        if (name === 'body') {
          done = true
          return
        }
        if (name === 'title' && !titleSeen) inTitle = true
        else if (name === 'meta') {
          const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? '').trim().toLowerCase()
          const content = attrs.content
          // First occurrence wins (og:image may repeat; the first is the primary one).
          if (key && typeof content === 'string' && key.length <= 64 && !data.meta.has(key)) data.meta.set(key, content.slice(0, 4096))
        } else if (name === 'link') {
          const rel = (attrs.rel ?? '').toLowerCase().split(/\s+/)
          if (rel.includes('icon') || rel.includes('apple-touch-icon') || rel.includes('apple-touch-icon-precomposed')) {
            if (attrs.href && data.icons.length < 32) data.icons.push({ href: attrs.href, rel: rel.join(' '), sizes: attrs.sizes ?? '' })
          }
        } else if (name === 'base' && attrs.href && data.baseHref === null) data.baseHref = attrs.href
      },
      ontext(text) {
        if (!done && inTitle && data.title.length < 4096) data.title += text
      },
      onclosetag(name) {
        if (name === 'svg' && svgDepth > 0) svgDepth--
        else if (name === 'title' && inTitle) {
          inTitle = false
          titleSeen = true
        } else if (name === 'head') done = true
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )
  parser.write(html)
  parser.end()
  return data
}

function iconScore(icon: { rel: string; sizes: string; href: string }): number {
  // Prefer a reasonably large raster icon; SVG favicons are fine for <img> too.
  const m = icon.sizes.match(/(\d+)x(\d+)/i)
  const size = m ? Number(m[1]) : icon.rel.includes('apple-touch-icon') ? 180 : 32
  const closeness = -Math.abs(Math.min(size, 256) - 64)
  return closeness + (icon.rel.split(' ').includes('icon') ? 5 : 0)
}

const hostLabel = (u: URL) => u.hostname.replace(/^www\./, '')

function fileNameFromUrl(u: URL): string {
  const last = u.pathname.split('/').filter(Boolean).pop()
  if (!last) return hostLabel(u)
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** Builds a preview from a decoded HTML document fetched from `pageUrl` (the final URL). */
export function parseLinkPreview(html: string, pageUrl: string): LinkPreview {
  const page = new URL(pageUrl)
  const head = extractHead(html)
  const meta = (...keys: string[]) => {
    for (const k of keys) {
      const v = head.meta.get(k)
      if (v && v.trim()) return v
    }
    return ''
  }
  const base = absoluteHttpUrl(head.baseHref, page.toString()) ?? page.toString()

  const title = cleanText(meta('og:title', 'twitter:title') || head.title || meta('title'), LIMITS.title) || hostLabel(page)
  const description = cleanText(meta('og:description', 'twitter:description', 'description'), LIMITS.description)
  const siteName = cleanText(meta('og:site_name', 'application-name', 'apple-mobile-web-app-title'), LIMITS.siteName) || hostLabel(page)
  const image = absoluteHttpUrl(
    meta('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src', 'image'),
    base,
  )
  const bestIcon = [...head.icons].sort((a, b) => iconScore(b) - iconScore(a))[0]
  const favicon = absoluteHttpUrl(bestIcon?.href, base) ?? absoluteHttpUrl('/favicon.ico', page.toString())

  return { url: page.toString(), title, description, siteName, image, favicon }
}

/** Preview for a URL that is not an HTML page (PDF, image, archive...). */
export function basicPreview(pageUrl: string, isImage: boolean): LinkPreview {
  const page = new URL(pageUrl)
  return {
    url: page.toString(),
    title: cleanText(fileNameFromUrl(page), LIMITS.title) || hostLabel(page),
    description: '',
    siteName: hostLabel(page),
    image: isImage ? page.toString() : null,
    favicon: absoluteHttpUrl('/favicon.ico', page.toString()),
  }
}

/**
 * Detects common raster image formats from magic bytes. SVG is deliberately not recognised:
 * it can carry scripts and we never accept it from the network.
 */
export function sniffImageMime(b: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((v, j) => b[i + j] === v)
  const ascii = (i: number, s: string) => at(i, ...Array.from(s, (c) => c.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(...b.subarray(8, 12))
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  if (ascii(0, 'BM') && b.length > 26) return 'image/bmp'
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon'
  return null
}

/** Accepted image MIME types from the network (raster only). */
export function isAcceptedImageMime(mime: string): boolean {
  return /^image\/[a-z0-9.+-]{1,64}$/.test(mime) && !mime.includes('svg')
}
