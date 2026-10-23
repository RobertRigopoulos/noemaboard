// NoemaBoard, concept 1 ("the thought card"), final round.
// Generates every SVG deliverable plus the HTML check sheets that render.cjs / raster.cjs turn into PNGs.
//
//   node design/concept-1/gen.mjs
//   npx electron design/concept-1/raster.cjs design/concept-1/raster-jobs.json      (PNG + ICO exports)
//   npx electron design/concept-1/render.cjs design/concept-1/preview.html design/concept-1/preview.png ...
//
// The wordmark is Fraunces (SIL OFL, the app's display face) converted to outlines by tools/fontlib.mjs, with kerned
// pen positions measured in Chromium (tools/measure.cjs) and stored in wordmark-metrics.json.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAL, f, weaveN, nPaths, rasterN, insideRounded } from './lib.mjs'
import { VarFont, contoursToPath } from './tools/fontlib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const FONT = path.join(root, 'node_modules/@fontsource-variable/fraunces/files/fraunces-latin-full-normal.woff2')
const TEXT = 'NoemaBoard'
const XMLNS = 'xmlns="http://www.w3.org/2000/svg"'

// ------------------------------------------------------------------ the mark
// 100-unit box. Columns 15.2 wide at x 12 and 72.8 (pixel-fitted: 2 px of a 10 px N at 16 px), cap line 12,
// baseline 88. Card rx 3.5, column rx 3, knockout gap 3.2. The card width is solved so its lower edge meets the
// right column's knockout exactly on the baseline (a clean point, no nub).
export const GEO = weaveN({ a: 12, s: 15.2, t: 12, w: 31, rd: 3.5, rs: 3, gap: 3.2, bottom: 'point' })

export const SCHEMES = {
  light: { col: PAL.ink, thought: PAL.yellow }, // transparent mark on light backgrounds (48 px and up)
  dark: { col: PAL.inkSoft, thought: PAL.yellow }, // transparent mark on dark backgrounds
  monoInk: { col: PAL.ink, thought: PAL.ink },
  monoWhite: { col: PAL.white, thought: PAL.white },
  tile: { col: PAL.white, thought: PAL.yellow }, // on the charcoal tile
}

const B = GEO.bounds // { x: 12, y: 12, w: 76, h: 76 }

/** The transparent symbol, square viewBox with `pad` (100-box units) around the N. */
export function markSvg(scheme, { pad = 4, title = 'NoemaBoard' } = {}) {
  const side = B.w + pad * 2
  return `<svg ${XMLNS} viewBox="${B.x - pad} ${B.y - pad} ${side} ${side}"><title>${title}</title>${nPaths(GEO, scheme)}</svg>\n`
}

// ------------------------------------------------------------------ the tile
const TILE = { size: 1024, rx: 225 }
const N_LARGE = 600 // N width on the 1024 tile from 128 px up (58.6%; column edges whole pixels at 256/512/1024)
const N_SMALL = 640 // N width at small sizes (62.5%; column edges whole pixels at 16/32/48/64)

/** Translate/scale that maps the 100-box N to width `nw` centred in a box of `size` at (x, y). */
const place = (nw, size = TILE.size, x = 0, y = 0) => {
  const s = nw / B.w
  return { ox: x + (size - nw) / 2 - B.x * s, oy: y + (size - nw) / 2 - B.y * s, s }
}

/**
 * Dotted-canvas texture for the 1024 tile: 64-unit grid, r 5, centred (dots at 32 + 64k, symmetric about 512).
 * Dots are left out where they would come within `clear` units of the N or `edge` units of the tile outline.
 */
