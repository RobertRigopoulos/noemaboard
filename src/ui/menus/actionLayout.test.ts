import { describe, expect, it } from 'vitest'
import type { CardActionGroup } from '../../cards/cardActions'
import { groupActions, splitToolbarActions, withSeparators, type Groupable } from './actionLayout'

interface A extends Groupable {
  id: string
  children?: A[]
}
const a = (id: string, group: CardActionGroup, extra: Partial<A> = {}): A => ({ id, group, ...extra })
const ids = (sections: A[][]) => sections.map((s) => s.map((x) => x.id))

describe('groupActions', () => {
  it('orders sections by CARD_ACTION_GROUPS and keeps input order inside a section', () => {
    const items = [a('lock', 'arrange'), a('edit', 'view'), a('crop', 'media'), a('dup', 'edit'), a('open', 'view'), a('pdf', 'export')]
    expect(ids(groupActions(items, false))).toEqual([['edit', 'open'], ['dup'], ['crop'], ['lock'], ['pdf']])
  })

  it('leaves out inMenu: false and empty sections', () => {
    const items = [a('a', 'edit'), a('b', 'collab', { inMenu: false }), a('c', 'edit', { inMenu: true })]
    expect(ids(groupActions(items, false))).toEqual([['a', 'c']])
  })

  it('keeps only readOnlyOk items on read-only boards, filtering children too', () => {
    const items = [
      a('copy', 'edit', { readOnlyOk: true }),
      a('dup', 'edit'),
      a('download', 'export', {
        readOnlyOk: true,
        children: [a('png', 'export', { readOnlyOk: true }), a('replace', 'export')],
      }),
      a('convert', 'convert', { readOnlyOk: true, children: [a('toDoc', 'convert')] }),
    ]
    const sections = groupActions(items, true)
    expect(ids(sections)).toEqual([['copy'], ['download']])
    expect(sections[1][0].children?.map((c) => c.id)).toEqual(['png'])
    // Writable boards keep everything.
    expect(ids(groupActions(items, false))).toEqual([['copy', 'dup'], ['convert'], ['download']])
  })

  it('puts unknown groups last instead of dropping them', () => {
    const items = [a('x', 'future' as CardActionGroup), a('y', 'view')]
    expect(ids(groupActions(items, false))).toEqual([['y'], ['x']])
  })
})

describe('withSeparators', () => {
  it('puts one separator between non-empty sections and none at the ends', () => {
    const rows = withSeparators([[1, 2], [], [3], [4]])
    expect(rows.map((r) => (r.kind === 'sep' ? '|' : r.item))).toEqual([1, 2, '|', 3, '|', 4])
    expect(withSeparators([])).toEqual([])
    expect(withSeparators([[], [5]]).map((r) => r.kind)).toEqual(['item'])
  })
})

describe('splitToolbarActions', () => {
  const fit = { available: 600, fixed: 300, button: 32, windowWidth: 1200 }
  const list = ['a', 'b', 'c', 'd', 'e']

  it('shows every button when they fit', () => {
    expect(splitToolbarActions(list, fit)).toEqual({ shown: list, overflow: [] })
  })

  it('keeps the first three when the bar would be too wide', () => {
    expect(splitToolbarActions(list, { ...fit, available: 400 })).toEqual({ shown: ['a', 'b', 'c'], overflow: ['d', 'e'] })
  })

  it('keeps the first three on narrow windows even when they fit', () => {
    expect(splitToolbarActions(list, { ...fit, windowWidth: 480 })).toEqual({ shown: ['a', 'b', 'c'], overflow: ['d', 'e'] })
  })

  it('never hides anything when there are three or fewer', () => {
    expect(splitToolbarActions(['a', 'b'], { ...fit, available: 10, windowWidth: 300 })).toEqual({ shown: ['a', 'b'], overflow: [] })
  })
})
