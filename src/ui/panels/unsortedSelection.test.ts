import { describe, expect, it } from 'vitest'
import { actionIds, clickSelect, EMPTY_SELECTION, moveFocus, pruneSelection, rangeBetween, type ListSelection } from './unsortedSelection'

const ids = ['a', 'b', 'c', 'd', 'e']
const sel = (selected: string[], anchor: string | null = selected[0] ?? null, focus: string | null = anchor): ListSelection => ({
  selected: new Set(selected),
  anchor,
  focus,
})
const list = (s: ListSelection) => ids.filter((id) => s.selected.has(id))

describe('unsorted selection', () => {
  it('builds ranges in list order whichever end comes first', () => {
    expect(rangeBetween(ids, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(ids, 'd', 'b')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(ids, 'x', 'b')).toEqual([])
  })

  it('selects one row on a plain click, toggles with Ctrl and ranges with Shift', () => {
    let s = clickSelect(EMPTY_SELECTION, ids, 'b', { range: false, toggle: false })
    expect(list(s)).toEqual(['b'])
    s = clickSelect(s, ids, 'd', { range: false, toggle: true })
    expect(list(s)).toEqual(['b', 'd'])
    expect(s.anchor).toBe('d')
    s = clickSelect(s, ids, 'd', { range: false, toggle: true })
    expect(list(s)).toEqual(['b'])
    s = clickSelect(sel(['b']), ids, 'e', { range: true, toggle: false })
    expect(list(s)).toEqual(['b', 'c', 'd', 'e'])
    expect(s.anchor).toBe('b')
    // Shift+Ctrl adds the range to what was selected.
    s = clickSelect(sel(['a', 'c'], 'c'), ids, 'd', { range: true, toggle: true })
    expect(list(s)).toEqual(['a', 'c', 'd'])
    // Unknown ids change nothing.
    const before = sel(['a'])
    expect(clickSelect(before, ids, 'zz', { range: false, toggle: false })).toBe(before)
  })

  it('moves focus with arrows and extends ranges with Shift+Arrow', () => {
    let s = moveFocus(EMPTY_SELECTION, ids, 1, false)
    expect(s.focus).toBe('a')
    s = moveFocus(s, ids, 1, true)
    s = moveFocus(s, ids, 1, true)
    expect(list(s)).toEqual(['a', 'b', 'c'])
    s = moveFocus(s, ids, -1, true)
    expect(list(s)).toEqual(['a', 'b'])
    s = moveFocus(s, ids, 'last', false)
    expect(list(s)).toEqual(['e'])
    // Clamped at the ends.
    expect(moveFocus(s, ids, 1, false).focus).toBe('e')
    expect(moveFocus(EMPTY_SELECTION, [], 1, false)).toEqual(EMPTY_SELECTION)
  })

  it('prunes rows that left the drawer and refocuses nearby', () => {
    const s = sel(['b', 'c'], 'b', 'c')
    const next = pruneSelection(s, ['a', 'b', 'd', 'e'], ids)
    expect(list(next)).toEqual(['b'])
    expect(next.focus).toBe('d')
    expect(pruneSelection(s, ids)).toBe(s)
    expect(pruneSelection(sel(['e'], 'e', 'e'), ['a', 'b'], ids).focus).toBe('b')
  })

  it('acts on the whole selection only when the row is part of it', () => {
    const s = sel(['d', 'b'], 'b', 'd')
    expect(actionIds(s, ids, 'd')).toEqual(['b', 'd'])
    expect(actionIds(s, ids, 'a')).toEqual(['a'])
    expect(actionIds(s, ids, null)).toEqual(['b', 'd'])
    expect(actionIds(s, ids, 'gone')).toEqual([])
  })
})
