/**
 * Pure Yjs helpers for task lists stored in a rich-text fragment (TipTap `taskItem` elements with a
 * boolean `checked` attribute). Task items are counted in document order (depth-first, pre-order),
 * which is the order their checkboxes appear in the rendered HTML.
 */
import * as Y from 'yjs'
import { LOCAL_ORIGIN } from '../model/board'
import { cleanAssignee, cleanDue, dueState } from './taskMeta'
import { cleanMentionLabel } from './mentionAttrs'

function forEachTaskItem(root: Y.XmlFragment | Y.XmlElement, visit: (item: Y.XmlElement) => boolean | void): boolean {
  for (const child of root.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'taskItem' && visit(child) === true) return true
    if (forEachTaskItem(child, visit)) return true
  }
  return false
}

export function isTaskChecked(item: Y.XmlElement): boolean {
  return (item.getAttribute('checked') as unknown) === true
}

/** Finds the index-th task item (pre-order). */
export function findTaskItem(fragment: Y.XmlFragment, index: number): Y.XmlElement | null {
  if (!Number.isInteger(index) || index < 0) return null
  let i = 0
  let found: Y.XmlElement | null = null
  forEachTaskItem(fragment, (item) => {
    if (i++ === index) {
      found = item
      return true
    }
  })
  return found
}

/**
 * Pre-order index of a task item, or -1 when it is not (or no longer) part of the fragment: deleted,
 * or inside something that was deleted. Indices shift as tasks are added or removed above, so code
 * that has to follow one task keeps its element and asks for the index when it needs one.
 */
export function taskIndexOf(fragment: Y.XmlFragment, item: Y.XmlElement): number {
  let i = 0
  let found = -1
  try {
    forEachTaskItem(fragment, (el) => {
      if (el === item) {
        found = i
        return true
      }
      i++
    })
  } catch {
    return -1
  }
  return found
}

/**
 * Toggles (or sets) the `checked` attribute of the index-th task item.
 * Runs in one transaction with the given origin (LOCAL_ORIGIN = undoable on the board).
 * Returns the new checked state, or null when there is no such item.
 */
export function toggleTaskItem(fragment: Y.XmlFragment, index: number, opts: { checked?: boolean; origin?: unknown } = {}): boolean | null {
  const item = findTaskItem(fragment, index)
  if (!item) return null
  const next = opts.checked ?? !isTaskChecked(item)
  const apply = () => item.setAttribute('checked', next as unknown as string)
  if (fragment.doc) fragment.doc.transact(apply, opts.origin ?? LOCAL_ORIGIN)
  else apply()
  return next
}

export interface TaskStats {
  total: number
  done: number
}

function hasText(node: Y.XmlElement): boolean {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText ? child.length > 0 : child instanceof Y.XmlElement && hasText(child)) return true
  }
  return false
}

/** Progress of a task list. Blank items (e.g. the empty line being typed into) are not counted. */
export function taskStats(fragment: Y.XmlFragment): TaskStats {
  let total = 0
  let done = 0
  try {
    forEachTaskItem(fragment, (item) => {
      if (!hasText(item)) return
      total++
      if (isTaskChecked(item)) done++
    })
  } catch {
    /* malformed content from a peer: report what we counted */
  }
  return { total, done }
}

// ---------------------------------------------------------------------------
// Due dates and assignees

export interface TaskAttrPatch {
  /** A due value (see taskMeta.ts), or null to clear it. */
  due?: string | null
  /** A member id, or null to unassign. */
  assignee?: string | null
}

/**
 * Sets the due date and/or assignee of the index-th task item. See setTaskElementAttr.
 */
export function setTaskAttr(fragment: Y.XmlFragment, index: number, patch: TaskAttrPatch, origin: unknown = LOCAL_ORIGIN): boolean {
  const item = findTaskItem(fragment, index)
  return item ? setTaskElementAttr(item, patch, origin) : false
}

/**
 * Sets the due date and/or assignee of a task item in one transaction (LOCAL_ORIGIN = undoable).
 * Values are validated; an invalid one rejects the whole patch. Null removes the attribute, which is
 * how the editor binding stores a default value. A deleted item is left alone. Returns whether
 * anything was written.
 */
export function setTaskElementAttr(item: Y.XmlElement, patch: TaskAttrPatch, origin: unknown = LOCAL_ORIGIN): boolean {
  if (item.nodeName !== 'taskItem' || item._item?.deleted) return false
  const writes: [string, string | null][] = []
  if (patch.due !== undefined) {
    const due = patch.due === null ? null : cleanDue(patch.due)
    if (patch.due !== null && !due) return false
    writes.push(['due', due])
  }
  if (patch.assignee !== undefined) {
    const assignee = patch.assignee === null ? null : cleanAssignee(patch.assignee)
    if (patch.assignee !== null && !assignee) return false
    writes.push(['assignee', assignee])
  }
  const changed = writes.filter(([key, value]) => (item.getAttribute(key) ?? null) !== value)
  if (!changed.length) return false
  const apply = () => {
    for (const [key, value] of changed) {
      if (value === null) item.removeAttribute(key)
      else item.setAttribute(key, value)
    }
  }
  if (item.doc) item.doc.transact(apply, origin)
  else apply()
  return true
}

