/**
 * Pure helpers shared by the column, board and comment cards. No React, no DOM.
 */
import { isBoardIconId } from '../../model/boardIcons'
import type * as Y from 'yjs'
import { forEachActiveCard, getCardMap, getMeta, isTrashed, readCard } from '../../model/board'
import { COLUMN_CHILD_TYPES, type CardType } from '../../model/types'
import { attachmentTarget, type AttachLookup } from './attach'

// ---------------------------------------------------------------------------
// Column children

export interface OrderedEntry {
  id: string
  order: string
}

/**
 * Same ordering as the model's columnChildren(): fractional-indexing keys compare as plain
 * code-unit strings (not locale order), ties broken by id so every peer renders the same stack.
 */
export function compareOrder(a: OrderedEntry, b: OrderedEntry): number {
  if (a.order < b.order) return -1
  if (a.order > b.order) return 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function sortChildren<T extends OrderedEntry>(entries: readonly T[]): T[] {
  return [...entries].sort(compareOrder)
}

export interface ChildCandidate extends OrderedEntry {
  parent: string | null
  type: CardType
}

/**
 * Ids of the cards stacked in a column, in display order. Only types allowed inside columns
 * are returned, so malformed peer data (a column whose parent is another column) cannot nest
 * columns or recurse forever.
 */
export function columnChildIds<T extends ChildCandidate>(entries: Iterable<T>, columnId: string, keep?: (e: T) => boolean): string[] {
  const out: T[] = []
  for (const e of entries) {
    if (e.parent === columnId && e.id !== columnId && COLUMN_CHILD_TYPES.has(e.type) && (!keep || keep(e))) out.push(e)
  }
  return sortChildren(out).map((e) => e.id)
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export interface InsertionSlot {
  /** Child the insertion line is drawn next to. */
  id: string
  edge: 'before' | 'after'
}

/**
 * Where to draw the drop line. `index` counts siblings *excluding* the dragged cards (that is how
 * the shell computes drop targets), while the column still renders the dragged cards in place.
 */
export function insertionSlot(children: readonly string[], dragged: ReadonlySet<string>, index: number): InsertionSlot | null {
  if (index < 0 || !children.length) return null
  const rest = children.filter((c) => !dragged.has(c))
  if (!rest.length) return { id: children[0], edge: 'before' }
  if (index < rest.length) return { id: rest[index], edge: 'before' }
  return { id: rest[rest.length - 1], edge: 'after' }
}

// ---------------------------------------------------------------------------
// Titles & labels

export const COLUMN_TITLE_MAX = 200
export const BOARD_TITLE_MAX = 120

// Peer-provided strings are scrubbed of control characters on purpose.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

/** Cuts to `max` UTF-16 units without splitting a surrogate pair (emoji stay intact). */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  let end = Math.max(0, max)
  const c = s.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return s.slice(0, end)
}

/** Single-line, trimmed, length-capped title from untrusted input. */
export function cleanTitle(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return truncate(raw.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim(), max).trim()
}

/** One or two initials for an avatar; works with emoji and non-Latin names. */
export function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  const first = (w: string) => Array.from(w)[0] ?? ''
  const out = first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')
  return out.toLocaleUpperCase()
}

export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  return `${v} ${v === 1 ? singular : plural}`
}

export const cardCountLabel = (n: number) => countLabel(n, 'card')
export const commentCountLabel = (n: number) => countLabel(n, 'comment')

/** Plural of a lower-case English noun used in card labels ('note' -> 'notes', 'sketch' -> 'sketches'). */
export function pluralNoun(word: string): string {
  return /(?:s|x|z|ch|sh)$/.test(word) ? `${word}es` : `${word}s`
}

/**
 * What a column holds, by card type in order of first appearance: '3 notes, 1 board, 2 images'.
 * `labelOf` gives the singular label of a type (the card registry's label).
 */
export function contentsLabel(types: Iterable<CardType>, labelOf: (t: CardType) => string): string {
  const counts = new Map<CardType, number>()
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1)
  if (!counts.size) return 'No cards'
  const parts: string[] = []
  for (const [t, n] of counts) {
    const singular = (labelOf(t) || 'card').toLocaleLowerCase()
    parts.push(countLabel(n, singular, pluralNoun(singular)))
  }
  return parts.join(', ')
}

// ---------------------------------------------------------------------------
// Sorting a column

export type ColumnSortMode = 'title-asc' | 'title-desc' | 'newest' | 'oldest' | 'type' | 'unfinished'

