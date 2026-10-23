import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import type { BoardContextValue } from '../../board/BoardContext'
import { CardIndex } from '../../board/cardIndex'
import { createCard, getCardMap, getCards, LOCAL_ORIGIN, updateCard } from '../../model/board'
import { getStaticSchema } from '../../editor/extensions'
import { listTasks } from '../../editor/tasks'
import { runToastAction, useToasts } from '../../ui/toast'
import { flattenActions } from '../cardActions'
import { convertCard, deleteCompletedTasks, textCardActions, undoStep } from './actions'

function context(readOnly = false) {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager(getCards(doc), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
  const ctx: BoardContextValue = {
    boardId: 'b1',
    doc,
    cards: getCards(doc),
    index: new CardIndex(doc),
    awareness: new Awareness(doc),
    undo,
    readOnly,
    isHome: false,
  }
  return ctx
}

function addTodo(ctx: BoardContextValue, checked: boolean[]): string {
  const id = createCard(ctx.doc, 'todo', { title: 'List' }, 'me')
  const frag = getCardMap(ctx.doc, id)!.get('content') as Y.XmlFragment
  prosemirrorJSONToYXmlFragment(
    getStaticSchema(),
    {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: checked.map((c, i) => ({ type: 'taskItem', attrs: { checked: c }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `t${i}` }] }] })),
        },
      ],
    },
    frag,
  )
  ctx.undo.clear()
  return id
}

const actionsFor = (ctx: BoardContextValue, id: string) => textCardActions(ctx, [ctx.index.get(id)!])

afterEach(() => useToasts.setState({ toasts: [] }))

