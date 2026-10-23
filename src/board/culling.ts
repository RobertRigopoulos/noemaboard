/**
 * Viewport culling: which free cards to render. Card heights mostly come from rendering (they are
 * measured locally, not stored), so a card that was never rendered has no known height. Guessing a
 * fixed height hides long cards whose top is above the view (a tall column you scrolled down, then
 * came back to): they are never rendered, so never measured. Unmeasured cards therefore count as
 * reaching down indefinitely until they have been rendered once and measured.
 */
import { create } from 'zustand'
import { isParked } from '../model/board'
import type { IndexedCard } from './cardIndex'
import { rectsIntersect, type Rect } from './geometry'

/** Space a column needs besides its children (header, padding), and the gap between children. */
const COLUMN_CHROME = 60
const COLUMN_GAP = 8

type Measured = (id: string) => { h: number } | undefined

/** Height to cull a free card with: stored, measured, or unbounded while unknown. */
export function cullHeight(c: IndexedCard, measured: Measured, children: readonly IndexedCard[] | undefined): number {
  if (c.h !== undefined) return c.h
  const own = measured(c.id)?.h
  if (c.card.type !== 'column') return own ?? Infinity
  if (own === undefined) return Infinity
  if (c.card.collapsed === true) return own
  // A culled column does not re-measure when cards are added to it: estimate from its children too.
  let sum = COLUMN_CHROME
  for (const ch of children ?? []) {
    const h = ch.h ?? measured(ch.id)?.h
    if (h === undefined) return Infinity
    sum += h + COLUMN_GAP
  }
  return Math.max(own, sum)
}

/** Ids of free cards (not lines, not parked with the drawer, not inside a live column) that intersect `area`, in index order. */
export function cullCards(
  cards: readonly IndexedCard[],
  area: Rect,
  lookup: (id: string) => IndexedCard | undefined,
  measured: Measured,
): string[] {
  const inLiveColumn = (c: IndexedCard) => !!c.parent && lookup(c.parent)?.type === 'column'
  const children = new Map<string, IndexedCard[]>()
  for (const c of cards) {
    if (!c.parent || !inLiveColumn(c)) continue
    let list = children.get(c.parent)
    if (!list) children.set(c.parent, (list = []))
    list.push(c)
  }
  const out: string[] = []
  for (const c of cards) {
    if (c.type === 'line' || inLiveColumn(c) || isParked(lookup, c.id)) continue
    const h = cullHeight(c, measured, children.get(c.id))
    if (rectsIntersect(area, { x: c.x, y: c.y, w: c.w, h })) out.push(c.id)
  }
  return out
}

/** Ids of every free card (not lines, not parked with the drawer, not inside a live column), ignoring the viewport. */
export function allFreeCards(cards: readonly IndexedCard[], lookup: (id: string) => IndexedCard | undefined): string[] {
  const out: string[] = []
  for (const c of cards) {
    if (c.type === 'line') continue
    if (c.parent && lookup(c.parent)?.type === 'column') continue
    if (isParked(lookup, c.id)) continue
    out.push(c.id)
  }
  return out
}

/**
 * While `all` is true the canvas renders every free card without culling (export and print need the
 * whole board in the DOM). Set it, await waitForLayout(), capture, then reset it.
 */
export const useRenderAll = create<{ all: boolean; set: (all: boolean) => void }>((set) => ({
  all: false,
  set: (all) => set({ all }),
}))
