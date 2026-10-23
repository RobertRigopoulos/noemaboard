/**
 * Doc-level creation of link and note cards from imported text. Pure Yjs (no DOM, no UI state)
 * so it can be unit tested; import.ts / paste.ts add layout, selection and toasts.
 */
import type * as Y from 'yjs'
import { createCard, createTextNote, type NewCardFields } from '../../model/board'
import { detectEmbed } from './embed'
import { truncate } from './format'

/** Longest plain text that becomes a single note (larger pastes are cut, with a toast). */
export const MAX_NOTE_CHARS = 100_000

/** Cleans pasted/dropped text for a note: unified line breaks, no control chars, no blank edges. */
export function prepareNoteText(text: string): { text: string; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  let s = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  // Drop leading/trailing blank lines but keep indentation of the first real line.
  s = s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '')
  const truncated = s.length > MAX_NOTE_CHARS
  return { text: truncated ? truncate(s, MAX_NOTE_CHARS) : s, truncated }
}

/** Creates a note holding `text`, one paragraph per line. Returns '' if there is no text. */
export function createNoteFromText(doc: Y.Doc, text: string, fields: NewCardFields, userId: string): string {
  const { text: clean } = prepareNoteText(text)
  if (!clean.trim()) return ''
  return createTextNote(doc, clean, fields, userId)
}

/** Fields of a link card for a (normalized) URL whose preview has not been fetched yet. */
export function linkFields(url: string, userId: string): Record<string, unknown> {
  return {
    url,
    embed: detectEmbed(url),
    title: '',
    description: '',
    siteName: '',
    imageBlob: null,
    imageUrl: null,
    favicon: null,
    previewState: 'idle',
    previewBy: userId,
    previewFor: null,
  }
}

/** Creates a link card for a normalized http(s) URL; its preview is fetched once it renders. */
export function createLinkCard(doc: Y.Doc, url: string, fields: NewCardFields, userId: string): string {
  return createCard(doc, 'link', { ...linkFields(url, userId), ...fields }, userId)
}
