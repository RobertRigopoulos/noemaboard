/**
 * Converts a text card between note, to-do and document in place: the same Y.Map keeps its id,
 * position, z, column, order, colour, lines and attached comments. Type, title, width and content
 * change in ONE undoable transaction, so a single undo restores the card exactly.
 *
 * The rich text is rewritten through the editor schema (the fragment is replaced as a whole, so
 * an edit a teammate makes to the old content at the same moment is not carried over).
 */
import * as Y from 'yjs'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import { prosemirrorToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { getStaticSchema } from '../editor/extensions'
import { isFragmentProjectable } from '../editor/staticHtml'
import { getCardMap, isTrashed, LOCAL_ORIGIN } from './board'
import { MIN_WIDTH } from './types'

export type TextCardType = 'note' | 'todo' | 'document'
export const TEXT_CARD_TYPES: readonly TextCardType[] = ['note', 'todo', 'document']

export function isTextCardType(v: unknown): v is TextCardType {
  return typeof v === 'string' && (TEXT_CARD_TYPES as readonly string[]).includes(v)
}

/** Title a new document card gets (see makeCardMap); it counts as "no title". */
const DEFAULT_DOCUMENT_TITLE = 'Untitled document'
const MAX_TITLE = 300
const MAX_FIRST_LINE = 120
const DOCUMENT_WIDTH = 200
const WIDE_WIDTH = 300
/** Default widths (see DEFAULT_SIZE), for cards whose stored width is missing or malformed. */
const DEFAULT_WIDTH: Record<TextCardType, number> = { note: WIDE_WIDTH, todo: WIDE_WIDTH, document: DOCUMENT_WIDTH }

function cleanTitle(v: unknown): string {
  if (typeof v !== 'string') return ''
  // oxlint-disable-next-line no-control-regex -- removing control characters is intended
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Text of a block with hard breaks as newlines. */
function blockText(node: PMNode): string {
  return node.textBetween(0, node.content.size, '\n', (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ''))
}

function firstLine(blocks: readonly PMNode[]): string {
  for (const block of blocks) {
    if (block.isTextblock) {
      const line = cleanTitle(blockText(block).split('\n').find((l) => l.trim()) ?? '')
      if (line) return Array.from(line).slice(0, MAX_FIRST_LINE).join('')
    } else if (block.childCount) {
      const children: PMNode[] = []
      block.forEach((c) => children.push(c))
      const line = firstLine(children)
      if (line) return line
    }
  }
  return ''
}

/** Title from a leading heading (removed from the blocks) or else the first line (kept). */
function titleFromContent(blocks: PMNode[]): { title: string; blocks: PMNode[] } {
  const head = blocks[0]
  if (head?.type.name === 'heading') {
    const text = cleanTitle(blockText(head))
    if (text) return { title: Array.from(text).slice(0, MAX_TITLE).join(''), blocks: blocks.slice(1) }
  }
  return { title: firstLine(blocks), blocks }
}

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = []
  node.forEach((c) => out.push(c))
  return out
}

function task(schema: Schema, content: PMNode[]): PMNode {
  return schema.nodes.taskItem.create({ checked: false }, content)
}

function paragraphOf(schema: Schema, inline: PMNode, attrs?: Record<string, unknown>): PMNode {
  return schema.nodes.paragraph.create(attrs ?? null, inline.content)
}

/** A list item as a task: its first paragraph is the task text, nested lists become nested tasks. */
function listItemToTask(schema: Schema, item: PMNode): PMNode | null {
  const parts = children(item)
  const head = parts[0]?.type.name === 'paragraph' ? parts.shift()! : schema.nodes.paragraph.create()
  const rest: PMNode[] = []
  for (const part of parts) {
    const name = part.type.name
    if (name === 'bulletList' || name === 'orderedList') {
      const nested = children(part)
        .map((li) => listItemToTask(schema, li))
        .filter((t): t is PMNode => !!t)
      if (nested.length) rest.push(schema.nodes.taskList.create(null, nested))
    } else rest.push(part)
  }
  if (!head.content.size && !rest.length) return null
  return task(schema, [head, ...rest])
}

/** Task items for a list of blocks; existing tasks keep their checked state, empty lines are dropped. */
function toTaskItems(schema: Schema, blocks: readonly PMNode[]): PMNode[] {
  const out: PMNode[] = []
  for (const node of blocks) {
    switch (node.type.name) {
      case 'paragraph':
        if (node.content.size) out.push(task(schema, [node]))
        break
      case 'heading':
        if (node.content.size) out.push(task(schema, [paragraphOf(schema, node, { textAlign: node.attrs.textAlign ?? null })]))
        break
      case 'bulletList':
      case 'orderedList':
        for (const li of children(node)) {
          const t = listItemToTask(schema, li)
          if (t) out.push(t)
        }
        break
      case 'taskList':
        out.push(...children(node).filter((c) => c.type.name === 'taskItem'))
        break
      case 'codeBlock':
        for (const line of node.textContent.split('\n')) {
          if (line.trim()) out.push(task(schema, [schema.nodes.paragraph.create(null, schema.text(line))]))
        }
        break
      case 'horizontalRule':
        break
      default:
        if (node.isTextblock) {
          if (node.content.size) out.push(task(schema, [schema.nodes.paragraph.create(null, node.content)]))
        } else if (node.childCount) out.push(...toTaskItems(schema, children(node)))
    }
  }
  return out
}

function asTaskList(schema: Schema, blocks: readonly PMNode[]): PMNode[] {
  const items = toTaskItems(schema, blocks)
  if (!items.length) items.push(task(schema, [schema.nodes.paragraph.create()]))
  return [schema.nodes.taskList.create(null, items)]
}

function withHeading(schema: Schema, title: string, blocks: PMNode[]): PMNode[] {
  if (!title) return blocks
  return [schema.nodes.heading.create({ level: 2 }, schema.text(title)), ...blocks]
}

/**
 * Turns a note, to-do or document card into another of these types. Refuses (false) cards that
 * are missing, trashed, locked (their content is protected), of another type, already of type `to`,
 * or whose content comes from a newer app version (it could not be carried over intact).
 *
 * Width: documents get their fixed width (they cannot be resized). A document at that width
 * becomes a default-width note or to-do; any other width is kept. Never below the new type's minimum.
 */
export function convertTextCard(doc: Y.Doc, id: string, to: TextCardType, userId: string): boolean {
  if (!isTextCardType(to)) return false
  const m = getCardMap(doc, id)
  if (!m || isTrashed(m) || m.get('locked') === true) return false
  const from = m.get('type')
  if (!isTextCardType(from) || from === to) return false
  const stored = m.get('content')
  const fragment = stored instanceof Y.XmlFragment ? stored : null
  if (fragment && !isFragmentProjectable(fragment)) return false

  const schema = getStaticSchema()
  let root: PMNode
  try {
    root = fragment && fragment.length ? yXmlFragmentToProseMirrorRootNode(fragment, schema) : schema.topNodeType.createAndFill()!
  } catch {
    return false
  }
  let blocks = children(root)
  const oldTitle = cleanTitle(m.get('title'))
  const realTitle = oldTitle === DEFAULT_DOCUMENT_TITLE && from === 'document' ? '' : oldTitle
  /** null = the field is removed (notes have no title). */
  let title: string | null = null
  const storedW = m.get('w')
  const w = typeof storedW === 'number' && Number.isFinite(storedW) && storedW > 0 ? storedW : DEFAULT_WIDTH[from]
  let width = w

  if (to === 'note') {
    blocks = withHeading(schema, realTitle, blocks)
    if (from === 'document' && w === DOCUMENT_WIDTH) width = WIDE_WIDTH
  } else if (to === 'todo') {
    blocks = asTaskList(schema, blocks)
    title = from === 'document' ? realTitle : ''
    if (from === 'document' && w === DOCUMENT_WIDTH) width = WIDE_WIDTH
  } else {
    if (from === 'todo' && realTitle) title = realTitle
    else {
      const extracted = titleFromContent(blocks)
      title = extracted.title || DEFAULT_DOCUMENT_TITLE
      blocks = extracted.blocks
    }
    width = DOCUMENT_WIDTH
  }
  width = Math.max(MIN_WIDTH[to], width)

  let next: PMNode
  try {
    next = blocks.length ? schema.topNodeType.createChecked(null, blocks) : schema.topNodeType.createAndFill()!
    next.check()
  } catch {
    return false
  }
  const contentChanged = !fragment || !next.eq(root)
  const free = typeof m.get('parent') !== 'string' || !m.get('parent')

  doc.transact(() => {
    m.set('type', to)
    if (title === null) {
      if (m.has('title')) m.delete('title')
    } else m.set('title', Array.from(title).slice(0, MAX_TITLE).join(''))
    if (free && storedW !== width) m.set('w', width)
    if (contentChanged) {
      let target = fragment
      if (!target) {
        target = new Y.XmlFragment()
        m.set('content', target)
      }
      if (target.length) target.delete(0, target.length)
      prosemirrorToYXmlFragment(next, target)
    }
    m.set('updatedAt', Date.now())
    m.set('updatedBy', userId)
  }, LOCAL_ORIGIN)
  return true
}
