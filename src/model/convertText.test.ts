import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { getStaticSchema } from '../editor/extensions'
import { createCard, deleteCards, getCardMap, getCards, insertIntoColumn, LOCAL_ORIGIN, readCard } from './board'
import { convertTextCard } from './convertText'
import type { CardType } from './types'

const U = 'user1'
const board = () => new Y.Doc({ guid: 'b1' })

const t = (text: string) => ({ type: 'text', text })
const p = (text?: string) => (text ? { type: 'paragraph', content: [t(text)] } : { type: 'paragraph' })
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [t(text)] })
const li = (...content: unknown[]) => ({ type: 'listItem', content })
const task = (checked: boolean, text: string) => ({ type: 'taskItem', attrs: { checked }, content: [p(text)] })

function textCard(doc: Y.Doc, type: CardType, content: unknown[], fields: Record<string, unknown> = {}): string {
  const id = createCard(doc, type, fields, U)
  const frag = getCardMap(doc, id)!.get('content') as Y.XmlFragment
  if (content.length) doc.transact(() => prosemirrorJSONToYXmlFragment(getStaticSchema(), { type: 'doc', content }, frag))
  return id
}

const fragOf = (doc: Y.Doc, id: string) => getCardMap(doc, id)!.get('content') as Y.XmlFragment
const rootOf = (doc: Y.Doc, id: string) => yXmlFragmentToProseMirrorRootNode(fragOf(doc, id), getStaticSchema())
const blocks = (doc: Y.Doc, id: string) => {
  const out: string[] = []
  rootOf(doc, id).forEach((n) => out.push(`${n.type.name}${n.type.name === 'heading' ? n.attrs.level : ''}:${n.textContent}`))
  return out
}
function tasks(node: PMNode): [string, boolean][] {
  const out: [string, boolean][] = []
  node.descendants((n) => {
    if (n.type.name === 'taskItem') out.push([n.firstChild?.textContent ?? '', n.attrs.checked === true])
  })
  return out
}
const card = (doc: Y.Doc, id: string) => readCard(getCardMap(doc, id)!) as ReturnType<typeof readCard> & { title?: string }

