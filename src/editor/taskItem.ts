/**
 * To-do task items with a due date and an assignee.
 *
 * Both are attributes of the TipTap task item (`due`, `assignee`, default null) and travel with the
 * text. Static HTML shows them as chips after the task text; the live editor's node view adds the
 * same chips as buttons, plus "Set due date" and "Assign" buttons shown on the row being hovered or
 * typed in. The popover itself is React (TaskMetaPopover); the node view only asks for it through
 * the `onMeta` option.
 */
import { mergeAttributes, type Editor } from '@tiptap/core'
import type { DOMOutputSpec, Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView, type NodeView, type ViewMutationRecord } from '@tiptap/pm/view'
import { TaskItem, type TaskItemOptions } from '@tiptap/extension-list'
import { cleanAssignee, cleanDue, dueDescription, dueState, formatDueLabel, formatDueLong } from './taskMeta'
import { today as todayKey } from './dayClock'
import { calendarIcon, userRoundIcon } from './domIcons'

export type TaskMetaKind = 'due' | 'assign'

export interface TaskMetaRequest {
  kind: TaskMetaKind
  /** Document position of the task item. */
  pos: number
  /** What the popover is anchored at: the chip or button pressed, or the caret. */
  anchor: Element | DOMRect
}

export interface TaskMember {
  name: string
  color: string
  isMe: boolean
}

export interface TaskItemMetaOptions extends TaskItemOptions {
  /** Live editors: open the due date or assignee popover. Null in the static schema. */
  onMeta: ((request: TaskMetaRequest) => void) | null
  /** Live editors: the member an assignee id refers to (null = unknown). */
  member: ((id: string) => TaskMember | null) | null
}

/** Initials for an avatar chip: "Ada Lovelace" -> "AL", "grace" -> "G". */
export function memberInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = Array.from(parts[0])[0] ?? ''
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? '') : ''
  return (first + last).toUpperCase()
}

/** Chips after the task text in static HTML (the board fills in the assignee after rendering). */
export function taskMetaSpec(node: PMNode, now: Date = new Date()): DOMOutputSpec | null {
  const due = cleanDue(node.attrs.due)
  const assignee = cleanAssignee(node.attrs.assignee)
  if (!due && !assignee) return null
  const chips: DOMOutputSpec[] = []
  if (due) chips.push(['span', { class: 'task-chip task-chip--due', title: formatDueLong(due) }, formatDueLabel(due, now)])
  if (assignee) chips.push(['span', { class: 'task-chip task-chip--assignee' }])
  return ['span', { class: 'task-meta', contenteditable: 'false' }, ...chips]
}

// ---------------------------------------------------------------------------
// Live node view

const refreshers = new WeakMap<EditorView, Set<() => void>>()

/** Re-renders every task's chips in an editor (members renamed, a new day began). */
export function refreshTaskViews(view: EditorView): void {
  refreshers.get(view)?.forEach((fn) => fn())
}

const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+'
const SHIFT = MOD === '⌘' ? '⇧' : 'Shift+'

function checkboxLabel(checked: boolean): string {
  return checked ? 'Mark as not done' : 'Mark as done'
}

