/**
 * ProseMirror document -> HTML string, without a DOM.
 *
 * Mirrors prosemirror-model's DOMSerializer (same toDOM specs, same mark nesting) but builds a string,
 * so it runs in tests and never touches `document`. Because the content comes from peers, output is
 * restricted to an allowlist of tags and attributes, and every href/style is re-validated here as a
 * second line of defence behind the schema's own attribute renderers.
 */
import type { DOMOutputSpec, Fragment, Mark, Node as PMNode } from '@tiptap/pm/model'
import { isSafeHref, LINK_HTML_ATTRIBUTES, normalizeLinkInput } from './safeUrl'
import { safeCssColor } from './palette'
import { cleanAssignee, cleanDue } from './taskMeta'
import { cleanMentionId } from './mentionAttrs'

export interface SerializeOptions {
  /**
   * Text for a task's assignee chip (the member's name). The board fills chips in after rendering;
   * copies for other apps (the clipboard) have no board, so they get the name as text.
   */
  assigneeName?: (id: string) => string | null
}

interface VElement {
  tag: string
  attrs: Record<string, string>
  children: VNode[]
}
type VNode = VElement | string

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'hr', 'br',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'mark', 'span', 'a', 'label', 'input', 'div', 'sub', 'sup',
])
const VOID_TAGS = new Set(['br', 'hr', 'input'])
const STYLE_PROPS = new Set(['color', 'background-color', 'text-align'])
const ALIGNMENTS = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])
const MAX_ATTR = 2048
const CODE_LANGUAGE_CLASS = /^language-[a-z0-9+#.-]{1,32}$/i

function element(tag: string): VElement {
  return { tag, attrs: {}, children: [] }
}

function renderSpec(spec: DOMOutputSpec): { dom: VNode; contentDOM?: VElement } {
  if (typeof spec === 'string') return { dom: spec }
  if (!Array.isArray(spec)) throw new Error('Unsupported DOM output spec')
  const parts = spec as readonly unknown[]
  const rawTag = parts[0]
  if (typeof rawTag !== 'string') throw new Error('Invalid DOM output spec')
  // "namespace tag" form: keep the tag name only.
  const el = element(rawTag.slice(rawTag.indexOf(' ') + 1).toLowerCase())
  let start = 1
  const maybeAttrs = parts[1]
  if (maybeAttrs && typeof maybeAttrs === 'object' && !Array.isArray(maybeAttrs)) {
    start = 2
    for (const [name, value] of Object.entries(maybeAttrs as Record<string, unknown>)) {
      if (value !== null && value !== undefined) el.attrs[name] = String(value)
    }
  }
  let contentDOM: VElement | undefined
  for (let i = start; i < parts.length; i++) {
    const child = parts[i]
    if (child === 0) {
      if (i !== start || i !== parts.length - 1) throw new RangeError('Content hole must be the only child of its parent')
      contentDOM = el
      continue
    }
    const inner = renderSpec(child as DOMOutputSpec)
    el.children.push(inner.dom)
    if (inner.contentDOM) {
      if (contentDOM) throw new RangeError('Multiple content holes')
      contentDOM = inner.contentDOM
    }
  }
  return { dom: el, contentDOM }
}

/** ProseMirror renders a <br> in empty textblocks (and after a trailing hard break) so they keep their height. */
function needsTrailingBreak(node: PMNode): boolean {
  const last = node.lastChild
  if (!last) return true
  if (last.type.name === 'hardBreak') return true
  return !!node.type.spec.code && !!last.text && last.text.endsWith('\n')
}

function hasClass(el: VElement, cls: string): boolean {
  return (el.attrs.class ?? '').split(/\s+/).includes(cls)
}

/** Puts the assignee's name into a rendered task item's assignee chip. */
function nameAssigneeChip(node: PMNode, dom: VNode, opts: SerializeOptions) {
  if (!opts.assigneeName || typeof dom === 'string' || node.type.name !== 'taskItem') return
  const id = cleanAssignee(node.attrs.assignee)
  const name = id ? opts.assigneeName(id) : null
  if (!name) return
  for (const meta of dom.children) {
    if (typeof meta === 'string' || !hasClass(meta, 'task-meta')) continue
    for (const chip of meta.children) {
      if (typeof chip !== 'string' && hasClass(chip, 'task-chip--assignee')) chip.children = [`@${name}`]
    }
  }
}

function serializeNode(node: PMNode, opts: SerializeOptions): VNode {
  if (node.isText) return node.text ?? ''
  const toDOM = node.type.spec.toDOM
  if (!toDOM) throw new Error(`No renderer for node type ${node.type.name}`)
  const { dom, contentDOM } = renderSpec(toDOM(node))
  if (contentDOM) {
    if (node.isLeaf) throw new RangeError('Content hole not allowed in a leaf node spec')
    serializeFragmentInto(node.content, contentDOM, opts)
    if (node.isTextblock && needsTrailingBreak(node)) contentDOM.children.push(element('br'))
  }
  nameAssigneeChip(node, dom, opts)
  return dom
}

/** Same mark-nesting algorithm as DOMSerializer.serializeFragment: marks shared by neighbours stay open. */
function serializeFragmentInto(fragment: Fragment, target: VElement, opts: SerializeOptions) {
  const active: { mark: Mark; parent: VElement }[] = []
  let top = target
  fragment.forEach((node) => {
    if (active.length || node.marks.length) {
      let keep = 0
      let rendered = 0
      while (keep < active.length && rendered < node.marks.length) {
        const next = node.marks[rendered]
        if (!next.type.spec.toDOM) {
          rendered++
          continue
        }
        if (!next.eq(active[keep].mark) || next.type.spec.spanning === false) break
        keep++
        rendered++
      }
      while (keep < active.length) top = active.pop()!.parent
      while (rendered < node.marks.length) {
        const add = node.marks[rendered++]
        const toDOM = add.type.spec.toDOM
        if (!toDOM) continue
        const { dom, contentDOM } = renderSpec(toDOM(add, node.isInline))
        if (typeof dom === 'string') throw new Error('Mark rendered as text')
        active.push({ mark: add, parent: top })
        top.children.push(dom)
        top = contentDOM ?? dom
      }
    }
    top.children.push(serializeNode(node, opts))
  })
}

// ---------------------------------------------------------------------------
// Stringify with sanitising

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function sanitizeStyle(style: string): string {
  const out: string[] = []
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (!STYLE_PROPS.has(prop)) continue
    if (prop === 'text-align') {
      if (ALIGNMENTS.has(value.toLowerCase())) out.push(`text-align: ${value.toLowerCase()}`)
    } else if (value === 'inherit' || safeCssColor(value)) {
      out.push(`${prop}: ${value}`)
    }
  }
  return out.join('; ')
}

