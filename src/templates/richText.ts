/**
 * Builders for rich-text card content.
 *
 * They write exactly the Yjs structure TipTap's y-tiptap binding writes for the same ProseMirror
 * content (element name = node type, every non-null node attribute set, marks as text attributes),
 * so a live editor opened on template content finds nothing to rewrite.
 */
import * as Y from 'yjs'

type Attrs = { [key: string]: string | number | boolean }

export type Block = Y.XmlElement

/** A run of text, optionally bold or italic. */
export type Inline = string | { text: string; bold?: boolean; italic?: boolean }

export interface Task {
  text: Inline | Inline[]
  done?: boolean
}

function runs(content: Inline | Inline[]): Inline[] {
  return Array.isArray(content) ? content : [content]
}

function textNode(content: Inline[]): Y.XmlText | null {
  const delta = content
    .map((r) => {
      if (typeof r === 'string') return { insert: r }
      const attributes: Record<string, object> = {}
      if (r.bold) attributes.bold = {}
      if (r.italic) attributes.italic = {}
      return Object.keys(attributes).length ? { insert: r.text, attributes } : { insert: r.text }
    })
    .filter((op) => op.insert.length > 0)
  if (!delta.length) return null
  const t = new Y.XmlText()
  t.applyDelta(delta)
  return t
}

function element(name: string, attrs: Attrs, children: (Block | Y.XmlText | null)[]): Block {
  const el = new Y.XmlElement(name)
  // Attributes keep their ProseMirror types (heading level is a number, checked a boolean).
  const typed = el as unknown as Y.XmlElement<Attrs>
  for (const [k, v] of Object.entries(attrs)) typed.setAttribute(k, v)
  const kids = children.filter((c): c is Block | Y.XmlText => c !== null)
  if (kids.length) el.insert(0, kids)
  return el
}

export function paragraph(...content: Inline[]): Block {
  return element('paragraph', {}, [textNode(content)])
}

export function heading(level: 1 | 2 | 3, ...content: Inline[]): Block {
  return element('heading', { level }, [textNode(content)])
}

export function bullets(...items: (Inline | Inline[])[]): Block {
  return element(
    'bulletList',
    {},
    items.map((it) => element('listItem', {}, [paragraph(...runs(it))])),
  )
}

export function numbered(...items: (Inline | Inline[])[]): Block {
  return element(
    'orderedList',
    { start: 1 },
    items.map((it) => element('listItem', {}, [paragraph(...runs(it))])),
  )
}

export function tasks(...items: (string | Task)[]): Block {
  return element(
    'taskList',
    {},
    items.map((it) => {
      const task: Task = typeof it === 'string' ? { text: it } : it
      return element('taskItem', { checked: task.done === true }, [paragraph(...runs(task.text))])
    }),
  )
}

export function quote(...content: Inline[]): Block {
  return element('blockquote', {}, [paragraph(...content)])
}

/** Replaces a fragment's content with the given blocks. Call inside a transaction. */
export function writeBlocks(frag: Y.XmlFragment, blocks: Block[]) {
  if (frag.length) frag.delete(0, frag.length)
  if (blocks.length) frag.insert(0, blocks)
}