describe('convertTextCard', () => {
  it('turns a note into one task list', () => {
    const doc = board()
    const id = textCard(doc, 'note', [
      h(1, 'Groceries'),
      p('milk'),
      p(),
      { type: 'bulletList', content: [li(p('eggs'), { type: 'bulletList', content: [li(p('free range'))] }), li(p('bread'))] },
      { type: 'orderedList', content: [li(p('first'))] },
      { type: 'taskList', content: [task(true, 'done already')] },
      { type: 'blockquote', content: [p('quoted')] },
      { type: 'codeBlock', content: [t('line1\n\nline2')] },
      { type: 'horizontalRule' },
    ])
    expect(convertTextCard(doc, id, 'todo', U)).toBe(true)
    const root = rootOf(doc, id)
    expect(root.childCount).toBe(1)
    expect(root.firstChild!.type.name).toBe('taskList')
    expect(tasks(root)).toEqual([
      ['Groceries', false],
      ['milk', false],
      ['eggs', false],
      ['free range', false],
      ['bread', false],
      ['first', false],
      ['done already', true],
      ['quoted', false],
      ['line1', false],
      ['line2', false],
    ])
    expect(card(doc, id)).toMatchObject({ type: 'todo', title: '', w: 300 })
  })

  it('gives an empty note one empty task', () => {
    const doc = board()
    const id = textCard(doc, 'note', [])
    expect(convertTextCard(doc, id, 'todo', U)).toBe(true)
    expect(tasks(rootOf(doc, id))).toEqual([['', false]])
  })

  it('turns a to-do into a note with its title as a heading', () => {
    const doc = board()
    const id = textCard(doc, 'todo', [{ type: 'taskList', content: [task(false, 'pack'), task(true, 'book')] }], { title: 'Weekend' })
    expect(convertTextCard(doc, id, 'note', U)).toBe(true)
    expect(getCardMap(doc, id)!.has('title')).toBe(false)
    expect(blocks(doc, id)).toEqual(['heading2:Weekend', 'taskList:packbook'])
    expect(tasks(rootOf(doc, id))).toEqual([
      ['pack', false],
      ['book', true],
    ])
    expect(card(doc, id)).toMatchObject({ type: 'note', w: 300 })
  })

  it('takes a document title from a leading heading, or else the first line', () => {
    const doc = board()
    const a = textCard(doc, 'note', [h(2, 'My essay'), p('Body')])
    expect(convertTextCard(doc, a, 'document', U)).toBe(true)
    expect(card(doc, a)).toMatchObject({ type: 'document', title: 'My essay', w: 200 })
    expect(blocks(doc, a)).toEqual(['paragraph:Body'])

    const long = 'A'.repeat(150)
    const b = textCard(doc, 'note', [p(), { type: 'paragraph', content: [t(long), { type: 'hardBreak' }, t('second')] }, p('more')])
    expect(convertTextCard(doc, b, 'document', U)).toBe(true)
    expect(card(doc, b).title).toBe('A'.repeat(120))
    expect(blocks(doc, b)).toEqual(['paragraph:', `paragraph:${long}second`, 'paragraph:more'])

    const c = textCard(doc, 'note', [])
    expect(convertTextCard(doc, c, 'document', U)).toBe(true)
    expect(card(doc, c).title).toBe('Untitled document')
  })

  it('turns a document into a note with its title as a heading', () => {
    const doc = board()
    const a = textCard(doc, 'document', [p('Body')], { title: 'Plan' })
    expect(convertTextCard(doc, a, 'note', U)).toBe(true)
    expect(blocks(doc, a)).toEqual(['heading2:Plan', 'paragraph:Body'])
    expect(card(doc, a)).toMatchObject({ type: 'note', w: 300 })
    expect(getCardMap(doc, a)!.has('title')).toBe(false)

    // the placeholder title is not content; a custom width stays
    const b = textCard(doc, 'document', [p('Body')], { w: 260 })
    expect(convertTextCard(doc, b, 'note', U)).toBe(true)
    expect(blocks(doc, b)).toEqual(['paragraph:Body'])
    expect(card(doc, b).w).toBe(260)
  })

  it('moves the title between to-do and document', () => {
    const doc = board()
    const id = textCard(doc, 'todo', [{ type: 'taskList', content: [task(false, 'flights')] }], { title: 'Trip' })
    const frag = fragOf(doc, id)
    let edits = 0
    frag.observeDeep(() => edits++)
    expect(convertTextCard(doc, id, 'document', U)).toBe(true)
    expect(card(doc, id)).toMatchObject({ type: 'document', title: 'Trip', w: 200 })
    expect(edits).toBe(0)
    expect(convertTextCard(doc, id, 'todo', U)).toBe(true)
    expect(card(doc, id)).toMatchObject({ type: 'todo', title: 'Trip', w: 300 })
    expect(tasks(rootOf(doc, id))).toEqual([['flights', false]])

    const d = textCard(doc, 'document', [h(1, 'Steps'), p('one'), p('two')])
    expect(convertTextCard(doc, d, 'todo', U)).toBe(true)
    expect(card(doc, d).title).toBe('')
    expect(tasks(rootOf(doc, d)).map((x) => x[0])).toEqual(['Steps', 'one', 'two'])
  })

  it('keeps a column child in its column at its width', () => {
    const doc = board()
    const col = createCard(doc, 'column', {}, U)
    const a = textCard(doc, 'note', [p('a')])
    const b = textCard(doc, 'note', [h(1, 'Title'), p('b')])
    insertIntoColumn(doc, [a, b], col, 0, U)
    const before = card(doc, b)
    expect(convertTextCard(doc, b, 'document', U)).toBe(true)
    expect(card(doc, b)).toMatchObject({ type: 'document', parent: col, order: before.order, w: before.w, x: before.x, y: before.y, z: before.z })
  })

  it('is undone in one step, restoring type, title, width and content', () => {
    const doc = board()
    const id = textCard(doc, 'note', [h(1, 'Title'), p('body')], { color: 'yellow' })
    const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
    const before = rootOf(doc, id).toJSON()
    expect(convertTextCard(doc, id, 'document', U)).toBe(true)
    expect(undo.undoStack).toHaveLength(1)
    undo.undo()
    expect(card(doc, id)).toMatchObject({ type: 'note', w: 300, color: 'yellow' })
    expect(getCardMap(doc, id)!.has('title')).toBe(false)
    expect(rootOf(doc, id).toJSON()).toEqual(before)
    undo.redo()
    expect(card(doc, id)).toMatchObject({ type: 'document', title: 'Title', w: 200 })
  })

  it('keeps widths at or above the new type minimum, and converts other widths consistently', () => {
    const doc = board()
    const narrow = textCard(doc, 'note', [p('a')], { w: 130 })
    expect(convertTextCard(doc, narrow, 'todo', U)).toBe(true)
    expect(card(doc, narrow).w).toBe(160)
    // Documents cannot be resized: a wide one only comes from peers, and keeps its width either way.
    const wide = textCard(doc, 'document', [p('b')], { w: 500 })
    expect(convertTextCard(doc, wide, 'todo', U)).toBe(true)
    expect(card(doc, wide).w).toBe(500)
    const wide2 = textCard(doc, 'document', [p('b')], { w: 500 })
    expect(convertTextCard(doc, wide2, 'note', U)).toBe(true)
    expect(card(doc, wide2).w).toBe(500)
    const big = textCard(doc, 'note', [p('c')], { w: 520 })
    expect(convertTextCard(doc, big, 'document', U)).toBe(true)
    expect(card(doc, big).w).toBe(200)
  })

  it('leaves locked cards alone', () => {
    const doc = board()
    const locked = textCard(doc, 'note', [p('keep')], { locked: true })
    expect(convertTextCard(doc, locked, 'todo', U)).toBe(false)
    expect(card(doc, locked).type).toBe('note')
    expect(blocks(doc, locked)).toEqual(['paragraph:keep'])
  })

  it('refuses content from a newer version, trashed cards and other types', () => {
    const doc = board()
    const newer = textCard(doc, 'note', [p('hi')])
    doc.transact(() => fragOf(doc, newer).insert(1, [new Y.XmlElement('fancyBlock')]))
    expect(convertTextCard(doc, newer, 'todo', U)).toBe(false)
    expect(card(doc, newer).type).toBe('note')

    const attr = textCard(doc, 'note', [p('hi')])
    doc.transact(() => (fragOf(doc, attr).get(0) as Y.XmlElement).setAttribute('indent', '2'))
    expect(convertTextCard(doc, attr, 'document', U)).toBe(false)

    const gone = textCard(doc, 'note', [p('bye')])
    deleteCards(doc, [gone], U)
    expect(convertTextCard(doc, gone, 'todo', U)).toBe(false)

    const image = createCard(doc, 'image', {}, U)
    expect(convertTextCard(doc, image, 'note', U)).toBe(false)
    const same = textCard(doc, 'note', [p('x')])
    expect(convertTextCard(doc, same, 'note', U)).toBe(false)
    expect(convertTextCard(doc, 'missing', 'note', U)).toBe(false)
    expect(convertTextCard(doc, same, 'image' as 'note', U)).toBe(false)
  })
})
