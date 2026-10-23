/**
 * @mentions: an inline atom node and a suggestion plugin that notices "@query" before the caret.
 *
 * The node stores the member id and the label shown when it was inserted (so it still reads well
 * for someone who never met that member). The plugin only tracks state; MentionList.tsx renders
 * the picker and registers its key handler here, so the list can take Up/Down/Enter/Tab/Escape
 * before the editor (and before Escape ends editing).
 */
import { Extension, mergeAttributes, Node } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { cleanMentionId, cleanMentionLabel, matchMentionTrigger } from './mentionAttrs'

export interface MentionOptions {
  /** The current user's id: their own mentions get the `is-me` class in the live editor. */
  meId: string | null
}

function labelOf(node: PMNode): string {
  return cleanMentionLabel(node.attrs.label) || 'someone'
}

export const Mention = Node.create<MentionOptions>({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  draggable: false,

  addOptions() {
    return { meId: null }
  },

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => cleanMentionId(element.getAttribute('data-id')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const id = cleanMentionId(attrs.id)
          return id ? { 'data-id': id } : {}
        },
      },
      label: {
        default: '',
        parseHTML: (element: HTMLElement) => cleanMentionLabel((element.textContent ?? '').replace(/^@/, '')),
        rendered: false,
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-type="mention"]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes({ 'data-type': 'mention', class: 'mention' }, HTMLAttributes), `@${labelOf(node)}`]
  },

  renderText({ node }) {
    return `@${labelOf(node)}`
  },

  addNodeView() {
    const meId = this.options.meId
    if (!meId) return null
    return ({ node }) => {
      const dom = document.createElement('span')
      const render = (n: PMNode) => {
        const id = cleanMentionId(n.attrs.id)
        dom.className = id === meId ? 'mention is-me' : 'mention'
        dom.dataset.type = 'mention'
        if (id) dom.dataset.id = id
        else delete dom.dataset.id
        dom.textContent = `@${labelOf(n)}`
      }
      render(node)
      return {
        dom,
        update: (next: PMNode) => {
          if (next.type !== node.type) return false
          render(next)
          return true
        },
      }
    }
  },
})

// ---------------------------------------------------------------------------
// Suggestion plugin

export interface MentionMatch {
  /** Document range of "@query". */
  from: number
  to: number
  query: string
}

interface SuggestState {
  match: MentionMatch | null
  /** Position of an "@" the person closed the list for with Escape; it stays closed there. */
  dismissed: number | null
}

export const mentionSuggestKey = new PluginKey<SuggestState>('mentionSuggest')

/** Key handler of the open picker, per editor view. Returns true when it used the key. */
const keyHandlers = new WeakMap<EditorView, (event: KeyboardEvent) => boolean>()

export function setMentionKeyHandler(view: EditorView, handler: ((event: KeyboardEvent) => boolean) | null): void {
  if (handler) keyHandlers.set(view, handler)
  else keyHandlers.delete(view)
}

/** Placeholder for atoms in the text before the caret, so "@" right after a mention does not count as after a space. */
const ATOM = String.fromCharCode(0xfffc)

function findMatch(state: EditorState): MentionMatch | null {
  const sel = state.selection
  if (!sel.empty) return null
  const $pos = sel.$from
  const parent = $pos.parent
  if (!parent.isTextblock || parent.type.spec.code) return null
  if (state.schema.marks.code && $pos.marks().some((m) => m.type === state.schema.marks.code)) return null
  const start = Math.max(0, $pos.parentOffset - 64)
  // A soft line break (Shift+Enter) is whitespace, so "@" can start a mention at the start of a line.
  const before = parent.textBetween(start, $pos.parentOffset, undefined, (leaf) => (leaf.type.name === 'hardBreak' ? '\n' : ATOM))
  const hit = matchMentionTrigger(before)
  if (!hit) return null
  return { from: $pos.pos - hit.length, to: $pos.pos, query: hit.query }
}

/** The mention query being typed in this editor state, unless the person dismissed it. */
export function activeMention(state: EditorState): MentionMatch | null {
  const s = mentionSuggestKey.getState(state)
  return s?.match ?? null
}

/** Closes the picker for the "@" currently being typed (Escape). */
export function dismissMention(view: EditorView): void {
  const match = activeMention(view.state)
  if (match) view.dispatch(view.state.tr.setMeta(mentionSuggestKey, { dismiss: match.from }))
}

export const MentionSuggest = Extension.create({
  name: 'mentionSuggest',
  // Above the card editor keys (Escape, Enter in lists) so an open list gets the keys first.
  priority: 1100,

  addProseMirrorPlugins() {
    return [
      new Plugin<SuggestState>({
        key: mentionSuggestKey,
        state: {
          init: (_, state) => ({ match: findMatch(state), dismissed: null }),
          apply: (tr, prev, _old, state) => {
            const meta = tr.getMeta(mentionSuggestKey) as { dismiss?: number } | undefined
            let dismissed = prev.dismissed
            if (meta?.dismiss !== undefined) dismissed = meta.dismiss
            else if (dismissed !== null && tr.docChanged) dismissed = tr.mapping.map(dismissed)
            const match = state.schema.nodes.mention ? findMatch(state) : null
            if (!match) return { match: null, dismissed: null }
            if (dismissed !== null && dismissed === match.from) return { match: null, dismissed }
            return { match, dismissed: null }
          },
        },
        props: {
          handleKeyDown: (view, event) => {
            if (!activeMention(view.state)) return false
            const handler = keyHandlers.get(view)
            return handler ? handler(event) : false
          },
        },
      }),
    ]
  },
})
