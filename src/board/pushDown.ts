/**
 * Mod+Enter "next card below": the new card pushes the cards under it down so nothing overlaps.
 * Pure maths over plain rects; the caller writes the patches in the same transaction as the card.
 */
import { snap } from './prefs'

export interface PushRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PushCandidate extends PushRect {
  id: string
  /** Only free, unlocked, non-line cards may be pushed. */
  movable: boolean
}

const overlapsX = (a: PushRect, b: PushRect) => a.x < b.x + b.w && a.x + a.w > b.x

/**
 * New y for every card that has to move down. Candidates are the cards whose top is at or below
 * `fromY` (the source card's top; default the new card's top). The new card pushes the candidates
 * it overlaps horizontally that it covers or that sit below it, including a card in the gap between
 * the source and the new card; a card in that gap ending above the new card stays. Pushed cards push
 * the cards under them in turn (cascade), so the cards keep their order. Cards above `fromY`, locked
 * cards, lines and column children (movable false) never move.
 */
export function pushDownPatches(
  newRect: PushRect,
  others: readonly PushCandidate[],
  gap = 20,
  snapTo: (v: number) => number = snap,
  fromY = newRect.y,
): Record<string, { y: number }> {
  const out: Record<string, { y: number }> = {}
  const pool = others.filter((c) => c.movable && c.y >= Math.min(fromY, newRect.y)).map((c) => ({ ...c }))
  // Top to bottom, so a card is placed after everything that can push it.
  pool.sort((a, b) => a.y - b.y || a.x - b.x)
  const pushers: PushRect[] = []
  for (const c of pool) {
    const reachesNew = c.y >= newRect.y || c.y + c.h > newRect.y
    let minY = reachesNew && overlapsX(newRect, c) ? newRect.y + newRect.h + gap : -Infinity
    // The cards after a pushed card in the pool started at or below it: they stay below it.
    for (const p of pushers) {
      if (overlapsX(p, c)) minY = Math.max(minY, p.y + p.h + gap)
    }
    if (c.y < minY) {
      c.y = snapTo(minY)
      // Snapping may round up a little; never round back into the pusher.
      if (c.y < minY) c.y = Math.ceil(minY)
      out[c.id] = { y: c.y }
      pushers.push(c)
    }
  }
  return out
}