function setAttr(el: HTMLElement, name: string, value: string | null) {
  if (value === null) el.removeAttribute(name)
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function createTaskView(
  editor: Editor,
  view: EditorView,
  options: TaskItemMetaOptions,
  initial: PMNode,
  getPos: () => number | undefined,
): NodeView {
  let node = initial
  const li = document.createElement('li')
  const label = document.createElement('label')
  const checkbox = document.createElement('input')
  const styler = document.createElement('span')
  const content = document.createElement('div')
  const meta = document.createElement('span')

  for (const [k, v] of Object.entries(options.HTMLAttributes)) li.setAttribute(k, String(v))
  li.setAttribute('data-type', 'taskItem')
  label.contentEditable = 'false'
  checkbox.type = 'checkbox'
  meta.className = 'task-meta'
  meta.contentEditable = 'false'
  label.append(checkbox, styler)
  li.append(label, content, meta)

  checkbox.addEventListener('mousedown', (e) => e.preventDefault())
  checkbox.addEventListener('change', () => {
    const checked = checkbox.checked
    if (!editor.isEditable) {
      checkbox.checked = !checked
      return
    }
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .command(({ tr }) => {
        const pos = getPos()
        if (typeof pos !== 'number') return false
        const current = tr.doc.nodeAt(pos)
        if (!current || current.type.name !== 'taskItem') return false
        tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked })
        return true
      })
      .run()
  })

  const open = (kind: TaskMetaKind, anchor: Element) => {
    const pos = getPos()
    if (typeof pos !== 'number' || !editor.isEditable) return
    options.onMeta?.({ kind, pos, anchor })
  }

  const button = (cls: string, kind: TaskMetaKind): HTMLButtonElement => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = cls
    // Keep the caret (and focus) in the text: the popover takes focus itself when it opens.
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      open(kind, b)
    })
    return b
  }

  const dueChip = button('task-chip task-chip--due', 'due')
  const assigneeChip = button('task-chip task-chip--assignee', 'assign')
  // Overlays the end of the row (absolutely placed) so the text wraps exactly as in static HTML.
  const adds = document.createElement('span')
  adds.className = 'task-meta__adds'
  const addDue = button('task-meta__add', 'due')
  addDue.setAttribute('aria-label', 'Set due date')
  addDue.title = `Set due date (${MOD}${SHIFT}D)`
  addDue.append(calendarIcon(14))
  const addAssignee = button('task-meta__add', 'assign')
  addAssignee.setAttribute('aria-label', 'Assign')
  addAssignee.title = `Assign (${MOD}${SHIFT}A)`
  addAssignee.append(userRoundIcon(14))

  // Re-run by refreshTaskViews when the editor becomes read-only or editable again.
  const render = () => {
    const checked = node.attrs.checked === true
    const due = cleanDue(node.attrs.due)
    const assignee = cleanAssignee(node.attrs.assignee)
    const editable = editor.isEditable
    setAttr(li, 'data-checked', String(checked))
    setAttr(li, 'data-due', due)
    setAttr(li, 'data-assignee', assignee)
    checkbox.checked = checked
    checkbox.setAttribute('aria-label', checkboxLabel(checked))
    checkbox.disabled = !editable

    // Read-only text offers nothing to add, and its chips only show what is set.
    const missing = editable ? [!due && addDue, !assignee && addAssignee].filter((b): b is HTMLButtonElement => !!b) : []
    if (missing.length !== adds.childNodes.length || missing.some((b, i) => adds.childNodes[i] !== b)) adds.replaceChildren(...missing)
    const parts: HTMLElement[] = missing.length ? [adds] : []
    dueChip.disabled = !editable
    assigneeChip.disabled = !editable
    if (due) {
      const today = todayKey()
      const state = dueState(due, today)
      dueChip.textContent = formatDueLabel(due)
      dueChip.title = formatDueLong(due)
      dueChip.setAttribute('aria-label', editable ? `${dueDescription(due, today)}. Change due date` : dueDescription(due, today))
      dueChip.classList.toggle('is-overdue', !checked && state === 'overdue')
      dueChip.classList.toggle('is-today', !checked && state === 'today')
      parts.push(dueChip)
    }
    if (assignee) {
      const who = options.member?.(assignee) ?? null
      const name = who?.name ?? 'Someone who is not on this board'
      assigneeChip.textContent = who ? memberInitials(who.name) : '?'
      assigneeChip.style.background = who?.color ?? ''
      assigneeChip.classList.toggle('is-me', !!who?.isMe)
      assigneeChip.classList.toggle('is-unknown', !who)
      assigneeChip.title = who?.isMe ? `${name} (you)` : name
      assigneeChip.setAttribute('aria-label', editable ? `Assigned to ${name}. Change assignee` : `Assigned to ${name}`)
      parts.push(assigneeChip)
    }
    const same = parts.length === meta.childNodes.length && parts.every((p, i) => meta.childNodes[i] === p)
    if (!same) meta.replaceChildren(...parts)
  }
  render()

  // Keyed by the view passed in: node views are built while the view is constructed, before
  // editor.view refers to it.
  const set = refreshers.get(view) ?? new Set<() => void>()
  refreshers.set(view, set)
  set.add(render)

  return {
    dom: li,
    contentDOM: content,
    update: (next) => {
      if (next.type !== node.type) return false
      node = next
      render()
      return true
    },
    stopEvent: (event) => {
      const target = event.target as Node | null
      return !!target && (meta.contains(target) || label.contains(target))
    },
    ignoreMutation: (mutation: ViewMutationRecord) => {
      if (mutation.type === 'selection') return false
      const target = mutation.target
      return meta.contains(target) || label.contains(target) || (target === li && mutation.type === 'attributes')
    },
    destroy: () => {
      set.delete(render)
    },
  }
}

