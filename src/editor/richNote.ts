/**
 * Notes created from pasted or dropped formatted text (HTML or Markdown).
 */
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap'
import { createCard, getCardMap, LOCAL_ORIGIN, type NewCardFields } from '../model/board'
import { hasFormatting, htmlToPmDoc, type HtmlParser } from './htmlImport'
import { looksLikeMarkdown, markdownToPmDoc } from './markdownImport'
import { isPlainTextPaste } from './plainPaste'

export interface RichNoteSource {
  /** text/html from the clipboard or drop, when there was any. */
  html?: string | null
  /** text/plain. */
  text: string
}

/**
 * True for the HTML a code editor (VS Code and others) puts next to the plain text: monospace lines
 * kept as typed (white-space: pre). What was copied there is most likely code, and Python's
 * "# comment", "__init__" or "**kwargs" must not turn into headings, bold and italics.
 */
export function isCodeEditorHtml(html: string): boolean {
  if (/white-space\s*:\s*pre(?![\w-])/i.test(html)) return true
  return /font-family\s*:(?:&#?\w+;|[^;>])*?\b(?:monospace|consolas|menlo|monaco|courier|cascadia|jetbrains mono|fira code|source code pro|sf mono)\b/i.test(html)
}

function markdownOf(text: unknown, html: string): PMNode | null {
  if (typeof text !== 'string' || isCodeEditorHtml(html) || !looksLikeMarkdown(text)) return null
  return markdownToPmDoc(text)
}

/**
 * The formatted content of a paste or drop: the HTML when it carries formatting, else the plain text
 * read as Markdown when it looks like Markdown, else null. HTML without any formatting (a browser's
 * copy of plain text) counts as plain text, so Markdown copied from a chat or a web page still
 * converts. A code editor's copy never does (see isCodeEditorHtml).
 */
export function richContent(source: RichNoteSource, parse?: HtmlParser): PMNode | null {
  const html = typeof source.html === 'string' ? source.html : ''
  const fromHtml = html.trim() ? htmlToPmDoc(html, parse) : null
  if (fromHtml && hasFormatting(fromHtml)) return fromHtml
  return markdownOf(source.text, html)
}

/**
 * Markdown pasted into open text: the document to insert, or null when the editor's own paste
 * should run (formatted HTML, which it reads itself; a code editor's copy; text that is not Markdown).
 */
export function markdownPaste(source: RichNoteSource, parse?: HtmlParser): PMNode | null {
  const text = typeof source.text === 'string' ? source.text : ''
  const html = typeof source.html === 'string' ? source.html : ''
  // Cheap test first: most pastes are not Markdown, and parsing the HTML is not free.
  if (!looksLikeMarkdown(text) || isCodeEditorHtml(html)) return null
  const fromHtml = html.trim() ? htmlToPmDoc(html, parse) : null
  if (fromHtml && hasFormatting(fromHtml)) return null
  return markdownToPmDoc(text)
}

/**
 * Creates a note holding the formatted content, or returns null when the content has no formatting
 * worth keeping or the person pasted with Ctrl+Shift+V (the caller then takes its plain-text path).
 * The card and its text are written in one LOCAL_ORIGIN transaction, so one undo removes the note.
 */
export function createRichNote(doc: Y.Doc, source: RichNoteSource, fields: NewCardFields, userId: string, parse?: HtmlParser): string | null {
  if (isPlainTextPaste()) return null
  const content = richContent(source, parse)
  if (!content) return null
  let id = ''
  doc.transact(() => {
    id = createCard(doc, 'note', fields, userId)
    const fragment = getCardMap(doc, id)?.get('content')
    if (fragment instanceof Y.XmlFragment) prosemirrorToYXmlFragment(content, fragment)
  }, LOCAL_ORIGIN)
  return id || null
}