describe('text card actions', () => {
  it('offers completed-task actions for one to-do', () => {
    const ctx = context()
    const id = addTodo(ctx, [false, true])
    const actions = actionsFor(ctx, id)
    const hide = actions.find((a) => a.id === 'todo.hideDone')!
    expect(hide).toMatchObject({ label: 'Hide completed', group: 'edit', pressed: false })
    expect(actions.find((a) => a.id === 'todo.deleteDone')).toMatchObject({ disabled: false, group: 'edit' })
    hide.run!(null)
    expect(getCardMap(ctx.doc, id)!.get('hideDone')).toBe(true)
    expect(actionsFor(ctx, id).find((a) => a.id === 'todo.hideDone')!.pressed).toBe(true)
  })

  it('disables Delete completed when nothing is checked', () => {
    const ctx = context()
    const id = addTodo(ctx, [false, false])
    expect(actionsFor(ctx, id).find((a) => a.id === 'todo.deleteDone')!.disabled).toBe(true)
  })

  it('deletes completed tasks in one step and offers Undo in the toast', () => {
    const ctx = context()
    const id = addTodo(ctx, [true, false, true])
    const frag = getCardMap(ctx.doc, id)!.get('content') as Y.XmlFragment
    actionsFor(ctx, id).find((a) => a.id === 'todo.deleteDone')!.run!(null)
    expect(listTasks(frag).map((t) => t.text)).toEqual(['t1'])
    const t = useToasts.getState().toasts.at(-1)!
    expect(t.message).toBe('Deleted 2 completed tasks')
    expect(t.action?.label).toBe('Undo')
    runToastAction(t.id)
    expect(listTasks(frag).map((x) => x.text)).toEqual(['t0', 't1', 't2'])
  })

  it('brings back exactly the deleted tasks from the toast after other changes, keeping them', () => {
    const ctx = context()
    const id = addTodo(ctx, [true, false, true])
    const other = createCard(ctx.doc, 'note', {}, 'me')
    ctx.undo.clear()
    const frag = getCardMap(ctx.doc, id)!.get('content') as Y.XmlFragment
    deleteCompletedTasks(ctx, id)
    const t = useToasts.getState().toasts.at(-1)!
    // While the toast is up: a title is typed, a card is moved.
    updateCard(ctx.doc, id, { title: 'Renamed' }, 'me')
    ctx.undo.stopCapturing()
    updateCard(ctx.doc, other, { x: 500 }, 'me')
    ctx.undo.stopCapturing()
    expect(ctx.undo.undoStack).toHaveLength(3)
    runToastAction(t.id)
    expect(listTasks(frag).map((x) => x.text)).toEqual(['t0', 't1', 't2'])
    expect(getCardMap(ctx.doc, id)!.get('title')).toBe('Renamed')
    expect(getCardMap(ctx.doc, other)!.get('x')).toBe(500)
    // The two later steps are still there, in order, and still undo what they did.
    expect(ctx.undo.undoStack).toHaveLength(2)
    expect(ctx.undo.canRedo()).toBe(true)
    ctx.undo.undo()
    expect(getCardMap(ctx.doc, other)!.get('x')).not.toBe(500)
    expect(getCardMap(ctx.doc, id)!.get('title')).toBe('Renamed')
    ctx.undo.undo()
    expect(getCardMap(ctx.doc, id)!.get('title')).toBe('List')
    expect(listTasks(frag).map((x) => x.text)).toEqual(['t0', 't1', 't2'])
  })

  it('says so when the deletion was already undone', () => {
    const ctx = context()
    const id = addTodo(ctx, [true, false])
    const frag = getCardMap(ctx.doc, id)!.get('content') as Y.XmlFragment
    deleteCompletedTasks(ctx, id)
    const t = useToasts.getState().toasts.at(-1)!
    ctx.undo.undo()
    expect(listTasks(frag).map((x) => x.text)).toEqual(['t0', 't1'])
    runToastAction(t.id)
    expect(listTasks(frag).map((x) => x.text)).toEqual(['t0', 't1'])
    expect(useToasts.getState().toasts.at(-1)!.message).toBe('That can no longer be undone from here.')
  })

  it('undoes one step in the middle of the history without touching the others', () => {
    const ctx = context()
    const a = createCard(ctx.doc, 'note', {}, 'me')
    ctx.undo.clear()
    const step = (x: number) => {
      updateCard(ctx.doc, a, { x }, 'me')
      ctx.undo.stopCapturing()
      return ctx.undo.undoStack.at(-1)!
    }
    step(10)
    const middle = step(20)
    step(30)
    const b = createCard(ctx.doc, 'note', { y: 7 }, 'me')
    ctx.undo.stopCapturing()
    expect(undoStep(ctx.undo, middle)).toBe(true)
    // Whatever Yjs makes of a value overwritten since, no other step is undone in its place (an
    // empty step makes UndoManager.undo() go on to the next one): b is still there.
    expect(ctx.undo.undoStack).toHaveLength(3)
    expect(getCards(ctx.doc).has(b)).toBe(true)
    expect(undoStep(ctx.undo, middle)).toBe(false)
  })

  it('offers Convert to with the other two text types', () => {
    const ctx = context()
    const note = createCard(ctx.doc, 'note', {}, 'me')
    const convert = actionsFor(ctx, note).find((a) => a.id === 'text.convert')!
    expect(convert.group).toBe('convert')
    expect(convert.children!.map((c) => c.label)).toEqual(['To-do', 'Document'])
    flattenActions([convert]).find((a) => a.id === 'text.convert.todo')!.run!(null)
    expect(getCardMap(ctx.doc, note)!.get('type')).toBe('todo')
  })

  it('offers nothing on read-only boards, for several cards or other types', () => {
    const ro = context(true)
    const id = addTodo(ro, [true])
    expect(actionsFor(ro, id)).toEqual([])
    const ctx = context()
    const a = createCard(ctx.doc, 'note', {}, 'me')
    const b = createCard(ctx.doc, 'note', {}, 'me')
    expect(textCardActions(ctx, [ctx.index.get(a)!, ctx.index.get(b)!])).toEqual([])
    const img = createCard(ctx.doc, 'image', {}, 'me')
    expect(actionsFor(ctx, img)).toEqual([])
  })

  it('explains a refused conversion of content from a newer version', () => {
    const ctx = context()
    const note = createCard(ctx.doc, 'note', {}, 'me')
    const frag = getCardMap(ctx.doc, note)!.get('content') as Y.XmlFragment
    frag.insert(0, [new Y.XmlElement('futureBlock')])
    expect(convertCard(ctx, note, 'document')).toBe(false)
    expect(useToasts.getState().toasts.at(-1)!.message).toMatch(/newer version of .+ and can’t be converted/)
    expect(getCardMap(ctx.doc, note)!.get('type')).toBe('note')
  })
})
