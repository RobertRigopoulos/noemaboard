import { describe, expect, it } from 'vitest'
import { axisLock, copyDropPlan, keepAspectHeight, shouldToggleOnRelease } from './dragMath'

describe('axisLock', () => {
  it('picks the dominant axis when none is locked yet', () => {
    expect(axisLock(10, 3, null)).toEqual({ dx: 10, dy: 0, locked: 'x' })
    expect(axisLock(-3, -10, null)).toEqual({ dx: 0, dy: -10, locked: 'y' })
    // A tie goes to x.
    expect(axisLock(5, -5, null)).toEqual({ dx: 5, dy: 0, locked: 'x' })
  })

  it('holds the chosen axis while the other delta grows', () => {
    let state = axisLock(12, 2, null)
    state = axisLock(14, 40, state.locked)
    expect(state).toEqual({ dx: 14, dy: 0, locked: 'x' })
    state = axisLock(15, 300, state.locked)
    expect(state).toEqual({ dx: 15, dy: 0, locked: 'x' })
  })

  it('re-picks the axis once reset to null (Shift released and pressed again)', () => {
    const held = axisLock(15, 300, 'x')
    expect(held.locked).toBe('x')
    expect(axisLock(15, 300, null)).toEqual({ dx: 0, dy: 300, locked: 'y' })
  })
})

describe('shouldToggleOnRelease', () => {
  it('only removes an already-selected card on a modifier click without a drag', () => {
    expect(shouldToggleOnRelease(true, true, false)).toBe(true)
    expect(shouldToggleOnRelease(true, true, true)).toBe(false)
    expect(shouldToggleOnRelease(false, true, false)).toBe(false)
    expect(shouldToggleOnRelease(true, false, false)).toBe(false)
  })
})

describe('copyDropPlan', () => {
  it('keeps copies on the canvas without a target', () => {
    expect(copyDropPlan(null, false)).toEqual({ kind: 'canvas', placeColumnChildren: false })
    expect(copyDropPlan(null, true)).toEqual({ kind: 'canvas', placeColumnChildren: true })
  })

  it('makes nothing when dropped on the trash', () => {
    expect(copyDropPlan({ kind: 'trash' }, false)).toEqual({ kind: 'none' })
    expect(copyDropPlan({ kind: 'trash' }, true)).toEqual({ kind: 'none' })
  })

  it('inserts the copies into a column at the drop index', () => {
    expect(copyDropPlan({ kind: 'column', columnId: 'col', index: 2 }, true)).toEqual({ kind: 'column', columnId: 'col', index: 2 })
  })

  it('moves the copies into a board (card or breadcrumb)', () => {
    expect(copyDropPlan({ kind: 'board', cardId: 'card', boardId: 'b1' }, false)).toEqual({ kind: 'board', boardId: 'b1' })
    expect(copyDropPlan({ kind: 'board', cardId: '', boardId: 'parent' }, true)).toEqual({ kind: 'board', boardId: 'parent' })
  })

  it('never pins a copy: an attach target drops on the canvas', () => {
    expect(copyDropPlan({ kind: 'attach', cardId: 'n1' }, false)).toEqual({ kind: 'canvas', placeColumnChildren: false })
  })
})

describe('keepAspectHeight', () => {
  it('scales the start height with the width', () => {
    expect(keepAspectHeight(200, 100, 50)).toBe(100)
    expect(keepAspectHeight(150, 300, 300)).toBe(150)
    expect(Number.isFinite(keepAspectHeight(100, 0, 80))).toBe(true)
  })
})
