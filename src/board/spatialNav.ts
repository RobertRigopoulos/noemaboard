/** Pure helpers for moving between cards with the keyboard (Alt+Arrow, Tab). */
import { clusterRows } from './arrange'

export interface NavRect {
  x: number
  y: number
  w: number
  h: number
}

export type NavDirection = 'left' | 'right' | 'up' | 'down'

export interface NavCandidate {
  id: string
  rect: NavRect
}

const centre = (r: NavRect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/**
 * Nearest card in a direction: candidates whose centre lies in the 90 degree cone opening in `dir`
 * from `from`'s centre. Score = distance along `dir` + 2 x the sideways offset, lowest wins, so a
 * card straight ahead beats a closer diagonal one.
 */
export function nextInDirection(from: NavRect, candidates: readonly NavCandidate[], dir: NavDirection): string | null {
  const o = centre(from)
  let best: string | null = null
  let bestScore = Infinity
  for (const c of candidates) {
    const p = centre(c.rect)
    const dx = p.x - o.x
    const dy = p.y - o.y
    const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy
    const side = Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    if (primary <= 0 || side > primary) continue
    const score = primary + 2 * side
    if (score < bestScore || (score === bestScore && best !== null && c.id < best)) {
      best = c.id
      bestScore = score
    }
  }
  return best
}

export interface ReadingItem {
  id: string
  rect: NavRect
  /** Column id for a card stacked in a column (null for free cards). */
  parent: string | null
  /** Position inside the column (fractional index); compared as strings. */
  order?: string
}

/**
 * Tab order for a board: free cards in rows (a card joins a row when its vertical centre lies
 * inside the row's band), each row left to right, with a column's children listed right after the
 * column in column order. Children whose column is not in the list count as free cards.
 */
export function readingOrder(items: readonly ReadingItem[]): string[] {
  const ids = new Set(items.map((i) => i.id))
  const free: (ReadingItem & NavRect)[] = []
  const children = new Map<string, ReadingItem[]>()
  for (const it of items) {
    if (it.parent && ids.has(it.parent)) {
      let list = children.get(it.parent)
      if (!list) children.set(it.parent, (list = []))
      list.push(it)
    } else free.push({ ...it, ...it.rect })
  }
  const out: string[] = []
  for (const row of clusterRows(free)) {
    for (const it of row) {
      out.push(it.id)
      const kids = children.get(it.id)
      if (!kids) continue
      kids.sort((a, b) => {
        const oa = a.order ?? ''
        const ob = b.order ?? ''
        return oa < ob ? -1 : oa > ob ? 1 : a.id < b.id ? -1 : 1
      })
      for (const k of kids) out.push(k.id)
    }
  }
  return out
}

/**
 * Index of the card a Tab press moves to, or null when focus should leave the canvas: past either
 * end, and on Shift+Tab before any card is reached (back to the header and toolbar, not to the
 * last of possibly hundreds of cards).
 */
export function tabStep(order: readonly string[], current: string | null, back: boolean): number | null {
  if (!order.length) return null
  const i = current ? order.indexOf(current) : -1
  if (i < 0) return back ? null : 0
  const next = back ? i - 1 : i + 1
  return next < 0 || next >= order.length ? null : next
}

/** True when `r` lies fully inside `area` shrunk by `inset` on every side. */
export function insideInset(r: NavRect, area: NavRect, inset: number): boolean {
  return r.x >= area.x + inset && r.y >= area.y + inset && r.x + r.w <= area.x + area.w - inset && r.y + r.h <= area.y + area.h - inset
}