// ---------------------------------------------------------------------------
// Caret row: the add buttons also show on the task being typed in (touch screens have no hover)

const caretRowKey = new PluginKey('taskCaretRow')

function caretRow(state: EditorState): DecorationSet {
  const { $head } = state.selection
  for (let d = $head.depth; d > 0; d--) {
    const node = $head.node(d)
    if (node.type.name !== 'taskItem') continue
    const from = $head.before(d)
    return DecorationSet.create(state.doc, [Decoration.node(from, from + node.nodeSize, { class: 'is-caret-row' })])
  }
  return DecorationSet.empty
}

/** Task item around the selection, as a document position. */
export function taskAtSelection(state: EditorState): number | null {
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'taskItem') return $from.before(d)
  }
  return null
}

/**
 * Pre-order index of the task item node at `pos` among all task items of the document (the order
 * tasks.ts uses for the shared text), or -1 when no task item starts at `pos`.
 */
export function taskIndexAtPos(doc: PMNode, pos: number): number {
  if (!Number.isInteger(pos) || pos < 0 || pos >= doc.content.size) return -1
  if (doc.nodeAt(pos)?.type.name !== 'taskItem') return -1
  let index = 0
  // Everything that starts before `pos`: earlier tasks and the tasks this one is nested in.
  doc.nodesBetween(0, pos, (node, start) => {
    if (node.type.name === 'taskItem' && start < pos) index++
  })
  return index
}

/** Position of the index-th task item (pre-order), or null when there are not that many. */
export function taskPosAtIndex(doc: PMNode, index: number): number | null {
  if (!Number.isInteger(index) || index < 0) return null
  let i = 0
  let found: number | null = null
  doc.descendants((node, pos) => {
    if (found !== null) return false
    if (node.type.name === 'taskItem' && i++ === index) {
      found = pos
      return false
    }
    return true
  })
  return found
}

function openAtCaret(editor: Editor, kind: TaskMetaKind, onMeta: TaskItemMetaOptions['onMeta']): boolean {
  if (!onMeta || !editor.isEditable) return false
  const pos = taskAtSelection(editor.state)
  if (pos === null) return false
  const dom = editor.view.nodeDOM(pos)
  const chip = dom instanceof HTMLElement ? dom.querySelector(':scope > .task-meta') : null
  let anchor: Element | DOMRect
  if (chip && chip.getClientRects().length) anchor = chip
  else {
    const c = editor.view.coordsAtPos(editor.state.selection.head)
    anchor = new DOMRect(c.left, c.top, 0, c.bottom - c.top)
  }
  onMeta({ kind, pos, anchor })
  return true
}

export const TaskItemWithMeta = TaskItem.extend<TaskItemMetaOptions>({
  addOptions() {
    return { ...(this.parent?.() as TaskItemOptions), onMeta: null, member: null }
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      due: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => cleanDue(element.getAttribute('data-due')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const due = cleanDue(attrs.due)
          return due ? { 'data-due': due } : {}
        },
      },
      assignee: {
        default: null,
        keepOnSplit: false,
        parseHTML: (element: HTMLElement) => cleanAssignee(element.getAttribute('data-assignee')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const assignee = cleanAssignee(attrs.assignee)
          return assignee ? { 'data-assignee': assignee } : {}
        },
      },
    }
  },

  renderHTML({ node, HTMLAttributes }) {
    const item: DOMOutputSpec[] = [
      ['label', ['input', { type: 'checkbox', checked: node.attrs.checked ? 'checked' : null }], ['span']],
      ['div', 0],
    ]
    const meta = taskMetaSpec(node)
    if (meta) item.push(meta)
    return ['li', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-type': this.name }), ...item]
  },

  addKeyboardShortcuts() {
    return {
      ...this.parent?.(),
      'Mod-Shift-d': () => openAtCaret(this.editor, 'due', this.options.onMeta),
      'Mod-Shift-a': () => openAtCaret(this.editor, 'assign', this.options.onMeta),
    }
  },

  addNodeView() {
    const options = this.options
    if (!options.onMeta) return this.parent?.() ?? null
    return ({ node, view, editor, getPos }) => createTaskView(editor, view, options, node, getPos as () => number | undefined)
  },

  addProseMirrorPlugins() {
    const parent = this.parent?.() ?? []
    if (!this.options.onMeta) return parent
    return [
      ...parent,
      new Plugin({
        key: caretRowKey,
        props: { decorations: caretRow },
      }),
    ]
  },
})
