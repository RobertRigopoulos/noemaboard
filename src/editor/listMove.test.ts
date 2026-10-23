import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import { getStaticSchema } from './extensions'
import { moveListItem } from './listMove'

const schema = getStaticSchema()
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
const li = (text: string, nested?: unknown) => ({ type: 'listItem', content: nested ? [p(text), nested] : [p(text)] })
const task = (text: string, checked = false) => ({ type: 'taskItem', attrs: { checked }, content: [p(text)] })

function stateWithCaretIn(json: unknown, text: string, offset = 1): EditorState {
  const doc = schema.nodeFromJSON(json)
  let pos = -1
  doc.descendants((node, at) => {
    if (pos < 0 && node.isText && node.text === text) pos = at + offset
  })
  if (pos < 0) throw new Error(`no text ${text}`)
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos) })
}

function run(state: EditorState, dir: 'up' | 'down'): { ok: boolean; state: EditorState; steps: number } {
  let next = state
  let steps = 0
  const ok = moveListItem(dir)(state, (tr: Transaction) => {
    steps++
    next = state.apply(tr)
  })
  return { ok, state: next, steps }
}

const texts = (doc: PMNode) => {
  const out: string[] = []
  doc.descendants((n) => {
    if (n.isText) out.push(n.text!)
  })
  return out
}

const caretText = (state: EditorState) => state.selection.$from.parent.textContent

describe('moveListItem', () => {
  const bullets = { type: 'doc', content: [{ type: 'bulletList', content: [li('one'), li('two'), li('three')] }] }

  it('swaps an item with its previous sibling and keeps the caret on it', () => {
    const before = stateWithCaretIn(bullets, 'two', 2)
    const { ok, state, steps } = run(before, 'up')
    expect(ok).toBe(true)
    expect(steps).toBe(1)
    expect(texts(state.doc)).toEqual(['two', 'one', 'three'])
    expect(caretText(state)).toBe('two')
    expect(state.selection.$from.parentOffset).toBe(2)
  })

  it('swaps with the next sibling', () => {
    const { ok, state } = run(stateWithCaretIn(bullets, 'one'), 'down')
    expect(ok).toBe(true)
    expect(texts(state.doc)).toEqual(['two', 'one', 'three'])
    expect(caretText(state)).toBe('one')
  })

  it('does nothing at the edges so the key falls through', () => {
    const first = stateWithCaretIn(bullets, 'one')
    expect(run(first, 'up')).toMatchObject({ ok: false, steps: 0 })
    const last = stateWithCaretIn(bullets, 'three')
    expect(run(last, 'down')).toMatchObject({ ok: false, steps: 0 })
  })

  it('does nothing outside lists', () => {
    const doc = { type: 'doc', content: [p('plain')] }
    expect(run(stateWithCaretIn(doc, 'plain'), 'up').ok).toBe(false)
  })

  it('moves task items with their checked state', () => {
    const doc = { type: 'doc', content: [{ type: 'taskList', content: [task('a', true), task('b')] }] }
    const { state } = run(stateWithCaretIn(doc, 'a'), 'down')
    expect(texts(state.doc)).toEqual(['b', 'a'])
    expect(state.doc.firstChild!.child(1).attrs.checked).toBe(true)
  })

  it('moves the innermost item among its own siblings, nested items travel along', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'bulletList', content: [li('x', { type: 'bulletList', content: [li('x1'), li('x2')] }), li('y')] }],
    }
    const nested = run(stateWithCaretIn(doc, 'x2'), 'up')
    expect(texts(nested.state.doc)).toEqual(['x', 'x2', 'x1', 'y'])
    const parent = run(stateWithCaretIn(doc, 'x'), 'down')
    expect(texts(parent.state.doc)).toEqual(['y', 'x', 'x1', 'x2'])
  })

  it('refuses a selection that reaches past the item', () => {
    const state = stateWithCaretIn(bullets, 'one')
    const doc = state.doc
    let end = 0
    doc.descendants((n, at) => {
      if (n.isText && n.text === 'two') end = at + 2
    })
    const wide = state.apply(state.tr.setSelection(TextSelection.create(doc, state.selection.from, end)))
    expect(run(wide, 'down').ok).toBe(false)
  })
})
