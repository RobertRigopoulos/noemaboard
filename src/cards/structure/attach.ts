/**
 * Comments attached to cards (pins). Pure helpers, no React or DOM: a comment card stores the id of
 * the card it is pinned to in `attachedTo`; everything here validates that against the board.
 */
import { CARD_TYPES } from '../../model/types'

/** Ids that may be stored in `attachedTo` (and in mention lists). */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

const KNOWN_TYPES: ReadonlySet<string> = new Set(CARD_TYPES)
const NOT_ATTACHABLE: ReadonlySet<string> = new Set(['comment', 'line'])

/** Card types a comment can be pinned to: every known type except comments and lines. */
export function isAttachableType(type: unknown): boolean {
  return typeof type === 'string' && KNOWN_TYPES.has(type) && !NOT_ATTACHABLE.has(type)
}

/** The raw `attachedTo` of a comment card, when it is a well-formed id. */
export function readAttachedTo(card: { readonly type: string }): string | null {
  const v = (card as unknown as Record<string, unknown>).attachedTo
  return typeof v === 'string' && ID_RE.test(v) ? v : null
}

/** A free comment thread folded into a pill (=== true only; peers may write anything). */
export function isCollapsedThread(card: { readonly type: string }): boolean {
  return (card as unknown as Record<string, unknown>).collapsed === true
}

/** Cards waiting in the board's Unsorted drawer are not on the canvas. */
export function isUnsortedCard(card: { readonly type: string }): boolean {
  return (card as unknown as Record<string, unknown>).unsorted === true
}

function isRemoved(card: { readonly type: string }): boolean {
  return typeof (card as unknown as Record<string, unknown>).trashedAt === 'number'
}

/** Looks a card up by id; `board.index.get` fits (it only knows active cards). */
export type AttachLookup = (id: string) => { readonly card: { readonly type: string } } | null | undefined

/**
 * The card a comment is pinned to, or null when the comment should render as an ordinary free card
 * at its stored x/y: not a comment, no (valid) `attachedTo`, or a target that is missing, trashed,
 * moved away, unsorted, or of a type that cannot carry comments. Nothing is lost when a peer
 * deletes the target: the thread simply shows up on the canvas again.
 */
export function attachmentTarget(card: { readonly type: string }, lookup: AttachLookup): string | null {
  if (card.type !== 'comment') return null
  const id = readAttachedTo(card)
  if (!id || id === (card as unknown as Record<string, unknown>).id) return null
  const target = lookup(id)?.card
  if (!target || !isAttachableType(target.type) || isRemoved(target) || isUnsortedCard(target)) return null
  return id
}

/**
 * Ids of the comments pinned to `targetId`, oldest first (the order of their markers). `cards` are
 * the board's active cards, e.g. `board.index.getSnapshot()`.
 */
export function pinsOn(
  cards: Iterable<{ readonly id: string; readonly type: string; readonly card: { readonly type: string; readonly createdAt: number } }>,
  lookup: AttachLookup,
  targetId: string,
): string[] {
  const entries: PinEntry[] = []
  for (const c of cards) {
    if (c.type === 'comment' && attachmentTarget(c.card, lookup) === targetId) entries.push({ id: c.id, target: targetId, createdAt: c.card.createdAt })
  }
  return groupPins(entries).get(targetId) ?? []
}

/** A comment drawn as a pin on another card, so neither the canvas nor a column draws it as a card. */
export function isPinnedComment(c: { readonly type: string; readonly card: { readonly type: string } }, lookup: AttachLookup): boolean {
  return c.type === 'comment' && attachmentTarget(c.card, lookup) !== null
}

// ---------------------------------------------------------------------------
// Markers

/** Marker size in CSS pixels at scale 1. */
export const MARKER_SIZE = 28
export const MARKER_GAP = 4
export const MARKER_MIN_SCALE = 0.6
export const MARKER_MAX_SCALE = 1.5

/** Markers keep a readable on-screen size: scaled by 1/zoom, within limits. */
export function markerScale(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(MARKER_MAX_SCALE, Math.max(MARKER_MIN_SCALE, 1 / zoom))
}

export interface RectLike {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Board-space top-left positions (unscaled box, scaled around its centre) of `count` markers on a
 * card: the first one centred on the top-right corner, the next ones stacked to its left.
 */
export function markerPositions(rect: RectLike, count: number, scale: number): { x: number; y: number }[] {
  const half = MARKER_SIZE / 2
  const step = (MARKER_SIZE + MARKER_GAP) * scale
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < count; i++) out.push({ x: rect.x + rect.w - half - i * step, y: rect.y - half })
  return out
}

export interface PinEntry {
  id: string
  target: string
  createdAt: number
}

/** Attached comments grouped by target, oldest first (ties by id), so markers never swap places. */
export function groupPins(entries: Iterable<PinEntry>): Map<string, string[]> {
  const sorted = Array.from(entries).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const out = new Map<string, string[]>()
  for (const e of sorted) {
    const list = out.get(e.target)
    if (list) list.push(e.id)
    else out.set(e.target, [e.id])
  }
  return out
}
