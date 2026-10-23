/**
 * Board pictures: PNG images and printable page sheets (for PDF) of the whole board or the selected
 * cards. Both clone the cards' rendered DOM (so they look exactly like the board):
 *  - PNG: the clone, every stylesheet, the fonts and the images are inlined into an SVG
 *    foreignObject, drawn on a canvas and encoded;
 *  - PDF: page-sized clones go into a print-only sheet in this document (vector text, live fonts)
 *    that the desktop shell or the browser's print dialog turns into pages.
 * The pure helpers at the top are unit tested.
 */
import type { BoardContextValue } from '../../board/BoardContext'
import type { IndexedCard } from '../../board/cardIndex'
import { useRenderAll } from '../../board/culling'
import { cardBounds, getCanvasElement, getCardElement, waitForLayout } from '../../board/geometry'
import { useSelection, useView } from '../../board/store'
import { readImageTransform, transformStyle } from '../../cards/media/transform'
import { attachmentTarget } from '../../cards/structure/attach'
import { getLocalBlob } from '../../collab/blobs'
import { isBlobHash } from '../../model/blobRefs'
import { isParked } from '../../model/board'
import type { PdfPageSize } from '../../lib/desktop'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Space around the exported cards, in board units. */
export const EXPORT_PADDING = 40
/** Canvas limits browsers can still encode reliably. */
export const MAX_CANVAS_SIDE = 16384
export const MAX_CANVAS_PIXELS = 268_000_000
/** Pages a "Large" PDF may have before its zoom is reduced to fit. */
export const MAX_PDF_PAGES = 100
/** CSS pixels per millimetre. */
export const PX_PER_MM = 96 / 25.4
/** Page margin used by the print sheet's @page rule. */
export const PAGE_MARGIN_MM = 10
/** "Fit on one page" never enlarges small content beyond this. */
export const MAX_FIT_ZOOM = 1.5

/** Union of the given rects padded by `pad`, or null when there are none (or none are finite). */
export function exportBounds(rects: readonly (Rect | null | undefined)[], pad = EXPORT_PADDING): Rect | null {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) continue
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + Math.max(0, r.w))
    y2 = Math.max(y2, r.y + Math.max(0, r.h))
  }
  if (!Number.isFinite(x1)) return null
  return { x: Math.floor(x1 - pad), y: Math.floor(y1 - pad), w: Math.ceil(x2 - x1 + pad * 2), h: Math.ceil(y2 - y1 + pad * 2) }
}

/**
 * The largest scale up to `want` at which a w×h image stays within the canvas limits (both sides
 * and the pixel count). `limited` says the requested scale had to be reduced.
 */
export function fitScale(
  w: number,
  h: number,
  want: number,
  limits: { maxSide: number; maxPixels: number } = { maxSide: MAX_CANVAS_SIDE, maxPixels: MAX_CANVAS_PIXELS },
): { scale: number; limited: boolean } {
  if (!(w > 0) || !(h > 0) || !(want > 0)) return { scale: 0, limited: false }
  let scale = Math.min(want, limits.maxSide / w, limits.maxSide / h, Math.sqrt(limits.maxPixels / (w * h)))
  // Rounded canvas sizes must stay inside the limits too.
  while (scale > 0 && (Math.ceil(w * scale) > limits.maxSide || Math.ceil(h * scale) > limits.maxSide || Math.ceil(w * scale) * Math.ceil(h * scale) > limits.maxPixels)) {
    scale *= 0.999
  }
  return { scale, limited: scale < want - 1e-9 }
}

export const PAGE_SIZES_MM: Record<PdfPageSize, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  Letter: { w: 215.9, h: 279.4 },
  A3: { w: 297, h: 420 },
}

/** Orientation that suits the content: landscape for wide content. */
export function chooseLandscape(bounds: Pick<Rect, 'w' | 'h'>): boolean {
  return bounds.w > bounds.h
}

/** Printable area of a page in CSS pixels (a millimetre of slack keeps it off a second sheet). */
export function pageContentPx(size: PdfPageSize, landscape: boolean, marginMm = PAGE_MARGIN_MM): { w: number; h: number } {
  const p = PAGE_SIZES_MM[size]
  const pw = landscape ? p.h : p.w
  const ph = landscape ? p.w : p.h
  return { w: Math.floor((pw - marginMm * 2 - 1) * PX_PER_MM), h: Math.floor((ph - marginMm * 2 - 1) * PX_PER_MM) }
}