function dotsPath({ nw = N_LARGE, rx = TILE.rx, clear = 24, edge = 22, r = 5, pitch = 64 } = {}) {
  const tr = place(nw)
  const pieces = GEO.pieces.map((p) => p.poly.map((v) => ({ x: tr.ox + v.x * tr.s, y: tr.oy + v.y * tr.s, r: v.r * tr.s })))
  const distToPoly = (poly, p) => {
    if (insideRounded(poly, p)) return 0
    let best = Infinity
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const ab = { x: b.x - a.x, y: b.y - a.y }
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / (ab.x ** 2 + ab.y ** 2)))
      best = Math.min(best, Math.hypot(p.x - a.x - ab.x * t, p.y - a.y - ab.y * t))
    }
    return best
  }
  const inTile = (p, m) => {
    const S = TILE.size
    if (p.x < m || p.y < m || p.x > S - m || p.y > S - m) return false
    if (rx <= m) return true // square (or nearly square) corners: the bounds test is enough
    const cx = Math.min(Math.max(p.x, rx), S - rx)
    const cy = Math.min(Math.max(p.y, rx), S - rx)
    return Math.hypot(p.x - cx, p.y - cy) <= rx - m
  }
  let d = ''
  let count = 0
  for (let y = pitch / 2; y < TILE.size; y += pitch)
    for (let x = pitch / 2; x < TILE.size; x += pitch) {
      const p = { x, y }
      if (!inTile(p, r + edge)) continue
      if (Math.min(...pieces.map((poly) => distToPoly(poly, p))) < r + clear) continue
      d += `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`
      count++
    }
  return { d, count }
}

const gradient = (id) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAL.tileTop}"/><stop offset="1" stop-color="${PAL.tileBottom}"/></linearGradient>`

/** Pixel-fitted small icon on an S-pixel grid: flat tile, columns with square ends, stepped card. */
const PIXEL_SPECS = { 16: { S: 16, m: 3 }, 24: { S: 24, m: 4 }, 32: { S: 32, m: 6 } }
function pixelBody(S) {
  const spec = PIXEL_SPECS[S]
  const r = rasterN(GEO, spec)
  return (
    `<rect width="${S}" height="${S}" rx="${f((3.5 * S) / 16)}" fill="${PAL.tileMid}"/>` +
    `<path fill="${PAL.white}" d="${r.col}"/><path fill="${PAL.yellow}" d="${r.thought}"/>`
  )
}
export const pixelSvg = (S) => `<svg ${XMLNS} viewBox="0 0 ${S} ${S}"><title>NoemaBoard</title>${pixelBody(S)}</svg>\n`

/** Large tile body (1024 space): gradient, dotted canvas, 8% rim, N at N_LARGE. */
function largeTileBody(gid, { rx = TILE.rx, dots = true, rim = true, dotsClass = '' } = {}) {
  const { d } = dotsPath({ rx: rx + 5 })
  const rimEl = rim
    ? `<rect x="2.5" y="2.5" width="1019" height="1019" rx="${rx - 2.5}" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="5"/>`
    : ''
  return (
    `<rect width="1024" height="1024" rx="${rx}" fill="url(#${gid})"/>` +
    (dots ? `<path${dotsClass ? ` class="${dotsClass}"` : ''} fill="#ffffff" fill-opacity=".065" d="${d}"/>` : '') +
    rimEl +
    nPaths(GEO, SCHEMES.tile, place(N_LARGE), 2)
  )
}

/**
 * The app icon. One file, several optical sizes chosen by the size it is drawn at (CSS media queries inside an
 * SVG image test the image's own width, in Chromium, Firefox and Safari):
 *   up to 20 px  -> pixel-fitted 16 px drawing          (tray, favicon, ICO 16)
 *   20 to 25 px  -> pixel-fitted 24 px drawing          (ICO 24, tray 24)
 *   28 to 36 px  -> pixel-fitted 32 px drawing          (ICO 32, tray 32)
 *   otherwise up to 64 px -> vector N at 62.5%, plain tile (app header at 26 px, ICO 48/64)
 *   from 65 px   -> vector N at 58.6% with rim; dotted canvas texture from 180 px
 * Renderers without CSS (or without media queries) show the large drawing only, which is also the default.
 */
