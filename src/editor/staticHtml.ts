/**
 * Static rendering of rich-text fragments for cards that are not being edited.
 * Only one live editor exists at a time; every other card shows cached HTML built from its fragment.
 */
import * as Y from 'yjs'
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { getStaticSchema } from './extensions'
import { escapeHtml, serializeContent, type SerializeOptions } from './serialize'
import { cleanMentionLabel } from './mentionAttrs'

interface Rendered {
  html: string
  /** False when the fragment cannot be represented with our schema (e.g. made by a newer app version). */
  projectable: boolean
}

const cache = new WeakMap<Y.XmlFragment, Rendered>()
const observed = new WeakSet<Y.XmlFragment>()

function watch(fragment: Y.XmlFragment) {
  if (observed.has(fragment)) return
  observed.add(fragment)
  fragment.observeDeep(() => cache.delete(fragment))
}

const BLOCKS = /^(paragraph|heading|taskItem|listItem|codeBlock|blockquote)$/

function textOf(t: Y.XmlText): string {
  let s = ''
  for (const op of t.toDelta() as { insert?: unknown }[]) if (typeof op.insert === 'string') s += op.insert
  return s
}

/**
 * Plain text of a fragment, one line per block. Like xmlToText() from the model, but reads text
 * through deltas so literal "<...>" typed by people survives.
 */
export function fragmentToText(fragment: Y.XmlFragment): string {
  const lines: string[] = []
  const walk = (n: Y.XmlFragment | Y.XmlElement | Y.XmlText, acc: string[]): void => {
    if (n instanceof Y.XmlText) {
      acc.push(textOf(n))
      return
    }
    if (!(n instanceof Y.XmlElement) && !(n instanceof Y.XmlFragment)) return
    const children = n.toArray() as (Y.XmlElement | Y.XmlText)[]
    const isBlock = n instanceof Y.XmlElement && BLOCKS.test(n.nodeName)
    if (isBlock && !children.some((c) => c instanceof Y.XmlElement && c.nodeName === 'paragraph')) {
      const inner: string[] = []
      children.forEach((c) => walk(c, inner))
      lines.push(inner.join(''))
      return
    }
    if (n instanceof Y.XmlElement && n.nodeName === 'hardBreak') {
      acc.push('\n')
      return
    }
    if (n instanceof Y.XmlElement && n.nodeName === 'mention') {
      acc.push(`@${cleanMentionLabel(n.getAttribute('label')) || 'someone'}`)
      return
    }
    // Lists, quotes and unknown wrappers: descend (text directly inside a top-level wrapper becomes its own line).
    children.forEach((c) => walk(c, acc))
  }
  walk(fragment, lines)
  return lines.join('\n').trim()
}

/** Plain-text fallback: one escaped paragraph per line. */
export function textToHtml(text: string): string {
  if (!text) return ''
  return text
    .split('\n')
    .map((line) => (line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>'))
    .join('')
}

/** y-prosemirror's change-tracking attribute (snapshots); never a reason to block editing. */
const IGNORED_ATTRS: ReadonlySet<string> = new Set(['ychange'])
/** Mark attributes the schema drops on purpose (they always come from our own options). */
const IGNORED_MARK_ATTRS: Record<string, ReadonlySet<string>> = {
  link: new Set(['target', 'rel', 'class']),
}

function knownKeys(attrs: Record<string, unknown>, spec: Record<string, unknown> | undefined, ignored?: ReadonlySet<string>): boolean {
  for (const key of Object.keys(attrs)) {
    if (spec && Object.prototype.hasOwnProperty.call(spec, key)) continue
    if (IGNORED_ATTRS.has(key) || ignored?.has(key)) continue
    return false
  }
  return true
}

/**
 * True when every element, mark and attribute in the fragment exists in our schema. ProseMirror
 * silently drops unknown attributes, and the editor then removes them from the shared text on the
 * next edit, so content from a newer app version (say, an `indent` attribute) must stay read-only.
 * Content that is merely structurally incomplete (an empty note, an emptied list) is still editable:
 * the editor repairs it.
 */
function usesOnlyKnownSchema(fragment: Y.XmlFragment): boolean {
  const schema = getStaticSchema()
  const ok = (node: Y.XmlFragment | Y.XmlElement): boolean => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlElement) {
        const type = schema.nodes[child.nodeName]
        if (!type) return false
        if (!knownKeys(child.getAttributes() as Record<string, unknown>, type.spec.attrs)) return false
        if (!ok(child)) return false
      } else if (child instanceof Y.XmlText) {
        for (const op of child.toDelta() as { attributes?: Record<string, unknown> }[]) {
          for (const [key, value] of Object.entries(op.attributes ?? {})) {
            // y-tiptap may suffix mark keys with a hash for overlapping marks of the same type.
            const name = key.split('--')[0]
            const mark = schema.marks[name]
            if (!mark) return false
            if (value && typeof value === 'object' && !knownKeys(value as Record<string, unknown>, mark.spec.attrs, IGNORED_MARK_ATTRS[name])) {
              return false
            }
          }
        }
      }
    }
    return true
  }
  try {
    return ok(fragment)
  } catch {
    return false
  }
}

function render(fragment: Y.XmlFragment, opts?: SerializeOptions): Rendered {
  if (fragment.length === 0) return { html: '', projectable: true }
  try {
    const schema = getStaticSchema()
    const doc = yXmlFragmentToProseMirrorRootNode(fragment, schema)
    return { html: serializeContent(doc.content, opts), projectable: usesOnlyKnownSchema(fragment) }
  } catch {
    let text = ''
    try {
      text = fragmentToText(fragment)
    } catch {
      /* malformed fragment: show nothing rather than crash the board */
    }
    return { html: textToHtml(text), projectable: usesOnlyKnownSchema(fragment) }
  }
}

function rendered(fragment: Y.XmlFragment): Rendered {
  let r = cache.get(fragment)
  if (!r) {
    r = render(fragment)
    cache.set(fragment, r)
    watch(fragment)
  }
  return r
}

/** Sanitised HTML for a fragment (cached until the fragment changes). Falls back to plain text. */
export function fragmentToHtml(fragment: Y.XmlFragment): string {
  return rendered(fragment).html
}

/** Like fragmentToHtml, with serialisation options and without the cache (copies for other apps). */
export function fragmentToHtmlWith(fragment: Y.XmlFragment, opts: SerializeOptions): string {
  return render(fragment, opts).html
}

/** Whether a live editor can safely bind to the fragment (unknown node/mark types or attributes make it read-only). */
export function isFragmentProjectable(fragment: Y.XmlFragment): boolean {
  return rendered(fragment).projectable
}

const STRUCTURAL = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
])

/** True when the fragment shows nothing: no text and no visible leaf blocks (empty lists count as empty). */
export function isFragmentEmpty(fragment: Y.XmlFragment): boolean {
  const hasContent = (node: Y.XmlFragment | Y.XmlElement): boolean => {
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        if (child.length > 0) return true
      } else if (child instanceof Y.XmlElement) {
        if (!STRUCTURAL.has(child.nodeName)) return true
        if (hasContent(child)) return true
      } else {
        return true
      }
    }
    return false
  }
  try {
    return !hasContent(fragment)
  } catch {
    return false
  }
}