/** Zoom that fits `bounds` on one page (never above MAX_FIT_ZOOM). */
export function fitPageZoom(bounds: Pick<Rect, 'w' | 'h'>, page: { w: number; h: number }): number {
  if (!(bounds.w > 0) || !(bounds.h > 0)) return 1
  return Math.min(MAX_FIT_ZOOM, page.w / bounds.w, page.h / bounds.h)
}

export interface TileGrid {
  /** Board units → CSS pixels on the page. */
  zoom: number
  cols: number
  rows: number
  /** Board-space area of each page, row by row. */
  tiles: Rect[]
}

/**
 * Splits `bounds` into page-sized tiles at `zoom` (1 = actual size), row by row. When that would
 * take more than `maxPages` pages, the zoom shrinks until it fits.
 */
export function tileGrid(bounds: Rect, page: { w: number; h: number }, zoom = 1, maxPages = MAX_PDF_PAGES): TileGrid {
  let z = zoom > 0 ? zoom : 1
  const count = (zz: number) => ({ cols: Math.max(1, Math.ceil((bounds.w * zz) / page.w - 1e-9)), rows: Math.max(1, Math.ceil((bounds.h * zz) / page.h - 1e-9)) })
  let { cols, rows } = count(z)
  for (let i = 0; i < 200 && cols * rows > maxPages; i++) {
    z *= 0.9
    ;({ cols, rows } = count(z))
  }
  const tw = page.w / z
  const th = page.h / z
  const tiles: Rect[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) tiles.push({ x: bounds.x + c * tw, y: bounds.y + r * th, w: tw, h: th })
  return { zoom: z, cols, rows, tiles }
}

/** Parses a CSS unicode-range ("U+0000-00FF, U+0131, U+02??") into inclusive code point ranges. */
export function parseUnicodeRange(value: string): [number, number][] {
  const out: [number, number][] = []
  for (const part of value.split(',')) {
    const m = /^\s*u\+([0-9a-f?]{1,6})(?:-([0-9a-f]{1,6}))?\s*$/i.exec(part)
    if (!m) continue
    if (m[1].includes('?')) {
      out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)])
    } else {
      const a = parseInt(m[1], 16)
      out.push([a, m[2] ? parseInt(m[2], 16) : a])
    }
  }
  return out
}

/** True when any code point of `text` falls in the ranges (no ranges = every character). */
export function rangeCovers(ranges: readonly [number, number][], text: string): boolean {
  if (!ranges.length) return true
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (ranges.some(([a, b]) => cp >= a && cp <= b)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// What gets exported

export type ExportScope = 'board' | 'selection'

export interface ExportTargets {
  /** Cards drawn as card elements (free cards, or selected column children). */
  cardIds: string[]
  lineIds: string[]
}

/**
 * The cards an export covers: on the canvas (not in the Unsorted drawer, not comments pinned to
 * another card), plus lines. A selection keeps its own cards and the lines it selected or that
 * join two of them.
 */
export function exportTargets(ctx: BoardContextValue, scope: ExportScope): ExportTargets {
  const lookup = (id: string) => ctx.index.get(id)
  const all = ctx.index.getSnapshot()
  const drawable = (c: IndexedCard) => c.type !== 'line' && !isParked(lookup, c.id) && attachmentTarget(c.card, lookup) === null
  const inColumn = (c: IndexedCard) => !!c.parent && lookup(c.parent)?.type === 'column'
  if (scope === 'board') {
    return {
      cardIds: all.filter((c) => drawable(c) && !inColumn(c)).map((c) => c.id),
      lineIds: all.filter((c) => c.type === 'line' && !isParked(lookup, c.id)).map((c) => c.id),
    }
  }
  const selected = useSelection.getState().selected
  // A column taken whole already shows its selected children.
  const picked = all.filter((c) => selected.has(c.id) && drawable(c) && !(c.parent && selected.has(c.parent)))
  const ids = new Set(picked.map((c) => c.id))
  const lineIds = all
    .filter((c) => {
      if (c.card.type !== 'line') return false
      if (selected.has(c.id)) return true
      const { from, to } = c.card
      return !!from.card && !!to.card && ids.has(from.card) && ids.has(to.card)
    })
    .map((c) => c.id)
  return { cardIds: picked.map((c) => c.id), lineIds }
}

/** Board-space rect of each card (after layout), plus the lines' end points. */
export function targetRects(ctx: BoardContextValue, t: ExportTargets): Map<string, Rect> {
  const out = new Map<string, Rect>()
  for (const id of [...t.cardIds, ...t.lineIds]) {
    const c = ctx.index.get(id)
    const r = c ? cardBounds(c) : null
    if (r) out.set(id, r)
  }
  return out
}

/** Media that is still fetching its bytes: a picture card or link preview showing its shimmer. */
export const MEDIA_LOADING_SELECTOR = '.image-card__frame[data-state="loading"], .media-shimmer'
/** Longest wait for newly mounted cards to load their pictures before an export goes ahead anyway. */
export const MEDIA_WAIT_MS = 5000

/** One animation frame, or a short timeout when frames do not run (hidden window). */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 50)
    if (typeof requestAnimationFrame === 'undefined') return
    requestAnimationFrame(() => {
      clearTimeout(t)
      resolve()
    })
  })
}