export function iconSvg({ idp = 'nb-icon' } = {}) {
  const small = place(N_SMALL)
  return (
    `<svg ${XMLNS} viewBox="0 0 1024 1024"><title>NoemaBoard</title>` +
    `<style>.nb-s16,.nb-s24,.nb-s32,.nb-sm{display:none}` +
    `@media (max-width:64.99px){.nb-lg{display:none}.nb-sm{display:inline}}` +
    `@media (max-width:25px){.nb-sm{display:none}.nb-s24{display:inline}}` +
    `@media (max-width:20px){.nb-s24{display:none}.nb-s16{display:inline}}` +
    `@media (min-width:28px) and (max-width:36px){.nb-sm{display:none}.nb-s32{display:inline}}` +
    `@media (max-width:179.99px){.nb-dots{display:none}}</style>` +
    `<defs>${gradient(`${idp}-tile`)}</defs>` +
    `<g class="nb-lg">${largeTileBody(`${idp}-tile`, { dotsClass: 'nb-dots' })}</g>` +
    `<g class="nb-sm" display="none"><rect width="1024" height="1024" rx="${TILE.rx}" fill="url(#${idp}-tile)"/>${nPaths(GEO, SCHEMES.tile, small, 2)}</g>` +
    `<g class="nb-s32" display="none" transform="scale(32)">${pixelBody(32)}</g>` +
    `<g class="nb-s24" display="none" transform="scale(${f(1024 / 24, 6)})">${pixelBody(24)}</g>` +
    `<g class="nb-s16" display="none" transform="scale(64)">${pixelBody(16)}</g>` +
    `</svg>\n`
  )
}

/** Full-bleed square (no corner radius): apple-touch-icon and social avatars (the platform applies its own mask). */
export function squareSvg({ idp = 'nb-square', nw = N_LARGE } = {}) {
  const { d } = dotsPath({ nw, rx: 0, edge: 0 })
  return (
    `<svg ${XMLNS} viewBox="0 0 1024 1024"><title>NoemaBoard</title><defs>${gradient(`${idp}-tile`)}</defs>` +
    `<rect width="1024" height="1024" fill="url(#${idp}-tile)"/><path fill="#ffffff" fill-opacity=".065" d="${d}"/>` +
    `${nPaths(GEO, SCHEMES.tile, place(nw), 2)}</svg>\n`
  )
}

/** macOS: 824 tile (rx 185) centred on a transparent 1024 canvas with a soft shadow, per Apple's icon grid. */
export function macSvg({ idp = 'nb-mac' } = {}) {
  const k = 824 / 1024
  return (
    `<svg ${XMLNS} viewBox="0 0 1024 1024"><title>NoemaBoard</title><defs>${gradient(`${idp}-tile`)}` +
    `<filter id="${idp}-shadow" x="-10%" y="-10%" width="120%" height="125%" color-interpolation-filters="sRGB">` +
    `<feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity=".3"/></filter></defs>` +
    `<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#${idp}-tile)" filter="url(#${idp}-shadow)"/>` +
    `<g transform="translate(100 100) scale(${f(k, 6)})"><path fill="#ffffff" fill-opacity=".065" d="${dotsPath({ rx: 185 / k + 5 }).d}"/>` +
    `<rect x="2.5" y="2.5" width="1019" height="1019" rx="${f(185 / k - 2.5)}" fill="none" stroke="#ffffff" stroke-opacity=".08" stroke-width="5"/>` +
    `${nPaths(GEO, SCHEMES.tile, place(N_LARGE), 2)}</g></svg>\n`
  )
}

/** Browser favicon: the pixel-fitted drawings, picked by size (16 by default, 24, 32, vector from 40). */
export function faviconSvg({ idp = 'nb-fav' } = {}) {
  return (
    `<svg ${XMLNS} viewBox="0 0 32 32"><title>NoemaBoard</title>` +
    `<style>.nb-f24,.nb-f32,.nb-fv{display:none}` +
    `@media (min-width:20.01px) and (max-width:27.99px){.nb-f16{display:none}.nb-f24{display:inline}}` +
    `@media (min-width:28px) and (max-width:39.99px){.nb-f16{display:none}.nb-f32{display:inline}}` +
    `@media (min-width:40px){.nb-f16{display:none}.nb-fv{display:inline}}</style>` +
    `<defs>${gradient(`${idp}-tile`)}</defs>` +
    `<g class="nb-f16" transform="scale(2)">${pixelBody(16)}</g>` +
    `<g class="nb-f24" display="none" transform="scale(${f(32 / 24, 6)})">${pixelBody(24)}</g>` +
    `<g class="nb-f32" display="none">${pixelBody(32)}</g>` +
    `<g class="nb-fv" display="none" transform="scale(${1 / 32})"><rect width="1024" height="1024" rx="${TILE.rx}" fill="url(#${idp}-tile)"/>${nPaths(GEO, SCHEMES.tile, place(N_SMALL), 2)}</g>` +
    `</svg>\n`
  )
}

