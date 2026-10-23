/**
 * Builds the searchable text of boards and cards, and runs queries over it.
 * Card content comes from peers, so every field is type-checked and length-capped.
 * Rich text is read through fragmentToText, so @mentions are found as "@Name", tasks with their due
 * date and assignee; images are found by name, alt text and caption.
 */
import * as Y from 'yjs'
import { getCards, isTrashed, readMeta } from '../../model/board'
import type { CardType } from '../../model/types'
import { readAlt } from '../../cards/media/altText'
import { fragmentToText } from '../export/markdown'
import { fold, hasCriteria, makeSnippet, matchesAll, parseSearchQuery, scoreFields, type Folded, type SnippetPart } from './match'

export type SearchItemType = CardType | 'board-title'

export interface SearchItem {
  boardId: string
  /** null = the board itself (title match). */
  cardId: string | null
  type: SearchItemType
  /** Display title: card title / first line, or the board title. */
  title: string
  /** Everything else that is searchable, newline separated. */
  body: string
  foldedTitle: Folded
  foldedBody: Folded
}

export interface SearchHit {
  boardId: string
  cardId: string | null
  type: SearchItem['type']
  title: SnippetPart[]
  snippet: SnippetPart[]
  score: number
}

export interface SearchGroup {
  boardId: string
  boardTitle: string
  hits: SearchHit[]
}

const MAX_FIELD = 20_000
const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')

const TYPE_LABEL: Record<CardType, string> = {
  note: 'Note',
  todo: 'To-do list',
  link: 'Link',
  image: 'Image',
  file: 'File',
  board: 'Board',
  column: 'Column',
  line: 'Line',
  comment: 'Comment',
  swatch: 'Color',
  sketch: 'Sketch',
  document: 'Document',
}

export function makeItem(boardId: string, cardId: string | null, type: SearchItem['type'], title: string, body: string): SearchItem {
  const t = title.replace(/\s+/g, ' ').trim().slice(0, 300)
  const b = body.slice(0, MAX_FIELD)
  return { boardId, cardId, type, title: t, body: b, foldedTitle: fold(t), foldedBody: fold(b) }
}

function fragText(m: Y.Map<unknown>, field: string): string {
  const v = m.get(field)
  return v instanceof Y.XmlFragment ? fragmentToText(v).slice(0, MAX_FIELD) : ''
}

function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? ''
}

/** Title + body text for one card map, or null for cards with nothing to search. */
export function cardText(m: Y.Map<unknown>): { type: CardType; title: string; body: string } | null {
  const type = m.get('type') as CardType
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(TYPE_LABEL, type)) return null
  let title = ''
  let body = ''
  switch (type) {
    case 'note': {
      const text = fragText(m, 'content')
      title = firstLine(text)
      body = text
      break
    }
    case 'todo':
    case 'document': {
      title = str(m.get('title'), 500)
      body = fragText(m, 'content')
      break
    }
    case 'link': {
      title = str(m.get('title'), 500) || str(m.get('url'), 500)
      body = [str(m.get('url'), 2000), str(m.get('siteName'), 200), str(m.get('description'), 2000), fragText(m, 'caption')].join('\n')
      break
    }
    case 'image': {
      title = str(m.get('name'), 300)
      body = [readAlt(m.get('alt')), fragText(m, 'caption')].filter(Boolean).join('\n')
      break
    }
    case 'file':
      title = str(m.get('name'), 300)
      break
    case 'board':
    case 'column':
      title = str(m.get('title'), 300)
      break
    case 'comment': {
      const thread = m.get('thread')
      const lines: string[] = []
      if (thread instanceof Y.Array) {
        for (const msg of thread.toArray().slice(0, 500)) {
          if (!(msg instanceof Y.Map)) continue
          const text = str(msg.get('text'), 5000)
          if (text) lines.push(`${str(msg.get('authorName'), 80) || 'Someone'}: ${text}`)
        }
      }
      body = lines.join('\n')
      title = firstLine(body)
      break
    }
    case 'swatch': {
      title = str(m.get('name'), 200)
      body = str(m.get('hex'), 20)
      break
    }
    case 'line':
      title = str(m.get('label'), 300)
      break
    case 'sketch':
      // No words to find, but the type filter lists sketches.
      return { type, title: TYPE_LABEL.sketch, body: '' }
  }
  if (!title.trim() && !body.trim()) return null
  return { type, title: title.trim() ? title : TYPE_LABEL[type], body }
}

/** Searchable items for every active card of a board doc. */
export function collectDocItems(boardId: string, doc: Y.Doc): SearchItem[] {
  const out: SearchItem[] = []
  getCards(doc).forEach((m, id) => {
    if (!(m instanceof Y.Map) || isTrashed(m)) return
    const t = cardText(m)
    if (t) out.push(makeItem(boardId, id, t.type, t.title, t.body))
  })
  return out
}

export function boardTitleItem(boardId: string, title: string): SearchItem {
  return makeItem(boardId, null, 'board-title', title, '')
}

/** Title from the doc when loaded, else the cached library title. */
export function docTitle(doc: Y.Doc | undefined, fallback: string): string {
  if (!doc || !doc.getMap('meta').get('id')) return fallback
  return readMeta(doc).title || fallback
}