/**
 * Waits until none of the cards shows media that is still loading, or `timeoutMs` has passed.
 * Cards that were culled read their pictures from the local store asynchronously after mounting.
 */
export async function waitForMedia(ids: readonly string[], timeoutMs = MEDIA_WAIT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs
  const loading = () => ids.some((id) => !!getCardElement(id)?.querySelector(MEDIA_LOADING_SELECTOR))
  if (!loading()) return
  while (loading() && performance.now() < deadline) await nextFrame()
  // A link preview that arrived can change its card's height.
  await waitForLayout()
}

export interface RenderAllOptions {
  /** Cards whose pictures should finish loading before `fn` runs (read once the cards are mounted). */
  media?: () => readonly string[]
}

/**
 * Runs `fn` while the canvas renders every card (no culling), once the browser has laid them out
 * (and, with `media`, once their pictures have loaded). Restores the previous mode afterwards.
 */
export async function withEveryCardRendered<T>(fn: () => Promise<T>, opts: RenderAllOptions = {}): Promise<T> {
  const store = useRenderAll.getState()
  const before = store.all
  store.set(true)
  try {
    await waitForLayout()
    // Newly mounted cards measure themselves, which can move column children: one more pass.
    await waitForLayout()
    if (opts.media) await waitForMedia(opts.media())
    return await fn()
  } finally {
    useRenderAll.getState().set(before)
  }
}

// ---------------------------------------------------------------------------
// Cloning the rendered cards

/** Classes that show interaction state, never wanted in a picture. */
const STATE_CLASSES = ['is-selected', 'is-editing', 'is-kb-focus', 'is-drop-target', 'is-dragging', 'is-peer-selected']
/** Interaction chrome inside cards and lines. */
const CHROME_SELECTOR = '.resize-handle, .peer-outline, .peer-tag, .line-handle, .noema-line__hit, .noema-line__halo, .line-connector, .line-label-input'

function cleanClone(root: Element) {
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
    if (STATE_CLASSES.some((c) => el.classList.contains(c))) el.classList.remove(...STATE_CLASSES)
    el.removeAttribute('id')
    el.removeAttribute('contenteditable')
    el.removeAttribute('tabindex')
  }
  root.querySelectorAll(CHROME_SELECTOR).forEach((n) => n.remove())
}

/** <canvas> content is not cloned: swap in a picture of it. Embedded players become plain boxes. */
function replaceLiveContent(original: Element, clone: Element) {
  const src = Array.from(original.querySelectorAll('canvas'))
  Array.from(clone.querySelectorAll('canvas')).forEach((c, i) => {
    const img = document.createElement('img')
    try {
      img.src = src[i]?.toDataURL('image/png') ?? ''
    } catch {
      img.src = ''
    }
    img.style.cssText = `width:${c.clientWidth || src[i]?.clientWidth || 0}px;height:${c.clientHeight || src[i]?.clientHeight || 0}px`
    img.className = c.className
    c.replaceWith(img)
  })
  const players = Array.from(original.querySelectorAll('iframe, video'))
  const zoom = useView.getState().viewport.zoom || 1
  Array.from(clone.querySelectorAll('iframe, video')).forEach((el, i) => {
    const box = document.createElement('div')
    box.className = 'export-embed'
    // Rendered size on screen, back in board units.
    const r = players[i]?.getBoundingClientRect()
    if (r) box.style.cssText = `width:${Math.round(r.width / zoom)}px;height:${Math.round(r.height / zoom)}px`
    el.replaceWith(box)
  })
}