/**
 * macOS menu-bar template glyph (black + alpha only; macOS tints it): the N without a tile, on whole pixels,
 * 12 px tall in the 16 px box and 24 px tall at @2x. Picked by size like icon.svg.
 */
export function trayTemplateSvg() {
  const a = rasterN(GEO, { S: 16, m: 2 })
  const b = rasterN(GEO, { S: 32, m: 4 })
  return (
    `<svg ${XMLNS} viewBox="0 0 16 16"><style>.nb-t32{display:none}@media (min-width:20.01px){.nb-t16{display:none}.nb-t32{display:inline}}</style>` +
    `<path class="nb-t16" fill="#000000" d="${a.col}${a.thought}"/>` +
    `<path class="nb-t32" display="none" fill="#000000" transform="scale(.5)" d="${b.col}${b.thought}"/></svg>
`
  )
}

// ------------------------------------------------------------------ wordmark + lockup
let FONT_CACHE = null
const font = () => (FONT_CACHE ??= new VarFont(FONT))

/** Wordmark outlines in font units (baseline y = 0, y down). positions: kerned pen x per char (+ end). */
export function wordmark(settings, positions) {
  const fnt = font()
  let d = ''
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  ;[...TEXT].forEach((ch, i) => {
    const g = fnt.glyph(fnt.gid(ch), settings)
    d += contoursToPath(g.contours, positions[i], 0, 1)
    for (const c of g.contours)
      for (const p of c) {
        minX = Math.min(minX, positions[i] + p.x)
        maxX = Math.max(maxX, positions[i] + p.x)
        minY = Math.min(minY, -p.y)
        maxY = Math.max(maxY, -p.y)
      }
  })
  const top = (ch) => Math.max(...fnt.glyph(fnt.gid(ch), settings).contours.flat().map((p) => p.y))
  return { d, cap: top('N'), asc: top('d'), bbox: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } }
}

/**
 * Horizontal lockup: the mark stands on the baseline and reaches the ascender line of the d (mark height = d
 * ascender); the space between mark and text is gapK x cap height. Font units; the viewBox is tight on the ink.
 */
export function lockupSvg(WM, { scheme = SCHEMES.light, text = PAL.ink, gapK = 0.55 } = {}) {
  const w = wordmark(WM.settings, WM.penX)
  const mH = w.asc
  const s = mH / B.h
  const mW = B.w * s
  const textX = mW + gapK * w.cap - w.bbox.x
  const top = Math.min(-mH, w.bbox.y)
  const bottom = Math.max(0, w.bbox.y + w.bbox.h)
  const right = textX + w.bbox.x + w.bbox.w
  const vb = [0, top, right, bottom - top].map((n) => f(n, 1))
  return (
    `<svg ${XMLNS} viewBox="${vb.join(' ')}"><title>NoemaBoard</title>` +
    nPaths(GEO, scheme, { ox: -B.x * s, oy: -mH - B.y * s, s }, 1) +
    `<path fill="${text}" transform="translate(${f(textX, 1)} 0)" d="${w.d}"/></svg>\n`
  )
}

