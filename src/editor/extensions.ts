/**
 * TipTap extension sets for card editors and the schema used to render non-edited cards.
 *
 * Every variant shares ONE schema (only UI differs), so content written in a document can always be
 * shown in a note and the static renderer can use a single cached schema.
 */
import { getSchema, mergeAttributes, type AnyExtension, type Editor, type Extensions } from '@tiptap/core'
import type { Node as PMNode, Schema } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
// Ship with (and are pinned to the same version by) @tiptap/starter-kit.
import { CodeBlock } from '@tiptap/extension-code-block'
import { Heading } from '@tiptap/extension-heading'
import { Link } from '@tiptap/extension-link'
import { TaskList } from '@tiptap/extension-list'
import { Color, TextStyle } from '@tiptap/extension-text-style'
import { Highlight } from '@tiptap/extension-highlight'
import { TextAlign } from '@tiptap/extension-text-align'
import { Typography } from '@tiptap/extension-typography'
import { Placeholder } from '@tiptap/extensions'
import Collaboration from '@tiptap/extension-collaboration'
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { RemoteCarets } from './caret'
import { BoardTextHistory, createInertUndoManager } from './history'
import { isAllowedLinkTarget, LINK_HTML_ATTRIBUTES } from './safeUrl'
import { paletteValue, safeCssColor } from './palette'
import { TaskItemWithMeta, type TaskItemMetaOptions } from './taskItem'
import { Mention, MentionSuggest } from './mention'

export type RichTextVariant = 'note' | 'todo' | 'document' | 'caption'

/** Options of the live editor only; they never change the schema. */
interface LiveContentOptions {
  meId?: string | null
  onTaskMeta?: TaskItemMetaOptions['onMeta']
  taskMember?: TaskItemMetaOptions['member']
}

export interface BuildExtensionsOptions extends LiveContentOptions {
  variant: RichTextVariant
  placeholder?: string
  /** Card fragment to bind to. Omit for a schema-only extension set. */
  fragment?: Y.XmlFragment
  /** Board awareness for remote carets (requires `fragment`). */
  awareness?: Awareness | null
  /**
   * The board's UndoManager (requires `fragment`). Text edits then share the board's history and can
   * still be undone after the editor closes. Without it the editor keeps a history of its own.
   */
  undoManager?: Y.UndoManager | null
  /**
   * Current user. Board presence normally publishes it; it is only written to awareness when no
   * `user` is present yet, so others can still label our caret.
   */
  user?: { name: string; color: string } | null
}

/** Link mark with only href/title stored: rel/target/class always come from our options, never from peers. */
const SafeLink = Link.extend({
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('href'),
      },
      title: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('title'),
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs.title === 'string' && attrs.title ? { title: attrs.title.slice(0, 300) } : {},
      },
    }
  },
})

/** Text color limited to plain CSS colors; only our palette is accepted from pasted HTML. */
const SafeColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (element: HTMLElement) => paletteValue(element.style.color),
            renderHTML: (attrs: Record<string, unknown>) => {
              const color = safeCssColor(attrs.color)
              return color ? { style: `color: ${color}` } : {}
            },
          },
        },
      },
    ]
  },
})

const SafeHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => paletteValue(element.style.backgroundColor),
        renderHTML: (attrs: Record<string, unknown>) => {
          const color = safeCssColor(attrs.color)
          return color ? { style: `background-color: ${color}; color: inherit` } : {}
        },
      },
    }
  },
})

/** Headings 1-3; pasted h4-h6 become small headings instead of losing their heading. */
const CardHeading = Heading.extend({
  parseHTML() {
    return [
      ...this.options.levels.map((level) => ({ tag: `h${level}`, attrs: { level } })),
      ...['h4', 'h5', 'h6'].map((tag) => ({ tag, attrs: { level: 3 } })),
    ]
  },
}).configure({ levels: [1, 2, 3] })

/** A code block language is a short identifier. It becomes a CSS class, so nothing else is accepted. */
export function safeCodeLanguage(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z0-9+#.-]{1,32}$/i.test(v) ? v : null
}

/**
 * Code block whose peer-written `language` attribute can only ever produce one `language-<id>`
 * class: "x world no-drag" must not put the app's own classes on the element.
 */