/** Scheme-less hrefs (autolinked "example.com") get https://; anything not http(s)/mailto is dropped. */
function sanitizeHref(href: string): string | null {
  if (isSafeHref(href)) return href.trim()
  return normalizeLinkInput(href)
}

/**
 * data-* attributes by tag. Each value is re-validated: they come from node attributes that peers
 * write, and the board reads some of them back (task index, assignee, mention id).
 */
function sanitizeDataAttr(tag: string, name: string, value: string, attrs: Record<string, string>): string | null {
  const type = attrs['data-type']
  switch (name) {
    case 'data-type':
      if (tag === 'ul' && value === 'taskList') return value
      if (tag === 'li' && value === 'taskItem') return value
      if (tag === 'span' && value === 'mention') return value
      return null
    case 'data-checked':
      return tag === 'li' && type === 'taskItem' && (value === 'true' || value === 'false') ? value : null
    case 'data-due':
      return tag === 'li' && type === 'taskItem' ? cleanDue(value) : null
    case 'data-assignee':
      return tag === 'li' && type === 'taskItem' ? cleanAssignee(value) : null
    case 'data-id':
      return tag === 'span' && type === 'mention' ? cleanMentionId(value) : null
    default:
      return null
  }
}

/** Class names the app's own renderers put on spans (task chips, mentions); nothing else gets through. */
const SPAN_CLASSES = new Set(['task-meta', 'task-chip', 'task-chip--due', 'task-chip--assignee', 'mention'])