/** Inner content (no <svg> wrapper) of a lockup scaled to height h (of the mark) at x, baseline y. */
function lockupGroup(WM, { x, y, h, scheme = SCHEMES.light, text = PAL.ink, gapK = 0.55 }) {
  const w = wordmark(WM.settings, WM.penX)
  const k = h / w.asc
  const s = w.asc / B.h
  const mW = B.w * s
  const textX = mW + gapK * w.cap - w.bbox.x
  return {
    svg:
      `<g transform="translate(${f(x)} ${f(y)}) scale(${f(k, 6)})">` +
      nPaths(GEO, scheme, { ox: -B.x * s, oy: -w.asc - B.y * s, s }, 1) +
      `<path fill="${text}" transform="translate(${f(textX, 1)} 0)" d="${w.d}"/></g>`,
    width: (textX + w.bbox.x + w.bbox.w) * k,
    height: h,
  }
}

// ------------------------------------------------------------------ launch assets
function bannerSvg(WM, { id, W, H, lockH, lockX, baseY, pitch = 28, r = 1.9 }) {
  const lock = lockupGroup(WM, { x: lockX, y: baseY, h: lockH })
  const ox = (W / 2) % pitch
  const oy = (H / 2) % pitch
  return {
    svg:
      `<svg ${XMLNS} viewBox="0 0 ${W} ${H}"><title>NoemaBoard</title><defs>` +
      `<pattern id="${id}" width="${pitch}" height="${pitch}" patternUnits="userSpaceOnUse" x="${f(ox - pitch / 2)}" y="${f(oy - pitch / 2)}">` +
      `<circle cx="${pitch / 2}" cy="${pitch / 2}" r="${r}" fill="${PAL.ink}" fill-opacity=".16"/></pattern></defs>` +
      `<rect width="${W}" height="${H}" fill="${PAL.light}"/><rect width="${W}" height="${H}" fill="url(#${id})"/>` +
      `${lock.svg}</svg>\n`,
    lock,
  }
}

// ------------------------------------------------------------------ build
const WM = JSON.parse(fs.readFileSync(path.join(here, 'wordmark-metrics.json'), 'utf8'))
// apply the pair tweaks to the measured pen positions: every glyph after the pair moves by the tweak
WM.penX = WM.measured.slice()
for (const [pair, du] of Object.entries(WM.tweaks)) {
  const i = TEXT.indexOf(pair)
  for (let k = i + 1; k < WM.penX.length; k++) WM.penX[k] += du
}

const out = {
  'mark.svg': markSvg(SCHEMES.light),
  'mark-dark.svg': markSvg(SCHEMES.dark),
  'mark-mono.svg': markSvg(SCHEMES.monoInk),
  'mark-mono-white.svg': markSvg(SCHEMES.monoWhite),
  'icon.svg': iconSvg(),
  'icon-square.svg': squareSvg(),
  'icon-macos.svg': macSvg(),
  'favicon.svg': faviconSvg(),
  'favicon-16.svg': pixelSvg(16),
  'favicon-24.svg': pixelSvg(24),
  'favicon-32.svg': pixelSvg(32),
  'tray-template.svg': trayTemplateSvg(),
  'lockup.svg': lockupSvg(WM),
  'lockup-dark.svg': lockupSvg(WM, { scheme: SCHEMES.dark, text: PAL.inkSoft }),
}
// left of centre, clear of the avatar / profile photo that overlaps the lower-left corner
const X = bannerSvg(WM, { id: 'nb-banner-x-dots', W: 1500, H: 500, lockH: 76, lockX: 300, baseY: 266 })
const LI = bannerSvg(WM, { id: 'nb-banner-li-dots', W: 1584, H: 396, lockH: 66, lockX: 410, baseY: 208 })
out['social/banner-x.svg'] = X.svg
out['social/banner-linkedin.svg'] = LI.svg
fs.mkdirSync(path.join(here, 'social'), { recursive: true })
for (const [n, s] of Object.entries(out)) fs.writeFileSync(path.join(here, n), s)
console.log('dots on the 1024 tile:', dotsPath().count, '| card width', f(GEO.cardW), '| angle', f(GEO.angle))
console.log('lockup X', f(X.lock.width), 'x', X.lock.height, '| LinkedIn', f(LI.lock.width), 'x', LI.lock.height)
console.log('wrote', Object.keys(out).join(', '))