const SafeCodeBlock = CodeBlock.extend({
  addAttributes() {
    return {
      language: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const prefix = this.options.languageClassPrefix || 'language-'
          const cls = Array.from(element.firstElementChild?.classList ?? []).find((c) => c.startsWith(prefix))
          return safeCodeLanguage(cls?.slice(prefix.length))
        },
        rendered: false,
      },
    }
  },
  renderHTML({ node, HTMLAttributes }) {
    const language = safeCodeLanguage(node.attrs.language)
    const prefix = this.options.languageClassPrefix || 'language-'
    return ['pre', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), ['code', { class: language ? prefix + language : null }, 0]]
  },
})

const PLACEHOLDERS: Record<RichTextVariant, string> = {
  note: 'Type something…',
  todo: 'Add a task…',
  document: 'Start writing…',
  caption: 'Add a caption…',
}

function placeholderFor(variant: RichTextVariant, main: string) {
  return ({ editor, node, pos }: { editor: Editor; node: PMNode; pos: number }) => {
    if (node.type.name === 'heading') return 'Heading'
    let parentName = ''
    try {
      parentName = editor.state.doc.resolve(pos).parent.type.name
    } catch {
      /* position outside the doc while it is changing */
    }
    if (parentName === 'taskItem') return variant === 'todo' ? 'Add a task…' : 'To-do'
    if (parentName === 'listItem') return 'List item'
    // Only the very first empty line of an otherwise empty editor shows the main placeholder.
    const doc = editor.state.doc
    return doc.childCount === 1 && doc.firstChild === node ? main : ''
  }
}

/** Schema-defining extensions (identical for every variant; `live` only adds editor behaviour). */
function contentExtensions(live: LiveContentOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      // Undo goes through Yjs (the board history, see history.ts); TrailingNode writes junk paragraphs
      // into shared docs; the code block and heading are replaced by SafeCodeBlock and CardHeading.
      undoRedo: false,
      trailingNode: false,
      link: false,
      codeBlock: false,
      heading: false,
      dropcursor: { color: 'var(--select)', width: 2 },
    }),
    CardHeading,
    SafeCodeBlock,
    SafeLink.configure({
      openOnClick: false,
      enableClickSelection: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      HTMLAttributes: { ...LINK_HTML_ATTRIBUTES },
      isAllowedUri: (url) => isAllowedLinkTarget(url),
    }),
    TaskList,
    TaskItemWithMeta.configure({
      nested: true,
      HTMLAttributes: { 'data-type': 'taskItem' },
      onMeta: live.onTaskMeta ?? null,
      member: live.taskMember ?? null,
    }),
    Mention.configure({ meId: live.meId ?? null }),
    TextStyle,
    SafeColor,
    SafeHighlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'], alignments: ['left', 'center', 'right'] }),
  ]
}

export function buildExtensions(opts: BuildExtensionsOptions): Extensions {
  const exts: AnyExtension[] = [
    ...contentExtensions(opts),
    MentionSuggest,
    Typography.configure({
      // Keep conversions that never surprise in plain notes ("1920x1080", "1/2" stay as typed).
      oneHalf: false,
      oneQuarter: false,
      threeQuarters: false,
      superscriptTwo: false,
      superscriptThree: false,
      multiplication: false,
      laquo: false,
      raquo: false,
      plusMinus: false,
      notEqual: false,
    }),
    Placeholder.configure({
      placeholder: placeholderFor(opts.variant, opts.placeholder ?? PLACEHOLDERS[opts.variant]),
      includeChildren: true,
      showOnlyCurrent: true,
    }),
  ]
  if (opts.fragment) {
    if (opts.undoManager) {
      // The board history records the text; y-tiptap gets a manager that records nothing, so there
      // is never a second history that could undo the same edit again.
      const inert = createInertUndoManager(opts.fragment)
      exts.push(Collaboration.configure({ fragment: opts.fragment, yUndoOptions: { undoManager: inert } }))
      exts.push(BoardTextHistory.configure({ undoManager: opts.undoManager, fragment: opts.fragment }))
    } else {
      exts.push(Collaboration.configure({ fragment: opts.fragment }))
    }
    if (opts.awareness) exts.push(RemoteCarets.configure({ awareness: opts.awareness, user: opts.user ?? null }))
  }
  return exts
}

let staticSchema: Schema | null = null

/** The schema used for static rendering; built once. */
export function getStaticSchema(): Schema {
  if (!staticSchema) staticSchema = getSchema(contentExtensions())
  return staticSchema
}
