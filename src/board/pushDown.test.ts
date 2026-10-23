import { describe, expect, it } from 'vitest'
import { pushDownPatches, type PushCandidate } from './pushDown'

const exact = (v: number) => v
const card = (id: string, x: number, y: number, w: number, h: number, movable = true): PushCandidate => ({ id, x, y, w, h, movable })

// The new card spans y 100..180, so cards under it must start at 200 (gap 20).
const newRect = { x: 0, y: 100, w: 200, h: 80 }

describe('pushDownPatches', () => {
  it('cascades: the new card pushes A, A pushes B, B pushes C', () => {
    const a = card('a', 0, 150, 200, 100)
    const b = card('b', 50, 250, 100, 50)
    const c = card('c', 60, 330, 50, 50)
    expect(pushDownPatches(newRect, [c, a, b], 20, exact)).toEqual({ a: { y: 200 }, b: { y: 320 }, c: { y: 390 } })
  })

  it('leaves locked cards, lines and column children alone', () => {
    const locked = card('locked', 0, 150, 200, 100, false)
    const line = card('line', 0, 120, 100, 10, false)
    const child = card('child', 10, 160, 180, 40, false)
    expect(pushDownPatches(newRect, [locked, line, child], 20, exact)).toEqual({})
  })

  it('never moves cards that start above the new card', () => {
    const above = card('above', 0, 60, 200, 100)
    const below = card('below', 0, 110, 200, 40)
    expect(pushDownPatches(newRect, [above, below], 20, exact)).toEqual({ below: { y: 200 } })
  })

  it('pushes a card in the gap between the source and the new card when it reaches the new card', () => {
    // Source spans y 0..80 (fromY 0); the new card starts at 100.
    const gap = card('gap', 0, 90, 200, 40)
    const short = card('short', 0, 84, 200, 10)
    const aboveSource = card('aboveSource', 0, -10, 200, 150)
    expect(pushDownPatches(newRect, [gap, short, aboveSource], 20, exact, 0)).toEqual({ gap: { y: 200 } })
    // Without fromY only cards starting at the new card's top or lower are candidates.
    expect(pushDownPatches(newRect, [gap], 20, exact)).toEqual({})
  })

  it('keeps the order of a pushed card and the card that started below it', () => {
    // A is pushed to 200..230; D started under A (and right of the new card), so it stays under A.
    const a = card('a', 0, 150, 400, 30)
    const d = card('d', 300, 185, 100, 10)
    expect(pushDownPatches(newRect, [d, a], 20, exact, 0)).toEqual({ a: { y: 200 }, d: { y: 250 } })
  })

  it('gives no patches without overlap', () => {
    const beside = card('beside', 300, 120, 100, 100)
    const farBelow = card('far', 0, 900, 200, 100)
    const touching = card('touching', 200, 120, 100, 100)
    expect(pushDownPatches(newRect, [beside, farBelow, touching], 20, exact)).toEqual({})
  })

  it('snaps pushed cards to the grid without rounding back into the pusher', () => {
    const grid20 = (v: number) => Math.round(v / 20) * 20
    // Needs y >= 205: the grid would give 200, which overlaps, so it stays at 205.
    const rect = { x: 0, y: 100, w: 200, h: 85 }
    expect(pushDownPatches(rect, [card('a', 0, 150, 200, 50)], 20, grid20)).toEqual({ a: { y: 205 } })
    // Needs y >= 230: the grid rounds up to 240.
    expect(pushDownPatches({ ...rect, h: 110 }, [card('a', 0, 150, 200, 50)], 20, grid20)).toEqual({ a: { y: 240 } })
  })
})
