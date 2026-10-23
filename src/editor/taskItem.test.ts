import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { getStaticSchema } from './extensions'
import { taskIndexAtPos, taskPosAtIndex } from './taskItem'
import { findTaskItem, listTasks, taskIndexOf } from './tasks'

const task = (text: string, nested?: unknown) => ({
  type: 'taskItem',
  attrs: { checked: false },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }, ...(nested ? [nested] : [])],
})

/** a, b (with nested c, d), a paragraph, then e — pre-order: a b c d e */
function setup() {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('content')
  prosemirrorJSONToYXmlFragment(
    getStaticSchema(),
    {
      type: 'doc',
      content: [
        { type: 'taskList', content: [task('a'), task('b', { type: 'taskList', content: [task('c'), task('d')] })] },
        { type: 'paragraph', content: [{ type: 'text', text: 'between' }] },
        { type: 'taskList', content: [task('e')] },
      ],
    },
    frag,
  )
  return { doc, frag, pm: () => yXmlFragmentToProseMirrorRootNode(frag, getStaticSchema()) }
}

describe('task positions in the editor document', () => {
  it('numbers tasks in the same order as the shared text', () => {
    const { frag, pm } = setup()
    const doc = pm()
    const texts = listTasks(frag).map((t) => t.text)
    expect(texts).toEqual(['a', 'b', 'c', 'd', 'e'])
    texts.forEach((text, i) => {
      const pos = taskPosAtIndex(doc, i)!
      const node = doc.nodeAt(pos)!
      expect(node.type.name).toBe('taskItem')
      expect(node.firstChild!.textContent).toBe(text)
      expect(taskIndexAtPos(doc, pos)).toBe(i)
      expect(taskIndexOf(frag, findTaskItem(frag, i)!)).toBe(i)
    })
    expect(taskPosAtIndex(doc, 5)).toBeNull()
    expect(taskPosAtIndex(doc, -1)).toBeNull()
  })

  it('finds no task where none starts', () => {
    const { pm } = setup()
    const doc = pm()
    expect(taskIndexAtPos(doc, 0)).toBe(-1)
    expect(taskIndexAtPos(doc, taskPosAtIndex(doc, 0)! + 1)).toBe(-1)
    expect(taskIndexAtPos(doc, doc.content.size)).toBe(-1)
    expect(taskIndexAtPos(doc, 1.5)).toBe(-1)
  })

  it('keeps pointing at the same task after a task is added above it', () => {
    const { doc, frag, pm } = setup()
    const e = findTaskItem(frag, taskIndexAtPos(pm(), taskPosAtIndex(pm(), 4)!))!
    doc.transact(() => {
      const item = new Y.XmlElement('taskItem')
      const para = new Y.XmlElement('paragraph')
      para.insert(0, [new Y.XmlText('new')])
      item.insert(0, [para])
      ;(frag.get(0) as Y.XmlElement).insert(0, [item])
    })
    const after = pm()
    const pos = taskPosAtIndex(after, taskIndexOf(frag, e))!
    expect(after.nodeAt(pos)!.firstChild!.textContent).toBe('e')
  })
})
