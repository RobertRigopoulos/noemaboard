import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN, SYSTEM_ORIGIN } from '../model/board'
import {
  countHiddenDone,
  countOverdue,
  deleteCheckedTasks,
  findTaskItem,
  hasCheckedTasks,
  listTasks,
  readHideDone,
  setTaskAttr,
  setTaskElementAttr,
  taskIndexOf,
  taskStats,
  textHash,
  toggleTaskItem,
} from './tasks'

function taskItem(text: string, checked: boolean, nested?: Y.XmlElement): Y.XmlElement {
  const item = new Y.XmlElement('taskItem')
  item.setAttribute('checked', checked as unknown as string)
  const para = new Y.XmlElement('paragraph')
  para.insert(0, [new Y.XmlText(text)])
  item.insert(0, nested ? [para, nested] : [para])
  return item
}

function taskList(...items: Y.XmlElement[]): Y.XmlElement {
  const list = new Y.XmlElement('taskList')
  list.insert(0, items)
  return list
}

/** a, b (with nested c, d), then a paragraph, then e — pre-order: a b c d e */
function setup() {
  const doc = new Y.Doc()
  const card = new Y.Map<unknown>()
  doc.getMap('cards').set('t1', card)
  const frag = new Y.XmlFragment()
  card.set('content', frag)
  const para = new Y.XmlElement('paragraph')
  para.insert(0, [new Y.XmlText('between')])
  frag.insert(0, [
    taskList(taskItem('a', false), taskItem('b', true, taskList(taskItem('c', false), taskItem('d', true)))),
    para,
    taskList(taskItem('e', false)),
  ])
  return { doc, frag }
}

const textOf = (item: Y.XmlElement | null) => (item ? (item.get(0) as Y.XmlElement).toArray().map(String).join('') : null)

