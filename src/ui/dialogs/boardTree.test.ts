import { describe, expect, it } from 'vitest'
import { buildBoardTree, filterBoardTree, findNode, recentBoards, subtreeIds, visibleRows, type TreeBoard, type TreeNode } from './boardTree'

const b = (id: string, parentId: string | null, title = id, lastOpened = 0): TreeBoard => ({ id, title, icon: null, color: null, parentId, lastOpened })

/** "a(b,c(d))" style outline of a forest. */
function outline(nodes: readonly TreeNode[]): string {
  return nodes.map((n) => (n.children.length ? `${n.board.id}(${outline(n.children)})` : n.board.id)).join(',')
}

describe('buildBoardTree', () => {
  it('nests boards by parent, with Home children and orphans at the top level, sorted by title', () => {
    const tree = buildBoardTree([
      b('c', 'a', 'Charlie'),
      b('a', 'home', 'Alpha'),
      b('b', 'a', 'bravo'),
      b('o', 'missing', 'Orphan'),
      b('n', null, 'Nul'),
      b('d', 'c', 'Delta'),
      b('home', null, 'Home'),
    ])
    expect(outline(tree)).toBe('a(b,c(d)),n,o')
  })

  it('breaks loops so every board appears exactly once', () => {
    const tree = buildBoardTree([b('x', 'y', 'X'), b('y', 'z', 'Y'), b('z', 'x', 'Z'), b('self', 'self', 'Self')])
    const ids: string[] = []
    const walk = (ns: readonly TreeNode[]) => ns.forEach((n) => (ids.push(n.board.id), walk(n.children)))
    walk(tree)
    expect(ids.sort()).toEqual(['self', 'x', 'y', 'z'])
    // One link of the loop is cut (the last one met, z -> x): z becomes a root with y and x below it.
    expect(outline(tree)).toBe('self,z(y(x))')
  })

  it('keeps the first entry when an id repeats', () => {
    expect(outline(buildBoardTree([b('a', null, 'A'), b('a', null, 'A again')]))).toBe('a')
  })
})

describe('filterBoardTree', () => {
  const tree = buildBoardTree([b('a', null, 'Projects'), b('b', 'a', 'Café plans'), b('c', 'b', 'Menu'), b('d', null, 'Recipes'), b('e', 'a', 'Archive')])

  it('keeps matches and their ancestors, expanding the ancestors', () => {
    const r = filterBoardTree(tree, 'cafe')
    expect(outline(r.roots)).toBe('a(b)')
    expect([...r.matches]).toEqual(['b'])
    expect([...r.expanded]).toEqual(['a'])
  })

  it('keeps a matching parent with only its matching descendants', () => {
    const r = filterBoardTree(tree, 'MENU')
    expect(outline(r.roots)).toBe('a(b(c))')
    expect(r.expanded).toEqual(new Set(['a', 'b']))
  })

  it('returns everything for an empty query and nothing for no match', () => {
    expect(outline(filterBoardTree(tree, '  ').roots)).toBe(outline(tree))
    expect(filterBoardTree(tree, 'zzz').roots).toEqual([])
  })
})

describe('tree helpers', () => {
  const tree = buildBoardTree([b('a', null, 'A'), b('b', 'a', 'B'), b('c', 'b', 'C'), b('d', null, 'D')])

  it('lists visible rows depth first for the expanded nodes', () => {
    expect(visibleRows(tree, new Set()).map((r) => r.node.board.id)).toEqual(['a', 'd'])
    const rows = visibleRows(tree, new Set(['a', 'b']))
    expect(rows.map((r) => [r.node.board.id, r.level, r.parentId])).toEqual([
      ['a', 1, null],
      ['b', 2, 'a'],
      ['c', 3, 'b'],
      ['d', 1, null],
    ])
  })

  it('finds nodes and their subtrees', () => {
    expect(subtreeIds(findNode(tree, 'a')!)).toEqual(new Set(['a', 'b', 'c']))
    expect(findNode(tree, 'zz')).toBeNull()
  })

  it('picks the most recently opened boards', () => {
    const list = [b('a', null, 'A', 5), b('b', null, 'B', 0), b('c', null, 'C', 9), b('d', null, 'D', 7)]
    expect(recentBoards(list, 2).map((x) => x.id)).toEqual(['c', 'd'])
    expect(recentBoards(list, 5, new Set(['c'])).map((x) => x.id)).toEqual(['d', 'a'])
  })
})
