/**
 * Text and highlight colors offered by the format menu. Values are CSS variables (defined in
 * richtext.css for light, dark and dark-card contexts) so colored text stays legible in every theme.
 * Only these values are accepted when pasting HTML, so foreign inline colors never leak in.
 */

export interface PaletteColor {
  name: string
  value: string
}

export const TEXT_COLORS: readonly PaletteColor[] = [
  { name: 'Grey', value: 'var(--rt-tx-grey)' },
  { name: 'Red', value: 'var(--rt-tx-red)' },
  { name: 'Orange', value: 'var(--rt-tx-orange)' },
  { name: 'Green', value: 'var(--rt-tx-green)' },
  { name: 'Blue', value: 'var(--rt-tx-blue)' },
  { name: 'Purple', value: 'var(--rt-tx-purple)' },
]

export const HIGHLIGHT_COLORS: readonly PaletteColor[] = [
  { name: 'Yellow', value: 'var(--rt-hl-yellow)' },
  { name: 'Green', value: 'var(--rt-hl-green)' },
  { name: 'Blue', value: 'var(--rt-hl-blue)' },
  { name: 'Pink', value: 'var(--rt-hl-pink)' },
  { name: 'Purple', value: 'var(--rt-hl-purple)' },
]

const KNOWN = new Set([...TEXT_COLORS, ...HIGHLIGHT_COLORS].map((c) => c.value))

/** Returns the value if it is one of our palette colors, else null. */
export function paletteValue(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().replace(/\s+/g, '')
  return KNOWN.has(v) ? v : null
}

const SAFE_CSS_COLOR =
  /^(#[0-9a-f]{3,8}|[a-z]{3,30}|(rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/+-]{1,60}\)|var\(--[a-z0-9-]{1,40}\))$/i

/** Accepts plain CSS colors only (no url(), no extra declarations). Used for data from peers. */
export function safeCssColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v.length <= 80 && SAFE_CSS_COLOR.test(v) ? v : null
}
