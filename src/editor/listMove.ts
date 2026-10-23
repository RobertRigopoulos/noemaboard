/**
 * Moving list items up and down with the keyboard (Alt+Shift+Up/Down in card editors).
 */
import { Fragment } from '@tiptap/pm/model'
import { NodeSelection, Selection, TextSelection, type Command } from '@tiptap/pm/state'

const ITEM_TYPES = new Set(['listItem', 'taskItem'])

/**
 * Swaps the list or task item around the selection with its previous (`up`) or next (`down`)
 * sibling, nested items included, in one transaction, and keeps the selection on the moved item.
 * The nearest item wins, so a nested item moves among its own siblings. Returns false (so the key
 * falls through) at the edge of the list or when the selection leaves the item.
 */
export function moveListItem(dir: 'up' | 'down'): Command {
  return (state, dispatch) => {
    const { $from, $to } = state.selection
    for (let depth = $from.depth; depth > 0; depth--) {
      const item = $from.node(depth)
      if (!ITEM_TYPES.has(item.type.name)) continue
      const itemStart = $from.before(depth)
      const itemEnd = $from.after(depth)
      if ($to.pos > itemEnd) return false
      const list = $from.node(depth - 1)
      const index = $from.index(depth - 1)
      const target = dir === 'up' ? index - 1 : index + 1
      if (target < 0 || target >= list.childCount) return false
      if (!dispatch) return true
      const sibling = list.child(target)
      const tr = state.tr
      let shift: number
      if (dir === 'up') {
        tr.replaceWith(itemStart - sibling.nodeSize, itemEnd, Fragment.from([item, sibling]))
        shift = -sibling.nodeSize
      } else {
        tr.replaceWith(itemStart, itemEnd + sibling.nodeSize, Fragment.from([sibling, item]))
        shift = sibling.nodeSize
      }
      const sel = state.selection
      let next: Selection
      if (sel instanceof NodeSelection) next = NodeSelection.create(tr.doc, sel.from + shift)
      else if (sel instanceof TextSelection) next = TextSelection.create(tr.doc, sel.anchor + shift, sel.head + shift)
      else next = Selection.near(tr.doc.resolve(sel.from + shift))
      dispatch(tr.setSelection(next).scrollIntoView())
      return true
    }
    return false
  }
}