function sanitizeClass(tag: string, value: string): string | null {
  // Only known tokens. Anything else could carry the app's own classes ("world", "no-drag",
  // "lightbox"...) and change how the board treats the element.
  if (tag === 'code') return CODE_LANGUAGE_CLASS.test(value) ? value : null
  if (tag !== 'span') return null
  const tokens = value.split(/\s+/).filter((t) => SPAN_CLASSES.has(t))
  return tokens.length ? Array.from(new Set(tokens)).join(' ') : null
}

function sanitizeAttrs(tag: string, attrs: Record<string, string>): string {
  const out: [string, string][] = []
  for (const [rawName, rawValue] of Object.entries(attrs)) {
    const name = rawName.toLowerCase()
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name.startsWith('on')) continue
    const value = rawValue.slice(0, MAX_ATTR)
    if (name.startsWith('data-')) {
      const clean = sanitizeDataAttr(tag, name, value, attrs)
      if (clean !== null) out.push([name, clean])
      continue
    }
    switch (name) {
      case 'class': {
        const cls = sanitizeClass(tag, value)
        if (cls) out.push(['class', cls])
        break
      }
      case 'contenteditable':
        if (tag === 'span' && value === 'false') out.push(['contenteditable', 'false'])
        break
      case 'aria-hidden':
        if (value === 'true') out.push(['aria-hidden', 'true'])
        break
      case 'href': {
        if (tag !== 'a') break
        const href = sanitizeHref(value)
        if (href) out.push(['href', href])
        break
      }
      case 'style': {
        const style = sanitizeStyle(value)
        if (style) out.push(['style', style])
        break
      }
      case 'title':
        out.push(['title', value.slice(0, 300)])
        break
      case 'start':
        if (tag === 'ol' && /^-?\d{1,9}$/.test(value)) out.push(['start', value])
        break
      case 'type':
        if (tag === 'ol' && /^[1aAiI]$/.test(value)) out.push(['type', value])
        break
      case 'checked':
        if (tag === 'input') out.push(['checked', ''])
        break
      default:
        break
    }
  }
  if (tag === 'a') {
    out.push(['target', LINK_HTML_ATTRIBUTES.target], ['rel', LINK_HTML_ATTRIBUTES.rel])
  }
  if (tag === 'input') {
    const checked = out.some(([n]) => n === 'checked')
    out.unshift(['type', 'checkbox'])
    out.push(['aria-label', checked ? 'Mark as not done' : 'Mark as done'])
  }
  return out.map(([n, v]) => (v === '' && n === 'checked' ? ` ${n}` : ` ${n}="${escapeHtml(v)}"`)).join('')
}

function stringify(node: VNode): string {
  if (typeof node === 'string') return escapeHtml(node)
  if (!ALLOWED_TAGS.has(node.tag)) throw new Error(`Tag not allowed: ${node.tag}`)
  if (node.tag === 'input' && node.attrs.type !== 'checkbox') throw new Error('Only checkbox inputs are allowed')
  const open = `<${node.tag}${sanitizeAttrs(node.tag, node.attrs)}>`
  if (VOID_TAGS.has(node.tag)) return open
  let inner = ''
  for (const child of node.children) inner += stringify(child)
  return `${open}${inner}</${node.tag}>`
}

/** Serialises the content of a document node to sanitised HTML. Throws on anything it cannot render. */
export function serializeContent(content: Fragment, opts: SerializeOptions = {}): string {
  const root = element('div')
  serializeFragmentInto(content, root, opts)
  let html = ''
  for (const child of root.children) html += stringify(child)
  return html
}