/** Tags image card shells (the card itself or column children) with their id, which cleanClone drops. */
function markImageCards(clone: HTMLElement) {
  for (const el of [clone, ...Array.from(clone.querySelectorAll<HTMLElement>('[data-type="image"]'))]) {
    if (el.dataset.type === 'image' && el.id.startsWith('card-')) el.dataset.exportImage = el.id.slice('card-'.length)
  }
}

const positiveNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * Image cards whose clone has no picture (still loading, or not on this device) get one from the
 * local store, through `toUrl`. Pictures that cannot be found become plain boxes. Returns how many
 * could not be drawn.
 */
async function fillImageCards(ctx: BoardContextValue, root: HTMLElement, toUrl: (hash: string, blob: Blob) => Promise<string | null>): Promise<number> {
  let missing = 0
  const shells = Array.from(root.querySelectorAll<HTMLElement>('[data-export-image]'))
  await Promise.all(
    shells.map(async (shell) => {
      const frame = shell.querySelector<HTMLElement>('.image-card__frame')
      if (!frame || frame.querySelector('img')) return
      const card = ctx.index.get(shell.dataset.exportImage ?? '')?.card as unknown as Record<string, unknown> | undefined
      let url: string | null = null
      // A picture that failed to decode on the board would fail here too.
      if (card?.type === 'image' && frame.dataset.state !== 'broken') {
        for (const hash of [card.thumb, card.blob]) {
          if (!isBlobHash(hash)) continue
          const blob = await getLocalBlob(hash).catch(() => null)
          url = blob ? await toUrl(hash, blob).catch(() => null) : null
          if (url) break
        }
      }
      if (!url || !card) {
        missing++
        frame.replaceChildren()
        frame.classList.add('export-missing')
        return
      }
      const iw = positiveNum(card.iw)
      const ih = positiveNum(card.ih)
      const style = transformStyle(readImageTransform(card, iw, ih), iw, ih)
      const inner = document.createElement('div')
      inner.className = 'image-card__transform'
      Object.assign(inner.style, style.inner)
      const img = document.createElement('img')
      img.className = 'image-card__img'
      img.alt = ''
      Object.assign(img.style, style.img)
      img.src = url
      inner.appendChild(img)
      frame.replaceChildren(inner)
      frame.dataset.state = 'ready'
    }),
  )
  return missing
}

export interface SceneOptions {
  /** Only cards and lines whose rect meets this area (pages of a large PDF). */
  area?: Rect
}

/**
 * A detached copy of the exported cards: a `.world` positioned so that board point (origin.x,
 * origin.y) sits at the container's top-left. Free cards keep their own absolute positions;
 * selected column children are placed at their on-board rects.
 */
export function buildScene(ctx: BoardContextValue, t: ExportTargets, rects: Map<string, Rect>, origin: { x: number; y: number }, opts: SceneOptions = {}): HTMLElement {
  const world = document.createElement('div')
  world.className = 'world export-world'
  world.dataset.zoom = 'near'
  world.style.cssText = `position:absolute;left:0;top:0;transform:translate(${-origin.x}px, ${-origin.y}px);transform-origin:0 0`
  const meets = (r: Rect | undefined) => {
    const a = opts.area
    if (!a || !r) return true
    return r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y
  }

  const ordered = t.cardIds
    .map((id) => ({ id, z: ctx.index.get(id)?.z ?? 0 }))
    .sort((a, b) => a.z - b.z)
    .map((c) => c.id)
  for (const id of ordered) {
    const el = getCardElement(id)
    const r = rects.get(id)
    if (!el || !el.isConnected || !meets(r)) continue
    const clone = el.cloneNode(true) as HTMLElement
    replaceLiveContent(el, clone)
    markImageCards(clone)
    cleanClone(clone)
    clone.dataset.exportCard = id
    const c = ctx.index.get(id)
    if (c?.parent && r) {
      // A card taken out of its column for the picture: place it where it shows on the board.
      clone.style.position = 'absolute'
      clone.style.left = `${r.x}px`
      clone.style.top = `${r.y}px`
      clone.style.width = `${r.w}px`
      clone.style.margin = '0'
    }
    world.appendChild(clone)
  }

  const canvas = getCanvasElement()
  const layer = canvas?.querySelector('.lines-layer')
  if (layer && t.lineIds.length) {
    const keep = new Set(t.lineIds.filter((id) => meets(rects.get(id))))
    const svg = layer.cloneNode(true) as SVGElement
    svg.querySelectorAll('g[data-line-id]').forEach((g) => {
      if (!keep.has(g.getAttribute('data-line-id') ?? '')) g.remove()
    })
    // Lines being drawn (no id) are not content.
    svg.querySelectorAll('g:not([data-line-id])').forEach((g) => {
      if (g.classList.contains('noema-line')) g.remove()
    })
    cleanClone(svg)
    world.appendChild(svg)

    const labels = canvas?.querySelector('.lines-labels')
    if (labels) {
      // Labels carry no line id: keep the ones whose text belongs to an exported line.
      const texts = new Set<string>()
      for (const id of keep) {
        const c = ctx.index.get(id)
        if (c?.card.type === 'line' && c.card.label.trim()) texts.add(c.card.label)
      }
      const copy = labels.cloneNode(true) as HTMLElement
      copy.querySelectorAll('.line-label').forEach((l) => {
        if (!texts.has(l.textContent ?? '')) l.remove()
      })
      cleanClone(copy)
      world.appendChild(copy)
    }
  }
  return world
}

