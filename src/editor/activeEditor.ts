/**
 * The live rich-text editor of the card being edited, for UI outside the card (the rail's text
 * toolbar, the document bar). Only one card is edited at a time, so one slot is enough.
 */
import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { RichTextVariant } from './extensions'

export interface ActiveEditorState {
  editor: Editor | null
  variant: RichTextVariant | null
  /** Card the editor belongs to, when the card body passed one. */
  cardId: string | null
  set: (editor: Editor, variant: RichTextVariant, cardId: string | null) => void
  /**
   * Forgets `editor`, but only when it is still the stored one: React StrictMode and quick card
   * switches can run an old editor's cleanup after the next editor registered itself.
   */
  clear: (editor: Editor) => void
}

export const useActiveEditor = create<ActiveEditorState>((set, get) => ({
  editor: null,
  variant: null,
  cardId: null,
  set: (editor, variant, cardId) => {
    const s = get()
    if (s.editor === editor && s.variant === variant && s.cardId === cardId) return
    set({ editor, variant, cardId })
  },
  clear: (editor) => {
    if (get().editor !== editor) return
    set({ editor: null, variant: null, cardId: null })
  },
}))

// ---------------------------------------------------------------------------
// Escape while a toolbar dropdown is open

/**
 * Dropdowns opened with the mouse leave focus in the text, so Escape reaches the editor, which
 * would end editing. Open dropdowns register a closer here; the editor runs the newest one first.
 */
const escapeHandlers: (() => void)[] = []

/** Registers a closer for Escape pressed in the text. Returns the unregister function. */
export function registerEditorEscape(close: () => void): () => void {
  escapeHandlers.push(close)
  return () => {
    const i = escapeHandlers.lastIndexOf(close)
    if (i >= 0) escapeHandlers.splice(i, 1)
  }
}

/** Runs (and drops) the newest registered closer. True when there was one. */
export function runEditorEscape(): boolean {
  const close = escapeHandlers.pop()
  if (!close) return false
  close()
  return true
}