export interface SortEntry {
  id: string
  type: CardType
  /** Title, name, or first line of text; '' when the card has none. */
  key: string
  createdAt: number
  /** A to-do with unchecked tasks. */
  unfinished: boolean
}

/** 'By type' groups cards in this order; other types follow in their original order. */
const TYPE_ORDER: readonly CardType[] = ['note', 'todo', 'document', 'link', 'image', 'file', 'board', 'sketch', 'swatch', 'comment']

const collator = typeof Intl !== 'undefined' ? new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }) : null
const compareText = (a: string, b: string) => (collator ? collator.compare(a, b) : a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))

/**
 * New order of a column's cards (given in their current order). Stable: cards that compare equal
 * keep their current order. Cards without a title sort after titled ones in both directions.
 */
export function sortColumnEntries<T extends SortEntry>(entries: readonly T[], mode: ColumnSortMode): T[] {
  const list = [...entries]
  const typeRank = (t: CardType) => {
    const i = TYPE_ORDER.indexOf(t)
    return i < 0 ? TYPE_ORDER.length : i
  }
  const created = (e: SortEntry) => (Number.isFinite(e.createdAt) ? e.createdAt : 0)
  switch (mode) {
    case 'title-asc':
    case 'title-desc': {
      const dir = mode === 'title-asc' ? 1 : -1
      return list.sort((a, b) => {
        const ka = a.key.trim()
        const kb = b.key.trim()
        if (!ka || !kb) return (ka ? 0 : 1) - (kb ? 0 : 1)
        return dir * compareText(ka, kb)
      })
    }
    case 'newest':
      return list.sort((a, b) => created(b) - created(a))
    case 'oldest':
      return list.sort((a, b) => created(a) - created(b))
    case 'type':
      return list.sort((a, b) => typeRank(a.type) - typeRank(b.type))
    case 'unfinished':
      return list.sort((a, b) => Number(b.unfinished) - Number(a.unfinished))
  }
}

/**
 * Like sortColumnEntries, but locked cards keep their places: only the unlocked cards are sorted,
 * into the places that are not taken by a locked card.
 */
export function sortAroundLocked<T extends SortEntry & { locked: boolean }>(entries: readonly T[], mode: ColumnSortMode): T[] {
  const sorted = sortColumnEntries(
    entries.filter((e) => !e.locked),
    mode,
  )
  let next = 0
  return entries.map((e) => (e.locked ? e : sorted[next++]))
}

// ---------------------------------------------------------------------------
// Board card fields written by this app (validated like any peer data)

export const CHILD_COUNT_MAX = 100_000

/** Cached number of cards on a nested board: an integer in 0..100000, else null. */
export function readChildCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= CHILD_COUNT_MAX ? v : null
}

/** A blob hash: 64 lower-case hex characters. */
export function isBlobHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

/** Title shown on a board card: the library's copy first, then the card's cached copy. */
export function displayBoardTitle(libraryTitle: unknown, cardTitle: unknown): string {
  return cleanTitle(libraryTitle, BOARD_TITLE_MAX) || cleanTitle(cardTitle, BOARD_TITLE_MAX) || 'Untitled board'
}

/** A board icon is one of the fixed icon ids; anything else (old emoji, junk from peers) is ignored. */
export function sanitizeIcon(v: unknown): string | null {
  return isBoardIconId(v) ? v : null
}

// ---------------------------------------------------------------------------
// Child board stats

/** True once a board doc has been initialised (local data loaded or synced). */
export function isBoardDocReady(doc: Y.Doc): boolean {
  return typeof getMeta(doc).get('id') === 'string'
}

/**
 * Cards placed directly on the board (not inside a column; connector lines and comments pinned to a
 * card, which show as markers on it, excluded). Deleted cards and copies hidden after a move to
 * another board stay in the doc for a while; they do not count.
 */
export function countFreeCards(doc: Y.Doc): number {
  const lookup: AttachLookup = (id) => {
    const m = getCardMap(doc, id)
    return m && !isTrashed(m) ? { card: readCard(m) } : undefined
  }
  let n = 0
  forEachActiveCard(doc, (m) => {
    const type = m.get('type')
    if (type === 'line') return
    const p = m.get('parent')
    if (typeof p === 'string' && p) return
    if (type === 'comment' && attachmentTarget(readCard(m), lookup)) return
    n++
  })
  return n
}
