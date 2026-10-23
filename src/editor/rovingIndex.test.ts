import { describe, expect, it } from 'vitest'
import { rovingIndex } from './rovingIndex'

const none = [false, false, false, false]

describe('rovingIndex', () => {
  it('moves forward and back with all four arrows and wraps at the ends', () => {
    expect(rovingIndex('ArrowRight', 0, none)).toBe(1)
    expect(rovingIndex('ArrowDown', 1, none)).toBe(2)
    expect(rovingIndex('ArrowRight', 3, none)).toBe(0)
    expect(rovingIndex('ArrowLeft', 0, none)).toBe(3)
    expect(rovingIndex('ArrowUp', 2, none)).toBe(1)
  })

  it('skips disabled items in both directions', () => {
    const disabled = [false, true, true, false]
    expect(rovingIndex('ArrowRight', 0, disabled)).toBe(3)
    expect(rovingIndex('ArrowLeft', 3, disabled)).toBe(0)
    expect(rovingIndex('ArrowRight', 3, disabled)).toBe(0)
  })

  it('jumps to the first and last enabled item with Home and End', () => {
    const disabled = [true, false, false, true]
    expect(rovingIndex('Home', 2, disabled)).toBe(1)
    expect(rovingIndex('End', 1, disabled)).toBe(2)
  })

  it('starts from the edges when nothing has focus yet', () => {
    expect(rovingIndex('ArrowDown', -1, none)).toBe(0)
    expect(rovingIndex('ArrowUp', -1, none)).toBe(3)
  })

  it('keeps focus in a group whose items are all disabled but one', () => {
    const disabled = [true, false, true]
    expect(rovingIndex('ArrowRight', 1, disabled)).toBe(1)
    expect(rovingIndex('ArrowLeft', 1, disabled)).toBe(1)
    expect(rovingIndex('Home', 1, disabled)).toBe(1)
    expect(rovingIndex('End', 1, disabled)).toBe(1)
  })

  it('ignores other keys and groups without enabled items', () => {
    expect(rovingIndex('Enter', 0, none)).toBeNull()
    expect(rovingIndex('a', 0, none)).toBeNull()
    expect(rovingIndex('ArrowRight', 0, [true, true])).toBeNull()
    expect(rovingIndex('Home', 0, [])).toBeNull()
  })

  it('moves whole rows in grids without wrapping', () => {
    const grid = Array.from({ length: 14 }, () => false)
    expect(rovingIndex('ArrowDown', 2, grid, { columns: 7 })).toBe(9)
    expect(rovingIndex('ArrowUp', 9, grid, { columns: 7 })).toBe(2)
    // Already in the first row: stays put.
    expect(rovingIndex('ArrowUp', 2, grid, { columns: 7 })).toBe(2)
    // Left/Right still step one item and wrap.
    expect(rovingIndex('ArrowRight', 13, grid, { columns: 7 })).toBe(0)
  })
})
