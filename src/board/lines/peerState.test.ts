import { describe, expect, it } from 'vitest'
import { computePeerLineState, parseDragPreview, safeColor } from './peerState'

const lines = new Set(['line1', 'line2'])
const isLine = (id: string) => lines.has(id)

describe('peer drag previews', () => {
  it('parses a valid preview', () => {
    expect(parseDragPreview({ ids: ['a1', 'b2'], dx: 10, dy: -5 })).toEqual({ ids: ['a1', 'b2'], offset: { dx: 10, dy: -5 } })
    expect(parseDragPreview({ ids: ['a1'], dx: 0, dy: 0, w: 320, h: 200 })?.offset).toEqual({ dx: 0, dy: 0, w: 320, h: 200 })
  })

  it('rejects or cleans malformed data', () => {
    expect(parseDragPreview(null)).toBeNull()
    expect(parseDragPreview({ ids: 'a1', dx: 1, dy: 1 })).toBeNull()
    expect(parseDragPreview({ ids: [42, ''], dx: 1, dy: 1 })).toBeNull()
    const p = parseDragPreview({ ids: ['ok', 'x'.repeat(500)], dx: NaN, dy: 1e12, w: -4, h: 'big' })
    expect(p).toEqual({ ids: ['ok'], offset: { dx: 0, dy: 0 } })
  })

  it('caps the number of ids', () => {
    const ids = Array.from({ length: 10000 }, (_, i) => `id${i}`)
    expect(parseDragPreview({ ids, dx: 1, dy: 1 })!.ids.length).toBe(5000)
  })
})

describe('computePeerLineState', () => {
  it('ignores our own state and collects drags and selected lines', () => {
    const states = new Map<number, unknown>([
      [1, { user: { color: '#ff0000' }, drag: { ids: ['card1'], dx: 5, dy: 6 }, selection: ['line1'] }],
      [2, { user: { color: '#00ff00' }, drag: null, selection: ['card9', 'line2', 'line1'] }],
      [3, { user: { color: '#0000ff' }, drag: { ids: ['mine'], dx: 1, dy: 1 }, selection: ['line2'] }],
    ])
    const { state, key } = computePeerLineState(states, 3, isLine)
    expect(state.drags.get('card1')).toEqual({ dx: 5, dy: 6 })
    expect(state.drags.has('mine')).toBe(false)
    expect(state.selectedBy.get('line1')).toBe('#ff0000')
    expect(state.selectedBy.get('line2')).toBe('#00ff00')
    expect(state.selectedBy.has('card9')).toBe(false)
    expect(key).not.toBe('')
  })

  it('has a stable key when nothing relevant changes', () => {
    const a = new Map<number, unknown>([[1, { user: { color: '#ff0000' }, pointer: { x: 1, y: 1 }, selection: ['line1'] }]])
    const b = new Map<number, unknown>([[1, { user: { color: '#ff0000' }, pointer: { x: 99, y: 5 }, selection: ['line1'] }]])
    expect(computePeerLineState(a, 0, isLine).key).toBe(computePeerLineState(b, 0, isLine).key)
  })

  it('returns an empty state when no peer drags or selects lines', () => {
    const { state, key } = computePeerLineState(new Map([[1, { user: { color: '#fff' }, selection: ['card'] }]]), 0, isLine)
    expect(key).toBe('')
    expect(state.drags.size).toBe(0)
    expect(state.selectedBy.size).toBe(0)
  })

  it('falls back to a default color for unsafe peer colors', () => {
    const { state } = computePeerLineState(new Map([[1, { user: { color: 'url(javascript:x)' }, selection: ['line1'] }]]), 0, isLine)
    expect(state.selectedBy.get('line1')).toBe('var(--select)')
    expect(safeColor('#abc')).toBe('#abc')
    expect(safeColor('red')).toBeNull()
  })
})