describe('task helpers', () => {
  it('finds task items in document (pre-order) order, including nested ones', () => {
    const { frag } = setup()
    expect(['a', 'b', 'c', 'd', 'e'].map((_, i) => textOf(findTaskItem(frag, i)))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(findTaskItem(frag, 5)).toBeNull()
    expect(findTaskItem(frag, -1)).toBeNull()
    expect(findTaskItem(frag, 1.5)).toBeNull()
  })

  it('counts total and done, ignoring blank items', () => {
    const { frag } = setup()
    expect(taskStats(frag)).toEqual({ total: 5, done: 2 })
    const blank = new Y.XmlElement('taskItem')
    blank.setAttribute('checked', true as unknown as string)
    blank.insert(0, [new Y.XmlElement('paragraph')])
    ;(frag.get(2) as Y.XmlElement).insert(1, [blank])
    expect(taskStats(frag)).toEqual({ total: 5, done: 2 })
    expect(findTaskItem(frag, 5)).toBe(blank)
  })

  it('toggles the Nth item in one LOCAL_ORIGIN transaction', () => {
    const { doc, frag } = setup()
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    expect(toggleTaskItem(frag, 2)).toBe(true)
    expect(findTaskItem(frag, 2)!.getAttribute('checked') as unknown).toBe(true)
    expect(toggleTaskItem(frag, 1)).toBe(false)
    expect(taskStats(frag)).toEqual({ total: 5, done: 2 })
    expect(origins).toEqual([LOCAL_ORIGIN, LOCAL_ORIGIN])
  })

  it('supports explicit state and origin, and ignores missing items', () => {
    const { doc, frag } = setup()
    let origin: unknown = null
    doc.on('afterTransaction', (tr: Y.Transaction) => (origin = tr.origin))
    expect(toggleTaskItem(frag, 4, { checked: true, origin: SYSTEM_ORIGIN })).toBe(true)
    expect(origin).toBe(SYSTEM_ORIGIN)
    expect(toggleTaskItem(frag, 99)).toBeNull()
  })

  it('treats non-boolean checked values from peers as unchecked', () => {
    const { frag } = setup()
    findTaskItem(frag, 0)!.setAttribute('checked', 'true')
    expect(taskStats(frag).done).toBe(2)
    expect(toggleTaskItem(frag, 0)).toBe(true)
  })

  it('is undoable by an UndoManager tracking LOCAL_ORIGIN', () => {
    const { doc, frag } = setup()
    const undo = new Y.UndoManager(doc.getMap('cards'), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    toggleTaskItem(frag, 0)
    expect(taskStats(frag).done).toBe(3)
    undo.undo()
    expect(taskStats(frag).done).toBe(2)
  })
})

describe('setTaskAttr', () => {
  it('writes due and assignee in one LOCAL_ORIGIN transaction', () => {
    const { doc, frag } = setup()
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    expect(setTaskAttr(frag, 2, { due: '2026-10-22T09:30', assignee: 'user_1' })).toBe(true)
    expect(origins).toEqual([LOCAL_ORIGIN])
    const item = findTaskItem(frag, 2)!
    expect(item.getAttribute('due')).toBe('2026-10-22T09:30')
    expect(item.getAttribute('assignee')).toBe('user_1')
  })

  it('is one undo step', () => {
    const { doc, frag } = setup()
    const undo = new Y.UndoManager(doc.getMap('cards'), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    setTaskAttr(frag, 0, { due: '2026-10-22', assignee: 'u1' })
    undo.undo()
    expect(findTaskItem(frag, 0)!.getAttribute('due')).toBeUndefined()
    expect(findTaskItem(frag, 0)!.getAttribute('assignee')).toBeUndefined()
  })

  it('removes attributes for null and writes nothing when nothing changes', () => {
    const { doc, frag } = setup()
    setTaskAttr(frag, 1, { due: '2026-01-02' })
    let count = 0
    doc.on('afterTransaction', () => count++)
    expect(setTaskAttr(frag, 1, { due: '2026-01-02' })).toBe(false)
    expect(count).toBe(0)
    expect(setTaskAttr(frag, 1, { due: null })).toBe(true)
    expect(findTaskItem(frag, 1)!.getAttribute('due')).toBeUndefined()
  })

  it('rejects hostile or impossible values without writing anything', () => {
    const { doc, frag } = setup()
    let count = 0
    doc.on('afterTransaction', () => count++)
    expect(setTaskAttr(frag, 0, { due: '2026-02-30' })).toBe(false)
    expect(setTaskAttr(frag, 0, { due: '2026-10-22', assignee: 'x" onclick="evil' })).toBe(false)
    expect(setTaskAttr(frag, 0, { due: '"><img src=x onerror=alert(1)>' })).toBe(false)
    expect(setTaskAttr(frag, 99, { due: '2026-10-22' })).toBe(false)
    expect(count).toBe(0)
    expect(findTaskItem(frag, 0)!.getAttribute('due')).toBeUndefined()
  })
})

describe('following one task while others change', () => {
  it('finds the current index of a task element as tasks come and go above it', () => {
    const { doc, frag } = setup()
    const e = findTaskItem(frag, 4)!
    expect(taskIndexOf(frag, e)).toBe(4)
    // A teammate adds a task at the top.
    doc.transact(() => (frag.get(0) as Y.XmlElement).insert(0, [taskItem('new', false)]))
    expect(taskIndexOf(frag, e)).toBe(5)
    expect(textOf(findTaskItem(frag, 5))).toBe('e')
    // ... and deletes b with its nested c and d.
    doc.transact(() => (frag.get(0) as Y.XmlElement).delete(2, 1))
    expect(taskIndexOf(frag, e)).toBe(2)
  })

  it('reports -1 for a deleted task, also one inside a deleted parent', () => {
    const { doc, frag } = setup()
    const c = findTaskItem(frag, 2)!
    const e = findTaskItem(frag, 4)!
    doc.transact(() => frag.delete(2, 1))
    expect(taskIndexOf(frag, e)).toBe(-1)
    // b goes, and c with it.
    doc.transact(() => (frag.get(0) as Y.XmlElement).delete(1, 1))
    expect(taskIndexOf(frag, c)).toBe(-1)
    const other = new Y.Doc().getXmlFragment('f')
    expect(taskIndexOf(other, findTaskItem(frag, 0)!)).toBe(-1)
  })

  it('writes to the element itself, wherever it has moved', () => {
    const { doc, frag } = setup()
    const e = findTaskItem(frag, 4)!
    doc.transact(() => (frag.get(0) as Y.XmlElement).insert(0, [taskItem('new', false)]))
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    expect(setTaskElementAttr(e, { due: '2026-10-22', assignee: 'u1' })).toBe(true)
    expect(origins).toEqual([LOCAL_ORIGIN])
    expect(listTasks(frag).find((t) => t.text === 'e')).toMatchObject({ due: '2026-10-22', assignee: 'u1' })
    // The task now at e's old index was not touched.
    expect(findTaskItem(frag, 4)!.getAttribute('due')).toBeUndefined()
  })

  it('validates like setTaskAttr and leaves deleted tasks alone', () => {
    const { doc, frag } = setup()
    const a = findTaskItem(frag, 0)!
    let count = 0
    doc.on('afterTransaction', () => count++)
    expect(setTaskElementAttr(a, { due: '2026-02-30' })).toBe(false)
    expect(setTaskElementAttr(a, { assignee: 'x" onclick="evil' })).toBe(false)
    expect(setTaskElementAttr(frag.get(1) as Y.XmlElement, { due: '2026-10-22' })).toBe(false)
    expect(count).toBe(0)
    doc.transact(() => frag.delete(0, 1))
    count = 0
    expect(setTaskElementAttr(a, { due: '2026-10-22' })).toBe(false)
    expect(count).toBe(0)
  })
})

describe('listTasks and countOverdue', () => {
  it('reads validated metadata and own-line text', () => {
    const { frag } = setup()
    findTaskItem(frag, 0)!.setAttribute('due', '2026-10-20')
    findTaskItem(frag, 1)!.setAttribute('due', 'not a date')
    findTaskItem(frag, 2)!.setAttribute('assignee', 'bad id!')
    findTaskItem(frag, 4)!.setAttribute('assignee', 'me')
    const tasks = listTasks(frag)
    expect(tasks.map((t) => t.text)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(tasks[0].due).toBe('2026-10-20')
    expect(tasks[1].due).toBeNull()
    expect(tasks[2].assignee).toBeNull()
    expect(tasks[4].assignee).toBe('me')
  })

  it('counts unchecked tasks due before today', () => {
    const { frag } = setup()
    findTaskItem(frag, 0)!.setAttribute('due', '2026-10-20') // unchecked, overdue
    findTaskItem(frag, 1)!.setAttribute('due', '2026-10-01') // checked: not overdue
    findTaskItem(frag, 2)!.setAttribute('due', '2026-10-22') // due today
    findTaskItem(frag, 4)!.setAttribute('due', '2026-10-21T23:00') // overdue
    expect(countOverdue(frag, '2026-10-22')).toBe(2)
    expect(countOverdue(frag, '2026-10-01')).toBe(0)
  })

  it('hashes text stably', () => {
    expect(textHash('Buy milk')).toBe(textHash('Buy milk'))
    expect(textHash('Buy milk')).not.toBe(textHash('Buy oat milk'))
  })
})

describe('completed tasks', () => {
  it('validates hideDone strictly', () => {
    expect(readHideDone(true)).toBe(true)
    expect(readHideDone('true')).toBe(false)
    expect(readHideDone(1)).toBe(false)
    expect(readHideDone(undefined)).toBe(false)
    expect(readHideDone({})).toBe(false)
  })

  it('counts what Hide completed hides: finished tasks without an open task inside', () => {
    const { frag } = setup()
    // b is checked but holds the open c, so b stays; d (checked, nothing open inside) hides.
    expect(countHiddenDone(frag)).toBe(1)
    toggleTaskItem(frag, 2, { checked: true })
    // Now b, c and d all hide.
    expect(countHiddenDone(frag)).toBe(3)
    toggleTaskItem(frag, 1, { checked: false })
    // b is open: c and d hide inside it.
    expect(countHiddenDone(frag)).toBe(2)
    // Blank checked items disappear too, so they count.
    const blank = new Y.XmlElement('taskItem')
    blank.setAttribute('checked', true as unknown as string)
    blank.insert(0, [new Y.XmlElement('paragraph')])
    ;(frag.get(2) as Y.XmlElement).insert(1, [blank])
    expect(countHiddenDone(frag)).toBe(3)
  })

  it('detects checked tasks', () => {
    const { frag } = setup()
    expect(hasCheckedTasks(frag)).toBe(true)
    toggleTaskItem(frag, 1, { checked: false })
    toggleTaskItem(frag, 3, { checked: false })
    expect(hasCheckedTasks(frag)).toBe(false)
  })

  it('deletes checked items with their nested items in one undoable transaction', () => {
    const { doc, frag } = setup()
    const undo = new Y.UndoManager(doc.getMap('cards'), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    // b (checked) holds c and d: all three go.
    expect(deleteCheckedTasks(frag)).toBe(3)
    expect(origins).toEqual([LOCAL_ORIGIN])
    expect(listTasks(frag).map((t) => t.text)).toEqual(['a', 'e'])
    undo.undo()
    expect(listTasks(frag).map((t) => t.text)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('removes an emptied nested list but keeps the unchecked parent', () => {
    const { frag } = setup()
    toggleTaskItem(frag, 1, { checked: false }) // b unchecked, nested c (unchecked), d (checked)
    toggleTaskItem(frag, 2, { checked: true }) // c checked too
    expect(deleteCheckedTasks(frag)).toBe(2)
    const b = findTaskItem(frag, 1)!
    expect(b.length).toBe(1) // only its paragraph, no empty nested list
    expect(listTasks(frag).map((t) => t.text)).toEqual(['a', 'b', 'e'])
  })

  it('keeps one empty unchecked item in a list left empty', () => {
    const doc = new Y.Doc()
    const card = new Y.Map<unknown>()
    doc.getMap('cards').set('t', card)
    const frag = new Y.XmlFragment()
    card.set('content', frag)
    frag.insert(0, [taskList(taskItem('x', true), taskItem('y', true))])
    expect(deleteCheckedTasks(frag)).toBe(2)
    const list = frag.get(0) as Y.XmlElement
    expect(list.nodeName).toBe('taskList')
    expect(list.length).toBe(1)
    const item = list.get(0) as Y.XmlElement
    expect(item.nodeName).toBe('taskItem')
    expect(item.getAttribute('checked') as unknown).toBe(false)
    expect((item.get(0) as Y.XmlElement).nodeName).toBe('paragraph')
    expect(taskStats(frag)).toEqual({ total: 0, done: 0 })
  })

  it('returns 0 and writes nothing visible when nothing is checked', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('f')
    frag.insert(0, [taskList(taskItem('x', false))])
    expect(deleteCheckedTasks(frag)).toBe(0)
    expect(listTasks(frag).map((t) => t.text)).toEqual(['x'])
  })
})