// ---------------------------------------------------------------------------
// PNG

export interface PngOptions {
  scope: ExportScope
  /** Requested pixel ratio (1 or 2). */
  scale: number
  background: 'white' | 'board' | 'transparent'
  theme: 'light' | 'dark'
}

export interface PngResult {
  blob: Blob
  width: number
  height: number
  /** Images that could not be read (not on this device, or blocked): drawn as placeholders. */
  missingImages: number
  /** The requested scale was reduced to stay within canvas limits. */
  downscaled: boolean
}

export class ExportEmptyError extends Error {}

const fontCache = new Map<string, Promise<string | null>>()

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error ?? new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

function readableSheets(): CSSStyleSheet[] {
  const out: CSSStyleSheet[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (sheet.cssRules) out.push(sheet)
    } catch {
      // Cross-origin stylesheet: its rules cannot be read (and are not needed).
    }
  }
  return out
}

function walkRules(rules: CSSRuleList, fn: (r: CSSRule) => void) {
  for (const r of Array.from(rules)) {
    fn(r)
    if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) walkRules(r.cssRules, fn)
  }
}

/** Every same-origin style rule as text, without @font-face (fonts are inlined separately). */
function collectCss(): string {
  const parts: string[] = []
  for (const sheet of readableSheets()) {
    for (const r of Array.from(sheet.cssRules)) {
      if (r instanceof CSSFontFaceRule || r instanceof CSSImportRule) continue
      parts.push(r.cssText)
    }
  }
  return parts.join('\n')
}

const APP_FONTS = /^(inter|fraunces)\b/i

/** @font-face rules of the app's fonts that the text needs, with their woff2 files as data: URLs. */
async function inlineFonts(text: string): Promise<string> {
  const faces: Promise<string | null>[] = []
  for (const sheet of readableSheets()) {
    walkRules(sheet.cssRules, (r) => {
      if (!(r instanceof CSSFontFaceRule)) return
      const family = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim()
      if (!APP_FONTS.test(family)) return
      const range = r.style.getPropertyValue('unicode-range')
      if (!rangeCovers(parseUnicodeRange(range), text)) return
      const src = r.style.getPropertyValue('src')
      const m = /url\(\s*["']?([^"')]+\.woff2[^"')]*)["']?\s*\)/i.exec(src)
      if (!m) return
      let url: string
      try {
        url = new URL(m[1], sheet.href ?? document.baseURI).href
      } catch {
        return
      }
      let data = fontCache.get(url)
      if (!data) {
        data = fetch(url)
          .then((res) => (res.ok ? res.blob() : null))
          .then((b) => (b ? blobToDataUrl(b) : null))
          .catch(() => null)
        fontCache.set(url, data)
      }
      const style = r.style.getPropertyValue('font-style') || 'normal'
      const weight = r.style.getPropertyValue('font-weight') || 'normal'
      faces.push(
        data.then((d) =>
          d
            ? `@font-face{font-family:'${family}';font-style:${style};font-weight:${weight};font-display:block;${range ? `unicode-range:${range};` : ''}src:url(${d}) format('woff2');}`
            : null,
        ),
      )
    })
  }
  return (await Promise.all(faces)).filter(Boolean).join('\n')
}

