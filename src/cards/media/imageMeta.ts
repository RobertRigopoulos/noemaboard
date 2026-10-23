/** Byte/text level image inspection used during import. Pure (Blob and atob only), unit-testable. */

const MAX_SIDE = 20_000

const UNIT_PX: Record<string, number> = { '': 1, px: 1, pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 }

function parseLength(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*([0-9]*\.?[0-9]+(?:e[+-]?\d+)?)\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(v)
  if (!m) return null // percentages, em, etc. have no intrinsic size
  const n = Number(m[1]) * UNIT_PX[(m[2] ?? '').toLowerCase()]
  return Number.isFinite(n) && n > 0 ? n : null
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2]) : undefined
}

/**
 * Intrinsic size of an SVG from its root element (width/height, else viewBox). Browsers report
 * 0 or a 300x150 default for SVGs without explicit sizes, so we read the markup instead.
 */
export function parseSvgSize(svg: string): { w: number; h: number } | null {
  const m = /<svg\b([^>]*)>/i.exec(svg)
  if (!m) return null
  const attrs = m[1]
  const w = parseLength(attr(attrs, 'width'))
  const h = parseLength(attr(attrs, 'height'))
  const vb = attr(attrs, 'viewBox')
    ?.trim()
    .split(/[\s,]+/)
    .map(Number)
  const vbW = vb && vb.length === 4 && vb[2] > 0 ? vb[2] : null
  const vbH = vb && vb.length === 4 && vb[3] > 0 ? vb[3] : null
  let out: { w: number; h: number } | null = null
  if (w && h) out = { w, h }
  else if (w && vbW && vbH) out = { w, h: (w * vbH) / vbW }
  else if (h && vbW && vbH) out = { w: (h * vbW) / vbH, h }
  else if (vbW && vbH) out = { w: vbW, h: vbH }
  if (!out) return null
  return { w: Math.min(MAX_SIDE, Math.max(1, Math.round(out.w))), h: Math.min(MAX_SIDE, Math.max(1, Math.round(out.h))) }
}

/** Decodes a data: URL into a Blob (null if malformed or larger than `maxBytes`). */
export function dataUrlToBlob(url: string, maxBytes: number): Blob | null {
  const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/s.exec(url)
  if (!m) return null
  const mime = (m[1] || 'text/plain').toLowerCase()
  const isBase64 = /;base64/i.test(m[2])
  try {
    if (isBase64) {
      const b64 = m[3].replace(/\s+/g, '')
      if ((b64.length * 3) / 4 > maxBytes + 3) return null
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Blob([bytes], { type: mime })
    }
    const text = decodeURIComponent(m[3])
    if (text.length > maxBytes) return null
    return new Blob([text], { type: mime })
  } catch {
    return null
  }
}

const ascii = (b: Uint8Array, at: number, s: string) => {
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

function indexOfAscii(b: Uint8Array, s: string, limit = b.length): number {
  const end = Math.min(limit, b.length) - s.length
  for (let i = 0; i <= end; i++) if (ascii(b, i, s)) return i
  return -1
}

/**
 * Whether the first bytes of an image show it is (or may be) animated. Animated images keep their
 * original bytes: re-encoding through a canvas would keep only the first frame.
 */
export function isAnimatedImage(head: Uint8Array, mime: string): boolean {
  const m = mime.toLowerCase()
  if (m === 'image/gif') return true
  if (m === 'image/webp') {
    // RIFF....WEBPVP8X, flags byte at offset 20, bit 1 = animation
    return ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP') && ascii(head, 12, 'VP8X') && (head[20] & 0x02) !== 0
  }
  if (m === 'image/png' || m === 'image/apng') {
    // APNG declares an acTL chunk before the first IDAT.
    const actl = indexOfAscii(head, 'acTL')
    const idat = indexOfAscii(head, 'IDAT')
    return actl >= 0 && (idat < 0 || actl < idat)
  }
  if (m === 'image/avif') {
    // Image sequences use the 'avis' brand in the ftyp box.
    return ascii(head, 4, 'ftyp') && indexOfAscii(head, 'avis', 64) >= 0
  }
  return false
}
