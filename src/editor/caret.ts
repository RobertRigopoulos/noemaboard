/**
 * Remote carets and selections inside a rich-text editor.
 *
 * We use y-tiptap's cursor plugin directly instead of @tiptap/extension-collaboration-caret because
 * (1) the board's presence already publishes `user` ({ id, name, color }) and that extension would
 * overwrite it, and (2) awareness states come from untrusted peers, so every state is validated
 * before y-tiptap turns it into positions and DOM.
 * Carets live in the awareness field 'cursor' (the canvas pointer uses 'pointer').
 */
import { Extension } from '@tiptap/core'
import { yCursorPlugin } from '@tiptap/y-tiptap'
import type { Awareness } from 'y-protocols/awareness'

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/
const WORD_JOINER = String.fromCharCode(0x2060)

function isId(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return Number.isSafeInteger(o.client) && Number.isSafeInteger(o.clock) && (o.client as number) >= 0 && (o.clock as number) >= 0
}

/** Shape check for a Yjs RelativePosition as JSON. Root-type names are rejected: card fragments are always nested. */
export function isRelativePositionJSON(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o.tname !== null && o.tname !== undefined) return false
  if (!isId(o.type) || !isId(o.item)) return false
  if ((o.type === null || o.type === undefined) && (o.item === null || o.item === undefined)) return false
  return o.assoc === undefined || o.assoc === null || Number.isSafeInteger(o.assoc)
}

/** Decides whether a peer's awareness state may be drawn as a caret. */
export function isDrawableCaretState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const s = state as Record<string, unknown>
  const cursor = s.cursor as Record<string, unknown> | null | undefined
  if (!cursor || typeof cursor !== 'object') return false
  if (!isRelativePositionJSON(cursor.anchor) || !isRelativePositionJSON(cursor.head)) return false
  const user = s.user as Record<string, unknown> | null | undefined
  if (!user || typeof user !== 'object') return false
  return typeof user.name === 'string' && typeof user.color === 'string' && HEX_COLOR.test(user.color)
}

export function caretLabel(name: unknown): string {
  const n = typeof name === 'string' ? name.trim().slice(0, 40) : ''
  return n || 'Someone'
}

function buildCaret(user: { name: string; color: string }): HTMLElement {
  const color = HEX_COLOR.test(user.color) ? user.color : '#888888'
  const caret = document.createElement('span')
  caret.className = 'rt-caret'
  caret.style.borderColor = color
  caret.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.className = 'rt-caret__label'
  label.style.backgroundColor = color
  label.textContent = caretLabel(user.name)
  // Word joiners keep the caret from changing line breaking, like y-tiptap's default caret.
  caret.append(document.createTextNode(WORD_JOINER), label, document.createTextNode(WORD_JOINER))
  return caret
}

export interface RemoteCaretsOptions {
  awareness: Awareness | null
  /** Published as the awareness `user` only when nothing (e.g. board presence) has set one yet. */
  user: { name: string; color: string } | null
}

export const RemoteCarets = Extension.create<RemoteCaretsOptions>({
  name: 'remoteCarets',
  addOptions() {
    return { awareness: null, user: null }
  },
  addProseMirrorPlugins() {
    const { awareness, user } = this.options
    if (!awareness) return []
    const local = awareness.getLocalState() as Record<string, unknown> | null
    if (user && (!local || !local.user)) awareness.setLocalStateField('user', { ...user })
    return [
      yCursorPlugin(awareness, {
        awarenessStateFilter: (own, other, state) => own !== other && isDrawableCaretState(state),
        cursorBuilder: (user) => buildCaret(user),
        selectionBuilder: (user) => ({
          class: 'rt-remote-selection',
          style: `background-color: ${HEX_COLOR.test(user.color) ? user.color : '#888888'}33`,
        }),
      }),
    ]
  },
})
