/**
 * Compact, display-ready summaries of board trash entries. Deletion is soft (cards stay in the
 * `cards` map with trashedAt/trashedBy/trashGroup), so entries are grouped here by trashGroup.
 * Trash data comes from peers: every field is read defensively and text is clipped.
 */
import * as Y from 'yjs'
import { getCards, isTrashed, readCard, xmlToText } from '../../model/board'
import type { Card, CardMap, CardType } from '../../model/types'

export const SUMMARY_TEXT_MAX = 90

export interface TrashSummary {
  /** Trash group id (what restoreTrashEntry / purgeTrashEntry take). */
  id: string
  deletedAt: number
  deletedBy: string
  /** Cards the person actually deleted (column children and attached lines are not counted). */
  count: number
  /** Every card in the entry, including column children and attached lines. */
  total: number
  /** Distinct types of the primary cards with counts, most frequent first. */
  types: { type: CardType; count: number }[]
  /** First readable text among the cards ('' if none). */
  title: string
}

/** First non-empty line of a string, whitespace-collapsed and clipped. */
export function firstLine(text: string, max = SUMMARY_TEXT_MAX): string {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\[[ x]\] /, '').replace(/\s+/g, ' ').trim()
    if (line) return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
  }
  return ''
}

const fieldText = (m: CardMap, field: string): string => {
  const v = m.get(field)
  return v instanceof Y.XmlFragment ? xmlToText(v) : ''
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Best human-readable text for a card: title, name, first line of its content... */
export function cardSummaryText(m: CardMap, card: Card = readCard(m)): string {
  const c = card as Card & Record<string, unknown>
  let text = ''
  switch (card.type) {
    case 'note':
      text = fieldText(m, 'content')
      break
    case 'todo':
    case 'document': {
      // A placeholder title says less than the first line of the content.
      const title = firstLine(s(c.title))
      text = title && title !== 'Untitled document' ? title : fieldText(m, 'content') || title
      break
    }
    case 'link':
      text = s(c.title) || s(c.url)
      break
    case 'image':
      text = fieldText(m, 'caption') || s(c.name)
      break
    case 'file':
      text = s(c.name)
      break
    case 'board':
    case 'column':
      text = s(c.title)
      break
    case 'comment': {
      const thread = m.get('thread')
      if (thread instanceof Y.Array) {
        for (const msg of thread.toArray()) {
          if (msg instanceof Y.Map && s(msg.get('text')).trim()) {
            text = s(msg.get('text'))
            break
          }
        }
      }
      break
    }
    case 'swatch':
      text = s(c.name) || s(c.hex)
      break
    case 'line':
      text = s(c.label)
      break
    case 'sketch':
      break
  }
  return firstLine(text)
}

/** Summarises the cards of one trash entry. */
export function summarizeCards(maps: readonly CardMap[]): Pick<TrashSummary, 'count' | 'total' | 'types' | 'title'> {
  const cards = maps.map((m) => ({ m, c: readCard(m) }))
  const ids = new Set(cards.map(({ c }) => c.id))
  const isPrimary = (c: Card) => {
    if (c.parent && ids.has(c.parent)) return false
    if (c.type === 'line' && ((c.from.card && ids.has(c.from.card)) || (c.to.card && ids.has(c.to.card)))) return false
    return true
  }
  let primary = cards.filter(({ c }) => isPrimary(c))
  if (!primary.length) primary = cards

  const counts = new Map<CardType, number>()
  for (const { c } of primary) counts.set(c.type, (counts.get(c.type) ?? 0) + 1)
  const types = Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count)

  let title = ''
  for (const { m, c } of [...primary, ...cards]) {
    title = cardSummaryText(m, c)
    if (title) break
  }
  return { count: primary.length, total: cards.length, types, title }
}

/** Trash group of a soft-deleted card (cards without a valid group form their own entry). */
export function trashGroupOf(m: CardMap, id: string): string {
  const g = m.get('trashGroup')
  return typeof g === 'string' && g ? g : id
}

/** True for cards listed in the trash (deleted, not moved to another board). */
export function isListedInTrash(m: unknown): m is CardMap {
  return m instanceof Y.Map && isTrashed(m) && !m.get('movedTo')
}

/** All trash entries of a board, newest first. */
export function summarizeTrash(doc: Y.Doc): TrashSummary[] {
  const groups = new Map<string, { deletedAt: number; deletedBy: string; maps: CardMap[] }>()
  getCards(doc).forEach((m, id) => {
    if (!isListedInTrash(m)) return
    const key = trashGroupOf(m, id)
    let g = groups.get(key)
    if (!g) {
      const at = m.get('trashedAt')
      g = { deletedAt: typeof at === 'number' && Number.isFinite(at) ? at : 0, deletedBy: s(m.get('trashedBy')), maps: [] }
      groups.set(key, g)
    }
    g.maps.push(m)
  })
  const out: TrashSummary[] = []
  for (const [id, g] of groups) out.push({ id, deletedAt: g.deletedAt, deletedBy: g.deletedBy, ...summarizeCards(g.maps) })
  return out.sort((a, b) => b.deletedAt - a.deletedAt || (a.id < b.id ? -1 : 1))
}

/** Number of trash entries (cheap: no text extraction). */
export function countTrashEntries(doc: Y.Doc): number {
  const groups = new Set<string>()
  getCards(doc).forEach((m, id) => {
    if (isListedInTrash(m)) groups.add(trashGroupOf(m, id))
  })
  return groups.size
}

const TRASH_KEYS = ['trashedAt', 'trashedBy', 'trashGroup', 'movedTo']

/**
 * Whether a batch of `cards.observeDeep` events can change what the trash shows. Typing inside
 * cards on the board fires deep events constantly; those are ignored.
 */
export function affectsTrash(events: readonly Y.YEvent<any>[], cards: Y.Map<CardMap>): boolean {
  for (const ev of events) {
    if (ev.target === cards) return true
    let t: Y.AbstractType<any> | null = ev.target
    // Walk up to the card map that contains the change.
    while (t && t.parent && t.parent !== cards) t = t.parent as Y.AbstractType<any>
    if (!(t instanceof Y.Map) || t.parent !== cards) continue
    if (t === ev.target && TRASH_KEYS.some((k) => (ev as Y.YMapEvent<unknown>).keysChanged.has(k))) return true
    if (isTrashed(t as CardMap)) return true
  }
  return false
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "just now", "5 min ago", "2 hours ago", "yesterday", "3 days ago", then a short date. */
export function relativeTime(ts: number, now = Date.now()): string {
  if (!ts) return 'some time ago'
  const d = Math.max(0, now - ts)
  if (d < 45_000) return 'just now'
  if (d < HOUR) return `${Math.max(1, Math.round(d / MINUTE))} min ago`
  if (d < DAY) {
    const h = Math.floor(d / HOUR)
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  if (d < 2 * DAY) return 'yesterday'
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} days ago`
  const date = new Date(ts)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' })
}

/** "Note", "3 notes", "2 cards" style label for an entry. */
export function entryLabel(types: TrashSummary['types'], count: number, labels: Partial<Record<CardType, string>> = {}): string {
  if (count === 0) return 'Empty'
  if (types.length === 1) {
    const base = labels[types[0].type] ?? types[0].type
    return count === 1 ? base : `${count} ${pluralize(base.toLowerCase())}`
  }
  return `${count} cards`
}

function pluralize(word: string): string {
  if (word === 'to-do') return 'to-dos'
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}
