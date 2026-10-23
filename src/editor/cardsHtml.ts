/**
 * Sanitised HTML rendition of cards for the system clipboard (text/html), so pasting into a mail,
 * a word processor or another note keeps headings, lists, bold and links. Text cards use the same
 * allowlisted serialiser as the board; every other field is escaped text. The app's own card
 * marker is added by the caller, never here.
 */
import * as Y from 'yjs'
import { exportSelection, getCardMap, isTrashed, readCard } from '../model/board'
import { memberName } from '../model/members'
import type { Card } from '../model/types'
import { imageLabel } from '../cards/media/altText'
import { escapeHtml } from './serialize'
import { fragmentToHtmlWith, fragmentToText, textToHtml } from './staticHtml'
import { isSafeHref, normalizeLinkInput } from './safeUrl'

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')

function fragment(m: Y.Map<unknown>, field: string): Y.XmlFragment | null {
  const f = m.get(field)
  return f instanceof Y.XmlFragment ? f : null
}

function heading(level: 2 | 3, text: string): string {
  const t = text.trim()
  return t ? `<h${level}>${escapeHtml(t)}</h${level}>` : ''
}

function safeUrl(url: string): string | null {
  if (!url) return null
  return isSafeHref(url) ? url.trim() : normalizeLinkInput(url)
}

function cardHtml(doc: Y.Doc, m: Y.Map<unknown>, card: Card): string {
  const assigneeName = (id: string) => memberName(doc, id)
  const rich = (field: string) => {
    const f = fragment(m, field)
    return f ? fragmentToHtmlWith(f, { assigneeName }) : ''
  }
  const text = (s: string) => textToHtml(s.trim())
  switch (card.type) {
    case 'note':
      return rich('content')
    case 'todo':
      return heading(3, str(card.title, 300)) + rich('content')
    case 'document': {
      const title = str(card.title, 300)
      return heading(2, title === 'Untitled document' ? '' : title) + rich('content')
    }
    case 'link': {
      const url = str(card.url)
      const href = safeUrl(url)
      const title = str(card.title, 500).trim() || url
      const link = href ? `<p><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></p>` : text(title)
      return link + text(str(card.description, 2000)) + rich('caption')
    }
    case 'image': {
      const caption = fragment(m, 'caption')
      return text(imageLabel(str(card.alt), caption ? fragmentToText(caption) : '', str(card.name, 300)))
    }
    case 'comment': {
      const thread = m.get('thread')
      const parts: string[] = []
      if (thread instanceof Y.Array) {
        for (const msg of thread.toArray()) if (msg instanceof Y.Map) parts.push(str(msg.get('text'), 10000))
      }
      return text(parts.filter((p) => p.trim()).join('\n'))
    }
    case 'board':
    case 'column':
      return heading(3, str(card.title, 300))
    case 'swatch':
      return text([str(card.name, 200), str(card.hex, 20)].filter(Boolean).join(' '))
    case 'file':
      return text(str(card.name, 300))
    case 'line':
      return text(str(card.label, 500))
    default:
      return ''
  }
}

/**
 * HTML for the given cards (column contents included), for the clipboard. Comment threads pinned to
 * a copied card are left out unless they were selected themselves (see exportSelection).
 */
export function cardsToHtml(doc: Y.Doc, ids: Iterable<string>): string {
  const parts: string[] = []
  for (const id of exportSelection(doc, ids)) {
    const m = getCardMap(doc, id)
    if (!m || isTrashed(m)) continue
    let html = ''
    try {
      html = cardHtml(doc, m, readCard(m))
    } catch {
      html = ''
    }
    if (html) parts.push(html)
  }
  return parts.join('\n')
}
