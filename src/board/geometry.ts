import { create } from 'zustand'
import type { Viewport } from './store'
import type { IndexedCard } from './cardIndex'
import { useView } from './store'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const rectsIntersect = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

export const pointInRect = (px: number, py: number, r: Rect) => px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h

export function normalizeRect(x1: number, y1: number, x2: number, y2: number): Rect {
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) }
}

export function unionRects(rects: Rect[]): Rect | null {
  if (!rects.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const r of rects) {
    x1 = Math.min(x1, r.x)
    y1 = Math.min(y1, r.y)
    x2 = Math.max(x2, r.x + r.w)
    y2 = Math.max(y2, r.y + r.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

/** The canvas element's client rect, registered by <Canvas>. */
let canvasEl: HTMLElement | null = null
export const setCanvasElement = (el: HTMLElement | null) => {
  canvasEl = el
}
export const getCanvasElement = () => canvasEl

/** Space is held: presses on the canvas (cards and lines included) pan instead of selecting or dragging. */
export function isSpacePanning(): boolean {
  return !!canvasEl?.classList.contains('is-space')
}

export function canvasRect(): DOMRect {
  return canvasEl?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

export function screenToBoard(clientX: number, clientY: number, v: Viewport = useView.getState().viewport) {
  const r = canvasRect()
  return { x: (clientX - r.left - v.x) / v.zoom, y: (clientY - r.top - v.y) / v.zoom }
}

export function boardToScreen(x: number, y: number, v: Viewport = useView.getState().viewport) {
  const r = canvasRect()
  return { x: x * v.zoom + v.x + r.left, y: y * v.zoom + v.y + r.top }
}

/** Board-space rectangle currently visible on screen. */
export function visibleBoardRect(v: Viewport = useView.getState().viewport): Rect {
  const r = canvasRect()
  return { x: -v.x / v.zoom, y: -v.y / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom }
}

// ---------------------------------------------------------------------------
// Card element registry and measured sizes. Card heights depend on rendered content,
// so each client measures them locally (they are not stored in the doc).

const elements = new Map<string, HTMLElement>()
const sizes = new Map<string, { w: number; h: number }>()

/** Bumped when any measured size changes; lines and overlays subscribe to it. */
export const useLayoutVersion = create<{ version: number; bump: () => void }>((set, get) => ({
  version: 0,
  bump: () => set({ version: get().version + 1 }),
}))

/**
 * Bumped when cards are measured for the first time (e.g. after opening a board, or a card that was
 * never rendered). Culling estimates unmeasured cards generously and recomputes on this.
 */
export const useMeasureVersion = create<{ version: number; bump: () => void }>((set, get) => ({
  version: 0,
  bump: () => set({ version: get().version + 1 }),
}))

let bumpScheduled = false
let firstMeasured = false
function scheduleBump() {
  if (bumpScheduled) return
  bumpScheduled = true
  requestAnimationFrame(() => {
    bumpScheduled = false
    useLayoutVersion.getState().bump()
    if (firstMeasured) {
      firstMeasured = false
      useMeasureVersion.getState().bump()
    }
  })
}

const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        let changed = false
        for (const e of entries) {
          const el = e.target as HTMLElement
          const id = el.dataset.cardId
          if (!id) continue
          const w = el.offsetWidth
          const h = el.offsetHeight
          const prev = sizes.get(id)
          if (!prev || prev.w !== w || prev.h !== h) {
            sizes.set(id, { w, h })
            changed = true
            if (!prev) firstMeasured = true
          }
        }
        if (changed) scheduleBump()
      })
    : null

/**
 * Registers the element rendering a card. A card can briefly have two shells (moving into or out of a
 * column re-mounts it under a new parent in the same commit), so the newest registration wins and
 * removal must go through unregisterCardElement with the element being removed.
 */
export function registerCardElement(id: string, el: HTMLElement | null) {
  if (!el) {
    // Legacy form: unconditional removal. Prefer unregisterCardElement(id, el).
    const prev = elements.get(id)
    if (prev) unregisterCardElement(id, prev)
    return
  }
  const prev = elements.get(id)
  if (prev === el) return
  if (prev) resizeObserver?.unobserve(prev)
  el.dataset.cardId = id
  elements.set(id, el)
  resizeObserver?.observe(el)
}

/** Removes a card element, but only if it is still the registered one (a newer shell may have replaced it). */
export function unregisterCardElement(id: string, el: HTMLElement) {
  if (elements.get(id) !== el) return
  resizeObserver?.unobserve(el)
  elements.delete(id)
}

export const getCardElement = (id: string) => elements.get(id)

export function measuredSize(id: string): { w: number; h: number } | undefined {
  return sizes.get(id)
}

/** Board-space rect of a rendered card element (works for cards inside columns too). */
export function elementBoardRect(id: string): Rect | null {
  const el = elements.get(id)
  if (!el || !el.isConnected) return null
  const r = el.getBoundingClientRect()
  const v = useView.getState().viewport
  const c = canvasRect()
  return { x: (r.left - c.left - v.x) / v.zoom, y: (r.top - c.top - v.y) / v.zoom, w: r.width / v.zoom, h: r.height / v.zoom }
}

export function clearLayoutCaches() {
  sizes.clear()
}

/** Board-space bounds of a card for overlay placement (stored size, measured size, or DOM rect). */
export function cardBounds(c: IndexedCard): Rect | null {
  if (c.card.type === 'line') {
    const { from, to } = c.card
    return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y) }
  }
  if (c.parent) return elementBoardRect(c.id)
  const h = c.h ?? measuredSize(c.id)?.h ?? elementBoardRect(c.id)?.h ?? 100
  return { x: c.x, y: c.y, w: c.w, h }
}

/** Resolves after two animation frames: React has committed and the browser has laid the result out. */
export function waitForLayout(): Promise<void> {
  if (typeof requestAnimationFrame === 'undefined') return Promise.resolve()
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
}

// The canvas registers its marquee so a press on a locked card (which acts as background) can start one.
type MarqueeStarter = (e: PointerEvent) => void
let marqueeStarter: MarqueeStarter | null = null
export const setMarqueeStarter = (fn: MarqueeStarter | null) => {
  marqueeStarter = fn
}

/** Starts a marquee selection from a pointer press (its clientX/Y is the anchor corner). */
export function startMarqueeFrom(e: PointerEvent): void {
  marqueeStarter?.(e)
}