function textOfBlock(el: Y.XmlElement): string {
  let s = ''
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert?: unknown }[]) if (typeof op.insert === 'string') s += op.insert
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'mention') s += `@${cleanMentionLabel(child.getAttribute('label'))}`
      else if (child.nodeName === 'hardBreak') s += ' '
      else s += textOfBlock(child)
    }
  }
  return s
}

export interface TaskInfo {
  /** Pre-order index, as used by findTaskItem / toggleTaskItem. */
  index: number
  checked: boolean
  due: string | null
  assignee: string | null
  /** Text of the task's own line (nested tasks not included). */
  text: string
}

/** Every task item with its (validated) metadata, in document order. */
export function listTasks(fragment: Y.XmlFragment): TaskInfo[] {
  const out: TaskInfo[] = []
  try {
    forEachTaskItem(fragment, (item) => {
      const first = item.get(0)
      out.push({
        index: out.length,
        checked: isTaskChecked(item),
        due: cleanDue(item.getAttribute('due')),
        assignee: cleanAssignee(item.getAttribute('assignee')),
        text: first instanceof Y.XmlElement && first.nodeName !== 'taskList' ? textOfBlock(first).trim() : '',
      })
    })
  } catch {
    /* malformed content from a peer: report what we read */
  }
  return out
}

/** Unchecked tasks whose due date is before `today` (a local date key). */
export function countOverdue(fragment: Y.XmlFragment, today: string): number {
  let n = 0
  for (const t of listTasks(fragment)) if (!t.checked && t.due && dueState(t.due, today) === 'overdue') n++
  return n
}

/** Short stable hash of a task's text (FNV-1a), so a reminder key changes when the task is rewritten. */
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// ---------------------------------------------------------------------------
// Completed tasks

/** `hideDone` card field of a to-do: only a real `true` counts (peers may write anything). */
export function readHideDone(value: unknown): boolean {
  return value === true
}

/** True when any task item is checked. */
export function hasCheckedTasks(fragment: Y.XmlFragment): boolean {
  try {
    return forEachTaskItem(fragment, (item) => isTaskChecked(item))
  } catch {
    return false
  }
}

/**
 * How many task items "Hide completed" hides: checked items with no unchecked task anywhere inside
 * them (an open sub-task keeps its finished parent visible, so it can still be seen and ticked).
 * Nested and blank items count too: this is what disappears. Matches the rule in text-cards.css.
 */
export function countHiddenDone(fragment: Y.XmlFragment): number {
  let hidden = 0
  // Returns whether an unchecked task item sits anywhere below `root`.
  const visit = (root: Y.XmlFragment | Y.XmlElement): boolean => {
    let open = false
    for (const child of root.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      const openInside = visit(child)
      if (child.nodeName === 'taskItem') {
        if (!isTaskChecked(child)) open = true
        else if (!openInside) hidden++
      }
      if (openInside) open = true
    }
    return open
  }
  try {
    visit(fragment)
  } catch {
    /* malformed content from a peer: report what we counted */
  }
  return hidden
}

function countTaskItems(el: Y.XmlElement): number {
  let n = el.nodeName === 'taskItem' ? 1 : 0
  for (const child of el.toArray()) if (child instanceof Y.XmlElement) n += countTaskItems(child)
  return n
}

function emptyTaskItem(): Y.XmlElement {
  const item = new Y.XmlElement('taskItem')
  item.setAttribute('checked', false as unknown as string)
  item.insert(0, [new Y.XmlElement('paragraph')])
  return item
}

/**
 * Removes every checked task item together with everything nested in it, in one transaction
 * (LOCAL_ORIGIN = undoable). A top-level task list left empty keeps one empty unchecked item so
 * there is still somewhere to type; an emptied nested list goes away. Returns how many task items
 * were removed (nested ones included).
 */
export function deleteCheckedTasks(fragment: Y.XmlFragment, origin: unknown = LOCAL_ORIGIN): number {
  let removed = 0
  const prune = (parent: Y.XmlFragment | Y.XmlElement) => {
    const children = parent.toArray()
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === 'taskList') {
        const items = child.toArray()
        for (let j = items.length - 1; j >= 0; j--) {
          const item = items[j]
          if (item instanceof Y.XmlElement && item.nodeName === 'taskItem' && isTaskChecked(item)) {
            removed += countTaskItems(item)
            child.delete(j, 1)
          }
        }
        if (child.length === 0) {
          // A list item still has its own line without the nested list; anywhere else the list
          // is the only content of its parent, which must not end up empty.
          if (parent instanceof Y.XmlElement && (parent.nodeName === 'taskItem' || parent.nodeName === 'listItem')) {
            parent.delete(i, 1)
            continue
          }
          child.insert(0, [emptyTaskItem()])
        }
      }
      prune(child)
    }
  }
  const run = () => prune(fragment)
  if (fragment.doc) fragment.doc.transact(run, origin)
  else run()
  return removed
}