/** Replaces every image source with a data: URL (the SVG image cannot load anything else). */
async function inlineImages(ctx: BoardContextValue, scene: HTMLElement): Promise<number> {
  let missing = 0
  const imgs = Array.from(scene.querySelectorAll('img'))
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') ?? ''
      img.removeAttribute('srcset')
      img.removeAttribute('loading')
      if (src.startsWith('data:')) return
      let data: string | null = null
      // An image card's own picture comes from the local store when it is there.
      const cardId = img.closest<HTMLElement>('[data-export-card]')?.dataset.exportCard
      const card = cardId ? (ctx.index.get(cardId)?.card as unknown as Record<string, unknown> | undefined) : undefined
      if (card?.type === 'image' && imgs.filter((x) => x.closest('[data-export-card]') === img.closest('[data-export-card]')).length === 1) {
        const hash = isBlobHash(card.thumb) ? card.thumb : isBlobHash(card.blob) ? card.blob : null
        const blob = hash ? await getLocalBlob(hash).catch(() => null) : null
        if (blob) data = await blobToDataUrl(blob).catch(() => null)
      }
      if (!data && src) {
        try {
          const res = await fetch(src)
          if (res.ok) data = await blobToDataUrl(await res.blob())
        } catch {
          data = null
        }
      }
      if (data) img.setAttribute('src', data)
      else {
        missing++
        const box = document.createElement('div')
        box.className = `${img.className} export-missing`
        box.setAttribute('style', img.getAttribute('style') ?? '')
        box.style.background = 'var(--surface-3)'
        box.style.minHeight = '24px'
        img.replaceWith(box)
      }
    }),
  )
  return missing
}

function backgroundCss(bg: PngOptions['background']): string {
  return bg === 'white' ? '#ffffff' : bg === 'board' ? 'var(--canvas-bg)' : 'transparent'
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('The picture could not be drawn.'))
    img.src = url
  })
}

/** Renders the exported cards to a PNG. Call inside withEveryCardRendered(). */
export async function renderPng(ctx: BoardContextValue, opts: PngOptions): Promise<PngResult> {
  const targets = exportTargets(ctx, opts.scope)
  const rects = targetRects(ctx, targets)
  const bounds = exportBounds([...rects.values()])
  if (!bounds) throw new ExportEmptyError(opts.scope === 'selection' ? 'Select cards to export first.' : 'This board has no cards to export.')
  const { scale, limited } = fitScale(bounds.w, bounds.h, opts.scale)
  if (!(scale > 0)) throw new ExportEmptyError('This board is too large to export as an image.')

  const scene = document.createElement('div')
  scene.className = 'export-scene'
  // XMLSerializer writes the XHTML namespace on this root, as foreignObject content needs.
  scene.style.cssText = [
    'position:relative',
    `width:${bounds.w}px`,
    `height:${bounds.h}px`,
    'overflow:hidden',
    `background:${backgroundCss(opts.background)}`,
    'font-family:var(--font-ui)',
    'font-size:14px',
    'line-height:1.45',
    'color:var(--text)',
    '-webkit-font-smoothing:antialiased',
  ].join(';')
  scene.appendChild(buildScene(ctx, targets, rects, { x: bounds.x, y: bounds.y }))

  const unfilled = await fillImageCards(ctx, scene, (_hash, blob) => blobToDataUrl(blob))
  const missingImages = unfilled + (await inlineImages(ctx, scene))
  const style = document.createElement('style')
  style.textContent = `${await inlineFonts(scene.textContent ?? '')}\n${collectCss()}`
  scene.insertBefore(style, scene.firstChild)

  const xhtml = new XMLSerializer().serializeToString(scene)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.w}" height="${bounds.h}" viewBox="0 0 ${bounds.w} ${bounds.h}" data-theme="${opts.theme}">` +
    `<foreignObject x="0" y="0" width="${bounds.w}" height="${bounds.h}">${xhtml}</foreignObject></svg>`
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
  // Images inside the SVG decode asynchronously in some engines; one more frame lets them settle.
  await waitForLayout()

  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(bounds.w * scale))
  canvas.height = Math.max(1, Math.ceil(bounds.h * scale))
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This browser cannot draw the picture.')
  g.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('The picture could not be encoded.')
  return { blob, width: canvas.width, height: canvas.height, missingImages, downscaled: limited }
}

// ---------------------------------------------------------------------------
// PDF: a print-only sheet of page-sized clones

