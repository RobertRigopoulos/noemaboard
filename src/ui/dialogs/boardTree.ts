/**
 * The library's boards as a tree by parentId, for the "Move to / Copy to board" picker (pure).
 * Library entries come from peers' board cards and invite links, so parent links can be missing,
 * point to unknown boards or loop: orphans go to the top level and loops are cut.
 */
import { fold } from '../search/match'

export interface TreeBoard {
  id: string
  title: string
  icon: string | null
  color: string | null
  /** Parent board id; null or the Home id for top-level boards. */
  parentId: string | null
  lastOpened: number
}

export interface TreeNode {
  board: TreeBoard
  children: TreeNode[]
}

const byTitle = (a: TreeBoard, b: TreeBoard) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/**
 * Builds the forest. `homeId` is never a node (Home is not a target): its children are roots. A
 * board whose parent is unknown is a root. A parent link that would close a loop is ignored, so the
 * result is always a forest and every board appears exactly once.
 */
export function buildBoardTree(boards: readonly TreeBoard[], homeId = 'home'): TreeNode[] {
  const nodes = new Map<string, TreeNode>()
  for (const b of [...boards].sort(byTitle)) {
    if (b.id === homeId || nodes.has(b.id)) continue
    nodes.set(b.id, { board: b, children: [] })
  }
  const parentOf = new Map<string, string>()
  /** True when `ancestor` is `id` or above it through the links accepted so far. */
  const isAncestor = (ancestor: string, id: string) => {
    let cur: string | undefined = id
    for (let n = 0; cur !== undefined && n <= nodes.size; n++) {
      if (cur === ancestor) return true
      cur = parentOf.get(cur)
    }
    return false
  }
  const roots: TreeNode[] = []
  for (const node of nodes.values()) {
    const p = node.board.parentId
    const parent = p && p !== homeId && p !== node.board.id ? nodes.get(p) : undefined
    // Linking under a descendant of itself would make a loop.
    if (parent && !isAncestor(node.board.id, parent.board.id)) {
      parentOf.set(node.board.id, parent.board.id)
      parent.children.push(node)
    } else roots.push(node)
  }
  // Nodes were visited in title order, so children and roots are already sorted.
  return roots
}

/** Every board id in a subtree (the node itself included). */
export function subtreeIds(node: TreeNode, out = new Set<string>()): Set<string> {
  out.add(node.board.id)
  for (const c of node.children) subtreeIds(c, out)
  return out
}

/** Finds a node by board id. */
export function findNode(roots: readonly TreeNode[], id: string): TreeNode | null {
  for (const r of roots) {
    if (r.board.id === id) return r
    const hit = findNode(r.children, id)
    if (hit) return hit
  }
  return null
}

export interface FilterResult {
  roots: TreeNode[]
  /** Boards whose title matches the query. */
  matches: Set<string>
  /** Ancestors of matches: shown (and expanded) so every match keeps its place in the tree. */
  expanded: Set<string>
}

/**
 * Keeps the boards whose title contains the query (case- and accent-insensitive) and all their
 * ancestors. An empty query keeps everything.
 */
export function filterBoardTree(roots: readonly TreeNode[], query: string): FilterResult {
  const q = fold(query.trim()).text
  const matches = new Set<string>()
  const expanded = new Set<string>()
  if (!q) return { roots: [...roots], matches, expanded }
  const walk = (node: TreeNode): TreeNode | null => {
    const kids = node.children.map(walk).filter((c): c is TreeNode => !!c)
    const self = fold(node.board.title).text.includes(q)
    if (self) matches.add(node.board.id)
    if (kids.length) expanded.add(node.board.id)
    return self || kids.length ? { board: node.board, children: kids } : null
  }
  return { roots: roots.map(walk).filter((n): n is TreeNode => !!n), matches, expanded }
}

export interface TreeRow {
  node: TreeNode
  /** 1-based, for aria-level. */
  level: number
  parentId: string | null
}

/** Rows a tree view shows: roots, then the children of expanded nodes, depth first. */
export function visibleRows(roots: readonly TreeNode[], expanded: ReadonlySet<string>): TreeRow[] {
  const out: TreeRow[] = []
  const walk = (nodes: readonly TreeNode[], level: number, parentId: string | null) => {
    for (const n of nodes) {
      out.push({ node: n, level, parentId })
      if (n.children.length && expanded.has(n.board.id)) walk(n.children, level + 1, n.board.id)
    }
  }
  walk(roots, 1, null)
  return out
}

/** The `count` most recently opened boards (never opened ones are left out), skipping `exclude`. */
export function recentBoards(boards: readonly TreeBoard[], count: number, exclude: ReadonlySet<string> = new Set()): TreeBoard[] {
  return boards
    .filter((b) => b.lastOpened > 0 && !exclude.has(b.id))
    .sort((a, b) => b.lastOpened - a.lastOpened || byTitle(a, b))
    .slice(0, count)
}