// ---------------------------------------------------------------------------
// Type filters (the chip row)

export const SEARCH_FILTERS = [
  { id: 'all', label: 'All', types: null },
  { id: 'boards', label: 'Boards', types: ['board-title', 'board'] },
  { id: 'notes', label: 'Notes', types: ['note'] },
  { id: 'todos', label: 'To-dos', types: ['todo'] },
  { id: 'links', label: 'Links', types: ['link'] },
  { id: 'media', label: 'Images and files', types: ['image', 'file'] },
  { id: 'comments', label: 'Comments', types: ['comment'] },
  { id: 'documents', label: 'Documents', types: ['document'] },
  { id: 'creative', label: 'Colors and sketches', types: ['swatch', 'sketch'] },
] as const satisfies readonly { id: string; label: string; types: readonly SearchItemType[] | null }[]

export type SearchFilterId = (typeof SEARCH_FILTERS)[number]['id']

export function filterTypes(id: SearchFilterId): ReadonlySet<string> | null {
  const f = SEARCH_FILTERS.find((x) => x.id === id)
  return f?.types ? new Set<string>(f.types) : null
}

export interface SearchOptions {
  /** Hits on this board rank first. */
  currentBoardId?: string | null
  maxHits?: number
  maxPerBoard?: number
  /** Only these item types (the filter chips); null/undefined = all. */
  types?: ReadonlySet<string> | null
  /** Only these boards (the scope); null/undefined = all. */
  boardIds?: ReadonlySet<string> | null
  /** Sort by when each board was last viewed (higher first) instead of by relevance. */
  recency?: ((boardId: string) => number) | null
}

/**
 * Runs a query: board-title matches come first as their own group (boardId ''),
 * card matches are grouped by board, groups ordered by best hit (or by recency).
 * Queries may use type:<card type>, in:"Board name" and "exact phrases" (see parseSearchQuery).
 */
export function runSearch(items: SearchItem[], query: string, boardTitles: (id: string) => string, opts: SearchOptions = {}): SearchGroup[] {
  const parsed = parseSearchQuery(query)
  // A type filter alone lists everything of that type (browse all images, all to-dos...).
  if (!hasCriteria(parsed) && !opts.types) return []
  const { terms, phrases } = parsed
  const highlightTerms = [...terms, ...phrases].sort((a, b) => b.length - a.length)
  const opTypes = parsed.types.length ? new Set(parsed.types) : null
  const maxHits = opts.maxHits ?? 200
  const maxPerBoard = opts.maxPerBoard ?? 25
  const foldedBoardTitles = new Map<string, string>()
  const boardMatches = (boardId: string) => {
    if (!parsed.boards.length) return true
    let t = foldedBoardTitles.get(boardId)
    if (t === undefined) foldedBoardTitles.set(boardId, (t = fold(boardTitles(boardId)).text))
    return parsed.boards.some((b) => t!.includes(b))
  }

  const scored: { item: SearchItem; score: number }[] = []
  for (const item of items) {
    if (opts.types && !opts.types.has(item.type)) continue
    if (opTypes && !opTypes.has(item.type)) continue
    if (opts.boardIds && !opts.boardIds.has(item.boardId)) continue
    if (!matchesAll([item.foldedTitle, item.foldedBody], terms)) continue
    if (!phrases.every((p) => item.foldedTitle.text.includes(p) || item.foldedBody.text.includes(p))) continue
    if (!boardMatches(item.boardId)) continue
    let score = terms.length ? scoreFields(item.foldedTitle, item.foldedBody, terms, parsed.text) : 0
    for (const p of phrases) score += item.foldedTitle.text.includes(p) ? 12 : 4
    if (item.boardId === opts.currentBoardId) score += 5
    if (item.type === 'board-title' || item.type === 'board') score += 4
    scored.push({ item, score })
  }
  const recency = opts.recency
  scored.sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))

  const groups = new Map<string, SearchGroup>()
  let total = 0
  for (const { item, score } of scored) {
    if (total >= maxHits) break
    const key = item.type === 'board-title' ? '' : item.boardId
    let g = groups.get(key)
    if (!g) {
      g = { boardId: key, boardTitle: key ? boardTitles(key) : 'Boards', hits: [] }
      groups.set(key, g)
    }
    if (g.hits.length >= maxPerBoard) continue
    const titleHasAll = highlightTerms.every((t) => item.foldedTitle.text.includes(t))
    g.hits.push({
      boardId: item.boardId,
      cardId: item.cardId,
      type: item.type,
      title: makeSnippet(item.title, highlightTerms, 90),
      // A body excerpt when the body matched something the title did not (or a preview for filter-only queries).
      snippet: item.body && (!titleHasAll || !highlightTerms.length) ? makeSnippet(item.body, highlightTerms) : [],
      score,
    })
    total++
  }
  if (recency) groups.get('')?.hits.sort((a, b) => recency(b.boardId) - recency(a.boardId) || b.score - a.score)
  // Board-title group first, then by best score (hits are already in score order), or by recency.
  return Array.from(groups.values()).sort((a, b) => {
    if (!a.boardId) return -1
    if (!b.boardId) return 1
    if (recency) {
      const d = recency(b.boardId) - recency(a.boardId)
      if (d) return d
    }
    return b.hits[0].score - a.hits[0].score
  })
}
