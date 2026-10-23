/**
 * Formatted text from other apps (clipboard or drag-and-drop text/html) as a ProseMirror document
 * of the card schema. Headings, lists, task lists, quotes, code, bold/italic/underline/strike,
 * highlight and links survive; everything the schema has no place for falls away.
 *
 * The HTML is untrusted. It is parsed into an inert document (scripts never run, images never
 * load), pictures, scripts, styles and comments are removed, and the schema's own rules do the
 * rest: links outside http(s)/mailto lose their href (SafeLink), colours outside our palette are
 * dropped (SafeColor, SafeHighlight), and unknown tags only contribute their text.
 */
import { DOMParser as PMDOMParser, Fragment, type Mark, type Node as PMNode, type Schema } from '@tiptap/pm/model'
import { MAX_NOTE_CHARS } from '../cards/media/create'
import { getStaticSchema } from './extensions'

/** Parses an HTML string into an inert element whose children are the content (a <body>). */
export type HtmlParser = (html: string) => ParentNode | null

const browserParser: HtmlParser = (html) => {
  if (typeof DOMParser === 'undefined') return null
  return new DOMParser().parseFromString(html, 'text/html').body
}

/** Elements dropped with everything inside them: no text worth keeping, or things that load or run. */
const DROPPED = new Set([
  'img', 'picture', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'iframe', 'frame', 'object',
  'embed', 'script', 'noscript', 'template', 'style', 'link', 'meta', 'base', 'title', 'head', 'button',
  'select', 'option', 'datalist',
])

/** Removes dropped elements and comments, in place. */
function strip(node: ParentNode) {
  let child = node.firstChild
  while (child) {
    const next: ChildNode | null = child.nextSibling
    if (child.nodeType === 8 || child.nodeType === 7 || (child.nodeType === 1 && DROPPED.has(child.nodeName.toLowerCase()))) {
      node.removeChild(child)
    } else if (child.nodeType === 1) {
      strip(child as unknown as ParentNode)
    }
    child = next
  }
}

function isEmptyTextStyle(mark: Mark): boolean {
  return mark.type.name === 'textStyle' && Object.values(mark.attrs).every((v) => v === null || v === undefined)
}

/**
 * Removes text-style marks that carry nothing: every styled <span> (Google Docs, word processors)
 * becomes one, but a foreign colour or font was dropped, so nothing is left in it.
 */
function dropEmptyTextStyles(node: PMNode): PMNode {
  if (node.isText) return node.marks.some(isEmptyTextStyle) ? node.mark(node.marks.filter((m) => !isEmptyTextStyle(m))) : node
  if (!node.childCount) return node
  const children: PMNode[] = []
  let changed = false
  node.forEach((child) => {
    const next = dropEmptyTextStyles(child)
    if (next !== child) changed = true
    children.push(next)
  })
  return changed ? node.copy(Fragment.fromArray(children)) : node
}

/** Visible text of a document, mentions included. */
export function docText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, '\n', (leaf) => (leaf.type.name === 'mention' ? '@' : leaf.type.name === 'hardBreak' ? '\n' : ''))
}

/** Content offset in a textblock after `chars` characters of text. */
function offsetAfterChars(block: PMNode, chars: number): number {
  let pos = 0
  let left = chars
  block.forEach((child) => {
    if (left <= 0) return
    if (child.isText) {
      const take = Math.min(child.text!.length, left)
      pos += take
      left -= take
    } else pos += child.nodeSize
  })
  return pos
}

/**
 * Cuts a document to at most `max` characters of text, at block boundaries where possible (a
 * text block that crosses the limit is cut inside; any other block crossing it is left out).
 */
export function capDoc(doc: PMNode, max: number, schema: Schema = doc.type.schema): { doc: PMNode; truncated: boolean } {
  if (doc.textContent.length <= max) return { doc, truncated: false }
  const blocks: PMNode[] = []
  let used = 0
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i)
    const len = block.textContent.length
    if (used + len <= max) {
      blocks.push(block)
      used += len
      continue
    }
    const room = max - used
    if (block.isTextblock && room > 0) blocks.push(block.cut(0, offsetAfterChars(block, room)))
    break
  }
  if (!blocks.length) blocks.push(schema.nodes.paragraph.create())
  return { doc: doc.type.createChecked(doc.attrs, blocks), truncated: true }
}

/**
 * Parses untrusted HTML into a document of the card schema, or null when it cannot be parsed or
 * holds no text. `parse` turns the string into a DOM (browsers: DOMParser; tests pass their own).
 */
export function htmlToPmDoc(html: string, parse: HtmlParser = browserParser): PMNode | null {
  if (typeof html !== 'string' || !html.trim()) return null
  try {
    // Very long HTML is mostly markup; the text is capped below anyway.
    const body = parse(html.length > MAX_NOTE_CHARS * 20 ? html.slice(0, MAX_NOTE_CHARS * 20) : html)
    if (!body) return null
    strip(body)
    const schema = getStaticSchema()
    const parsed = dropEmptyTextStyles(PMDOMParser.fromSchema(schema).parse(body as unknown as Node))
    const { doc } = capDoc(parsed, MAX_NOTE_CHARS, schema)
    doc.check()
    return docText(doc).trim() ? doc : null
  } catch {
    return null
  }
}

/** Mark and node types that count as formatting (anything beyond plain paragraphs of text). */
export function hasFormatting(doc: PMNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    const name = node.type.name
    if (node.isText) {
      if (node.marks.some((m) => !isEmptyTextStyle(m))) found = true
      return false
    }
    if (name === 'paragraph') {
      if (node.attrs.textAlign && node.attrs.textAlign !== 'left') found = true
      return !found
    }
    if (name !== 'hardBreak') found = true
    return !found
  })
  return found
}
