import { afterEach, describe, expect, it } from 'vitest'
import { cleanPrefs, DEFAULT_CANVAS_PREFS, snap, snapValue, useCanvasPrefs } from './prefs'

afterEach(() => useCanvasPrefs.setState({ ...DEFAULT_CANVAS_PREFS }))

describe('cleanPrefs', () => {
  it('falls back to the defaults for garbage', () => {
    for (const raw of [null, undefined, 'grid', 42, [], [true]]) expect(cleanPrefs(raw)).toEqual(DEFAULT_CANVAS_PREFS)
    expect(cleanPrefs({ showGrid: 'yes', snapToGrid: 1, gridSize: 15, unsortedOnMove: null })).toEqual(DEFAULT_CANVAS_PREFS)
    expect(cleanPrefs({ gridSize: '10' }).gridSize).toBe(20)
  })

  it('keeps valid values and drops unknown keys', () => {
    const out = cleanPrefs({ showGrid: false, snapToGrid: false, gridSize: 10, unsortedOnMove: false, evil: '<script>' })
    expect(out).toEqual({ showGrid: false, snapToGrid: false, gridSize: 10, unsortedOnMove: false })
    expect(cleanPrefs({ gridSize: 10 })).toEqual({ ...DEFAULT_CANVAS_PREFS, gridSize: 10 })
  })
})

describe('snapValue', () => {
  it('snaps to a 20 grid', () => {
    const p = { snapToGrid: true, gridSize: 20 as const }
    expect(snapValue(29, p)).toBe(20)
    expect(snapValue(31, p)).toBe(40)
    expect(snapValue(-31, p)).toBe(-40)
    expect(Object.is(snapValue(-9, p), 0)).toBe(true)
  })

  it('snaps to a 10 grid', () => {
    const p = { snapToGrid: true, gridSize: 10 as const }
    expect(snapValue(14, p)).toBe(10)
    expect(snapValue(15, p)).toBe(20)
  })

  it('only rounds to whole pixels when snapping is off or bypassed', () => {
    expect(snapValue(14.6, { snapToGrid: false, gridSize: 20 })).toBe(15)
    expect(snapValue(29, { snapToGrid: true, gridSize: 20 }, true)).toBe(29)
  })
})

describe('snap', () => {
  it('follows the current preferences', () => {
    expect(snap(29)).toBe(20)
    useCanvasPrefs.getState().set({ gridSize: 10 })
    expect(snap(29)).toBe(30)
    useCanvasPrefs.getState().set({ snapToGrid: false })
    expect(snap(29.4)).toBe(29)
    expect(useCanvasPrefs.getState().gridSize).toBe(10)
  })

  it('keeps the current value when set gets an invalid one', () => {
    useCanvasPrefs.getState().set({ gridSize: 10 })
    useCanvasPrefs.getState().set({ gridSize: 15 as unknown as 10, showGrid: 'no' as unknown as boolean })
    expect(useCanvasPrefs.getState().gridSize).toBe(10)
    expect(useCanvasPrefs.getState().showGrid).toBe(true)
  })
})