export interface SheetOptions {
  scope: ExportScope
  layout: 'fit' | 'large'
  pageSize: PdfPageSize
  /** null = chosen from the content's shape. */
  landscape: boolean | null
  background: 'white' | 'board'
}

export interface PrintSheet {
  pages: number
  landscape: boolean
  /** Image cards whose picture is not on this device: printed as plain boxes. */
  missingImages: number
  /** Removes the sheet and the page rule. */
  remove: () => void
}

/** Waits (briefly) for the sheet's images so they are on the pages. */
async function settleImages(root: HTMLElement) {
  const imgs = Array.from(root.querySelectorAll('img'))
  for (const img of imgs) img.loading = 'eager'
  await Promise.race([
    Promise.all(imgs.map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined)))),
    new Promise((resolve) => setTimeout(resolve, 4000)),
  ])
}

/**
 * Builds the print sheet for the exported cards and adds it to the document, with an @page rule
 * for the paper. While it is mounted, printing shows only the sheet (see print.css). Call inside
 * withEveryCardRendered() and keep that running until printing is done: the clones share the
 * cards' image URLs.
 */
export async function mountPrintSheet(ctx: BoardContextValue, opts: SheetOptions): Promise<PrintSheet> {
  const targets = exportTargets(ctx, opts.scope)
  const rects = targetRects(ctx, targets)
  const bounds = exportBounds([...rects.values()])
  if (!bounds) throw new ExportEmptyError(opts.scope === 'selection' ? 'Select cards to export first.' : 'This board has no cards to export.')
  const landscape = opts.landscape ?? chooseLandscape(bounds)
  const page = pageContentPx(opts.pageSize, landscape)
  const tiles: { area: Rect; zoom: number }[] =
    opts.layout === 'fit'
      ? [{ area: bounds, zoom: fitPageZoom(bounds, page) }]
      : (() => {
          const grid = tileGrid(bounds, page)
          return grid.tiles.map((area) => ({ area, zoom: grid.zoom }))
        })()

  const sheet = document.createElement('div')
  sheet.className = 'print-sheet'
  sheet.setAttribute('aria-hidden', 'true')
  sheet.style.setProperty('--print-bg', opts.background === 'white' ? '#ffffff' : 'var(--canvas-bg)')
  for (const t of tiles) {
    const pageEl = document.createElement('section')
    pageEl.className = 'print-page'
    pageEl.style.width = `${page.w}px`
    pageEl.style.height = `${page.h}px`
    const view = document.createElement('div')
    view.className = 'print-page__view'
    view.style.transform = `scale(${t.zoom})`
    // Centre a fitted board on its page.
    if (opts.layout === 'fit') {
      view.style.left = `${Math.max(0, (page.w - bounds.w * t.zoom) / 2)}px`
      view.style.top = `${Math.max(0, (page.h - bounds.h * t.zoom) / 2)}px`
    }
    view.appendChild(buildScene(ctx, targets, rects, { x: t.area.x, y: t.area.y }, { area: t.area }))
    pageEl.appendChild(view)
    sheet.appendChild(pageEl)
  }

  const pageRule = document.createElement('style')
  pageRule.dataset.printSheet = ''
  pageRule.textContent = `@page { size: ${opts.pageSize} ${landscape ? 'landscape' : 'portrait'}; margin: ${PAGE_MARGIN_MM}mm; }`
  document.head.appendChild(pageRule)
  document.body.appendChild(sheet)
  document.documentElement.classList.add('printing-sheet')
  document.body.classList.add('printing-sheet')
  // Pictures the board had not loaded: one object URL per picture, shared by every page, kept
  // until the sheet goes.
  const urls = new Map<string, string>()
  const remove = () => {
    sheet.remove()
    pageRule.remove()
    document.documentElement.classList.remove('printing-sheet')
    document.body.classList.remove('printing-sheet')
    for (const url of urls.values()) URL.revokeObjectURL(url)
    urls.clear()
  }
  let missingImages: number
  try {
    missingImages = await fillImageCards(ctx, sheet, async (hash, blob) => {
      let url = urls.get(hash)
      if (!url) urls.set(hash, (url = URL.createObjectURL(blob)))
      return url
    })
    await settleImages(sheet)
    await waitForLayout()
  } catch (err) {
    remove()
    throw err
  }
  return { pages: tiles.length, landscape, missingImages, remove }
}
