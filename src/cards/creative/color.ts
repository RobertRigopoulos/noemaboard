/**
 * Color helpers for swatch cards and sketch pens: parsing user/peer input, formatting and
 * WCAG contrast. Pure functions (no DOM) so they can be unit-tested in Node.
 */

export interface RGB {
  r: number
  g: number
  b: number
}

export interface HSL {
  /** 0..360 */
  h: number
  /** 0..100 */
  s: number
  /** 0..100 */
  l: number
}

export const DEFAULT_SWATCH_HEX = '#7c6cf0'

/** Text colors used on top of arbitrary colors (dark ink matches --text of the light theme). */
export const DARK_INK = '#1f2328'
export const LIGHT_INK = '#ffffff'

const MAX_INPUT = 64
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/
const NUM = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?'
const FUNC_RE = /^(rgba?|hsla?)\(\s*([^()]*)\)$/
const NUMBER_RE = new RegExp(`^(${NUM})(%|deg|grad|rad|turn)?$`)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Strict check for the normalized form stored in docs: '#rrggbb' lowercase. */
export function isHex6(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/.test(v)
}

/**
 * Parses a color typed by a person or received from a peer and returns '#rrggbb' (lowercase),
 * or null if it is not understood. Accepts '#abc', 'abc', '#aabbcc', 'aabbcc', 8/4-digit hex
 * (alpha ignored), 'rgb(…)'/'rgba(…)' with commas or spaces (numbers or percentages),
 * 'hsl(…)'/'hsla(…)', and a bare '124, 108, 240' triple.
 */
export function parseColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (!s || s.length > MAX_INPUT) return null

  const hex = HEX_RE.exec(s)
  if (hex) {
    let h = hex[1]
    if (h.length === 3 || h.length === 4) h = h.slice(0, 3).replace(/./g, (c) => c + c)
    return '#' + h.slice(0, 6)
  }

  const fn = FUNC_RE.exec(s)
  if (fn) {
    const parts = splitArgs(fn[2])
    if (!parts) return null
    return fn[1].startsWith('rgb') ? rgbFromParts(parts) : hslFromParts(parts)
  }

  // Bare "r, g, b" or "r g b" (e.g. pasted from a design tool)
  if (!s.includes('/')) {
    const bare = splitArgs(s)
    if (bare && bare.length === 3) return rgbFromParts(bare)
  }
  return null
}

/**
 * Splits CSS color-function arguments: "1, 2, 3", "1 2 3", "1 2 3 / 50%", "1,2,3,0.5".
 * Returns the 3 or 4 components (alpha validated, then ignored by callers).
 */
function splitArgs(args: string): string[] | null {
  const [main, alpha, extra] = args.split('/')
  if (extra !== undefined) return null
  const parts = main
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length < 3 || parts.length > 4) return null
  if (parts.length === 4 && (alpha !== undefined || !NUMBER_RE.test(parts[3]))) return null
  if (alpha !== undefined && !NUMBER_RE.test(alpha.trim())) return null
  return parts
}

function parseNumber(p: string): { v: number; unit: string } | null {
  const m = NUMBER_RE.exec(p)
  if (!m) return null
  const v = Number(m[1])
  if (!Number.isFinite(v)) return null
  return { v, unit: m[2] ?? '' }
}

function rgbFromParts(parts: string[]): string | null {
  const out: number[] = []
  for (const p of parts.slice(0, 3)) {
    const n = parseNumber(p)
    if (!n || (n.unit && n.unit !== '%')) return null
    out.push(clamp(Math.round(n.unit === '%' ? (n.v * 255) / 100 : n.v), 0, 255))
  }
  return rgbToHex({ r: out[0], g: out[1], b: out[2] })
}

function hslFromParts(parts: string[]): string | null {
  const h = parseNumber(parts[0])
  const s = parseNumber(parts[1])
  const l = parseNumber(parts[2])
  if (!h || !s || !l) return null
  if (h.unit === '%' || (s.unit && s.unit !== '%') || (l.unit && l.unit !== '%')) return null
  let deg = h.v
  if (h.unit === 'turn') deg = h.v * 360
  else if (h.unit === 'rad') deg = (h.v * 180) / Math.PI
  else if (h.unit === 'grad') deg = h.v * 0.9
  return rgbToHex(hslToRgb({ h: deg, s: s.v, l: l.v }))
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}

/** '#rrggbb' (or anything parseColor accepts) -> RGB; null if invalid. */
export function hexToRgb(color: string): RGB | null {
  const hex = parseColor(color)
  if (!hex) return null
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function formatRgb({ r, g, b }: RGB): string {
  return `rgb(${r}, ${g}, ${b})`
}

export function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  let h = 0
  let s = 0
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1))
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  return { h, s: s * 100, l: l * 100 }
}

export function hslToRgb({ h, s, l }: HSL): RGB {
  const hh = (((h % 360) + 360) % 360) / 60
  const ss = clamp(s, 0, 100) / 100
  const ll = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * ll - 1)) * ss
  const x = c * (1 - Math.abs((hh % 2) - 1))
  const m = ll - c / 2
  let rgb: [number, number, number]
  if (hh < 1) rgb = [c, x, 0]
  else if (hh < 2) rgb = [x, c, 0]
  else if (hh < 3) rgb = [0, c, x]
  else if (hh < 4) rgb = [0, x, c]
  else if (hh < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]
  return { r: Math.round((rgb[0] + m) * 255), g: Math.round((rgb[1] + m) * 255), b: Math.round((rgb[2] + m) * 255) }
}

export function formatHsl(rgb: RGB): string {
  const { h, s, l } = rgbToHsl(rgb)
  return `hsl(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%)`
}

/** WCAG 2.x relative luminance (0 = black, 1 = white). */
export function relativeLuminance({ r, g, b }: RGB): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two colors, 1..21. */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The ink (dark or light) with the higher contrast on top of `background`. */
export function readableTextColor(background: string, dark = DARK_INK, light = LIGHT_INK): string {
  const bg = hexToRgb(background)
  const d = hexToRgb(dark)
  const l = hexToRgb(light)
  if (!bg || !d || !l) return dark
  return contrastRatio(bg, d) >= contrastRatio(bg, l) ? dark : light
}

/** True when a color is so light that it needs an outline to be visible on a white surface. */
export function isVeryLight(color: string): boolean {
  const rgb = hexToRgb(color)
  return !!rgb && relativeLuminance(rgb) > 0.85
}
