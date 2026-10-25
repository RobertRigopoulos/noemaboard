/**
 * Pure operations on a board Y.Doc. No React, no DOM, no networking.
 * All mutations run inside a transaction with LOCAL_ORIGIN so the board UndoManager tracks them.
 */
import * as Y from 'yjs'
import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing'
import { newBoardId, newId, newSecret } from './ids'
import {
  CARD_TYPES,
  CARD_YTYPES,
  COLUMN_CHILD_TYPES,
  DEFAULT_SIZE,
  SCHEMA_VERSION,
  type BoardMeta,
  type Card,
  type CardMap,
  type CardType,
  type LineEnd,
} from './types'

/** Transaction origin for local, undoable canvas edits. */
export const LOCAL_ORIGIN = 'local-canvas'
/** Transaction origin for local edits that must NOT be undoable (e.g. link preview results). */
export const SYSTEM_ORIGIN = 'local-system'

export const getMeta = (doc: Y.Doc) => doc.getMap<unknown>('meta')
export const getCards = (doc: Y.Doc) => doc.getMap<CardMap>('cards')
/** Legacy trash map (unused since soft-delete); kept so old docs still load. */
export const getTrash = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('trash')

// ---------------------------------------------------------------------------
// Meta

export function initBoardDoc(doc: Y.Doc, meta: Partial<BoardMeta> & { id: string }, userId: string) {
  const m = getMeta(doc)
  if (m.get('id')) return
  doc.transact(() => {
    m.set('id', meta.id)
    m.set('title', meta.title ?? 'Untitled board')
    m.set('icon', meta.icon ?? null)
    m.set('color', meta.color ?? null)
    m.set('parentId', meta.parentId ?? null)
    m.set('createdAt', meta.createdAt ?? Date.now())
    m.set('createdBy', meta.createdBy ?? userId)
    m.set('shared', meta.shared ?? false)
    m.set('relay', meta.relay ?? null)
    if (isBlobHash(meta.cover)) m.set('cover', meta.cover)
    m.set('version', SCHEMA_VERSION)
  }, SYSTEM_ORIGIN)
}

export function readMeta(doc: Y.Doc): BoardMeta {
  const m = getMeta(doc)
  const cover = m.get('cover')
  return {
    id: str(m.get('id'), doc.guid),
    title: str(m.get('title'), 'Untitled board'),
    icon: strOrNull(m.get('icon')),
    color: strOrNull(m.get('color')) as BoardMeta['color'],
    parentId: strOrNull(m.get('parentId')),
    createdAt: num(m.get('createdAt'), 0),
    createdBy: str(m.get('createdBy'), ''),
    shared: m.get('shared') === true,
    relay: strOrNull(m.get('relay')),
    cover: isBlobHash(cover) ? cover : null,
    version: num(m.get('version'), SCHEMA_VERSION),
  }
}

const BLOB_HASH = /^[0-9a-f]{64}$/

/** A blob reference: lowercase SHA-256 hex (see model/blobRefs.ts, which re-exports this). */
export function isBlobHash(v: unknown): v is string {
  return typeof v === 'string' && v.length === 64 && BLOB_HASH.test(v)
}

export function updateMeta(doc: Y.Doc, patch: Partial<BoardMeta>, origin: unknown = LOCAL_ORIGIN) {
  const m = getMeta(doc)
  doc.transact(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'id' || v === undefined) continue
      if (m.get(k) !== v) m.set(k, v)
    }
  }, origin)
}

// ---------------------------------------------------------------------------
// Reading (with sanitising: data may come from untrusted peers)

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d
}
function str(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
function lineEnd(v: unknown): LineEnd {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  return { card: strOrNull(o.card), x: num(o.x, 0), y: num(o.y, 0) }
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(CARD_TYPES)

/** Plain snapshot of a card's primitive fields. Nested Y types are read via getCardYType. */
export function readCard(map: CardMap): Card {
  const raw: Record<string, unknown> = {}
  map.forEach((v, k) => {
    if (!(v instanceof Y.AbstractType)) raw[k] = v
  })
  const type = str(raw.type, 'note') as CardType
  const base = {
    ...raw,
    id: str(raw.id, ''),
    type,
    x: num(raw.x, 0),
    y: num(raw.y, 0),
    w: Math.max(1, num(raw.w, DEFAULT_SIZE[type]?.w ?? 300)),
    h: raw.h === undefined || raw.h === null ? undefined : Math.max(1, num(raw.h, 100)),
    z: num(raw.z, 0),
    parent: strOrNull(raw.parent),
    order: str(raw.order, 'a0'),
    color: strOrNull(raw.color),
    locked: raw.locked === true,
    // Same rule as isUnsortedMap: a column child or a line with the flag (merged peer edits) is not in the drawer.
    unsorted: raw.unsorted === true && strOrNull(raw.parent) === null && type !== 'line',
    trashedAt: typeof raw.trashedAt === 'number' ? raw.trashedAt : null,
    createdAt: num(raw.createdAt, 0),
    createdBy: str(raw.createdBy, ''),
    updatedAt: num(raw.updatedAt, 0),
    updatedBy: str(raw.updatedBy, ''),
  } as Record<string, unknown>
  if (type === 'line') {
    base.from = lineEnd(raw.from)
    base.to = lineEnd(raw.to)
    base.bend = num(raw.bend, 0)
    base.label = str(raw.label, '')
    base.dashed = raw.dashed === true
    base.arrowStart = raw.arrowStart === true
    base.arrowEnd = raw.arrowEnd !== false
    base.thickness = num(raw.thickness, 2)
  }
  return base as unknown as Card
}

/** The card's Y.Map, or undefined when there is none (or a peer wrote something that is not a map). */
export function getCardMap(doc: Y.Doc, id: string): CardMap | undefined {
  return cardIn(getCards(doc), id)
}

function cardIn(cards: Y.Map<CardMap>, id: string): CardMap | undefined {
  const m: unknown = cards.get(id)
  return m instanceof Y.Map ? (m as CardMap) : undefined
}

/** Visits every card map, active or not. Entries that are not Y.Maps (malformed peer data) are skipped. */
export function forEachCardMap(doc: Y.Doc, fn: (m: CardMap, id: string) => void) {
  getCards(doc).forEach((m, id) => {
    if (m instanceof Y.Map) fn(m, id)
  })
}

export function getCardYType<T extends Y.AbstractType<any>>(map: CardMap, field: string): T | null {
  const v = map.get(field)
  return v instanceof Y.AbstractType ? (v as T) : null
}

/** Returns the card's XmlFragment field, creating it if a malformed/old card lacks it. */
export function ensureFragment(doc: Y.Doc, map: CardMap, field: string): Y.XmlFragment {
  const v = map.get(field)
  if (v instanceof Y.XmlFragment) return v
  const frag = new Y.XmlFragment()
  doc.transact(() => map.set(field, frag), SYSTEM_ORIGIN)
  return frag
}

export function ensureArray<T>(doc: Y.Doc, map: CardMap, field: string): Y.Array<T> {
  const v = map.get(field)
  if (v instanceof Y.Array) return v as Y.Array<T>
  const arr = new Y.Array<T>()
  doc.transact(() => map.set(field, arr), SYSTEM_ORIGIN)
  return arr
}

export function maxZ(doc: Y.Doc): number {
  let z = 0
  forEachCardMap(doc, (m) => {
    const v = num(m.get('z'), 0)
    if (v > z) z = v
  })
  return z
}

// ---------------------------------------------------------------------------
// Creating & updating

export type NewCardFields = Partial<Omit<Card, 'type' | 'id'>> & Record<string, unknown>

function makeCardMap(type: CardType, fields: NewCardFields, userId: string, z: number): { id: string; map: CardMap } {
  const id = (typeof fields.id === 'string' && fields.id) || newId()
  const now = Date.now()
  const size = DEFAULT_SIZE[type]
  const map: CardMap = new Y.Map<unknown>()
  const base: Record<string, unknown> = {
    id,
    type,
    x: 0,
    y: 0,
    w: size.w,
    z,
    parent: null,
    order: 'a0',
    color: null,
    createdAt: now,
    createdBy: userId,
    updatedAt: now,
    updatedBy: userId,
  }
  if (size.h !== undefined) base.h = size.h
  switch (type) {
    case 'todo':
      Object.assign(base, { title: '' })
      break
    case 'document':
      Object.assign(base, { title: 'Untitled document' })
      break
    case 'link':
      Object.assign(base, {
        url: '',
        title: '',
        description: '',
        siteName: '',
        imageBlob: null,
        imageUrl: null,
        favicon: null,
        embed: null,
        previewState: 'idle',
      })
      break
    case 'image':
      Object.assign(base, { blob: '', mime: '', name: '', iw: 0, ih: 0 })
      break
    case 'file':
      Object.assign(base, { blob: '', name: '', size: 0, mime: '' })
      break
    case 'board':
      Object.assign(base, { boardId: '', secret: '', title: 'New board', icon: null })
      break
    case 'column':
      Object.assign(base, { title: '', collapsed: false })
      break
    case 'line':
      Object.assign(base, {
        from: { card: null, x: 0, y: 0 },
        to: { card: null, x: 100, y: 0 },
        bend: 0,
        label: '',
        dashed: false,
        arrowStart: false,
        arrowEnd: true,
        thickness: 2,
      })
      break
    case 'comment':
      Object.assign(base, { resolved: false })
      break
    case 'swatch':
      Object.assign(base, { hex: '#7c6cf0', name: '' })
      break
    case 'sketch':
      Object.assign(base, { vw: size.w, vh: size.h ?? 300 })
      break
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && !(v instanceof Y.AbstractType)) base[k] = v
  }
  base.id = id
  base.type = type
  for (const [k, v] of Object.entries(base)) map.set(k, v)
  for (const [field, kind] of Object.entries(CARD_YTYPES[type])) {
    map.set(field, kind === 'xml' ? new Y.XmlFragment() : new Y.Array())
  }
  return { id, map }
}

/** Creates a card on the board and returns its id. */
export function createCard(doc: Y.Doc, type: CardType, fields: NewCardFields, userId: string): string {
  let id = ''
  doc.transact(() => {
    const created = makeCardMap(type, fields, userId, maxZ(doc) + 1)
    id = created.id
    getCards(doc).set(id, created.map)
  }, LOCAL_ORIGIN)
  return id
}

/** Shallow-merges primitive fields into a card. */
export function updateCard(doc: Y.Doc, id: string, patch: Record<string, unknown>, userId: string, origin: unknown = LOCAL_ORIGIN) {
  updateCards(doc, { [id]: patch }, userId, origin)
}

export function updateCards(
  doc: Y.Doc,
  patches: Record<string, Record<string, unknown>>,
  userId: string,
  origin: unknown = LOCAL_ORIGIN,
) {
  const cards = getCards(doc)
  doc.transact(() => {
    for (const [id, patch] of Object.entries(patches)) {
      const m = cardIn(cards, id)
      if (!m) continue
      let changed = false
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'id' || k === 'type') continue
        if (v instanceof Y.AbstractType) continue
        const cur = m.get(k)
        if (cur === v) continue
        if (v === undefined) {
          if (m.has(k)) {
            m.delete(k)
            changed = true
          }
          continue
        }
        if (typeof v === 'object' && v !== null && JSON.stringify(cur) === JSON.stringify(v)) continue
        m.set(k, v)
        changed = true
      }
      if (changed) {
        m.set('updatedAt', Date.now())
        m.set('updatedBy', userId)
      }
    }
  }, origin)
}

/** Lowest z a card is given: lines and their labels are drawn at z-index 0, under every card. */
const MIN_Z = 1

interface Stacked {
  id: string
  z: number
  m: CardMap
}

/** Active cards sorted bottom to top (z, then id, so every peer agrees on ties). */
function stackOrder(doc: Y.Doc): Stacked[] {
  const out: Stacked[] = []
  forEachActiveCard(doc, (m, id) => out.push({ id, z: num(m.get('z'), 0), m }))
  out.sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** Brings cards above every other active card, keeping their order among themselves. */
export function bringToFront(doc: Y.Doc, ids: string[], userId: string) {
  const wanted = new Set(ids)
  const order = stackOrder(doc)
  const sel = order.filter((s) => wanted.has(s.id))
  if (!sel.length) return
  const rest = order.filter((s) => !wanted.has(s.id))
  // Already on top, in this order? Avoid churn (this runs at the start of every drag). Trashed
  // cards do not count: they are not drawn.
  const distinct = sel.every((s, i) => i === 0 || s.z > sel[i - 1].z)
  if (distinct && (!rest.length || sel[0].z > rest[rest.length - 1].z)) return
  let z = maxZ(doc)
  const patches: Record<string, Record<string, unknown>> = {}
  for (const s of sel) patches[s.id] = { z: ++z }
  updateCards(doc, patches, userId)
}

/** Sends cards below every other active card, keeping their order among themselves. */
export function sendToBack(doc: Y.Doc, ids: string[], userId: string) {
  const wanted = new Set(ids)
  const order = stackOrder(doc)
  const sel = order.filter((s) => wanted.has(s.id))
  if (!sel.length) return
  const rest = order.filter((s) => !wanted.has(s.id))
  // Already at the bottom, in this order? Avoid churn.
  const distinct = sel.every((s, i) => i === 0 || s.z > sel[i - 1].z)
  if (distinct && (!rest.length || sel[sel.length - 1].z < rest[0].z)) return
  const n = sel.length
  const patches: Record<string, Record<string, unknown>> = {}
  if (order[0].z - n >= MIN_Z) {
    let z = order[0].z - n
    for (const s of sel) patches[s.id] = { z: z++ }
  } else {
    // Cards are painted with z-index = z above the lines layer (z-index 0): never go below MIN_Z.
    // The selection takes the lowest slots and everything else moves up just enough, in the same step.
    sel.forEach((s, i) => (patches[s.id] = { z: MIN_Z + i }))
    const shift = rest.length ? Math.max(0, MIN_Z + n - rest[0].z) : 0
    if (shift) for (const s of rest) patches[s.id] = { z: s.z + shift }
  }
  updateCards(doc, patches, userId)
}

export type CardRect = { x: number; y: number; w: number; h: number }
/** Rendered rect of a card in board units, or null when it is not drawn on the canvas. */
export type RectOf = (id: string) => CardRect | null

function validRect(r: CardRect | null): CardRect | null {
  if (!r || ![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) return null
  return r
}

function overlaps(a: CardRect, b: CardRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * Cards stacked on the canvas itself: not inside a column, not in the Unsorted drawer, not lines
 * (drawn in a layer below every card, whatever their z) and not comments pinned to a card (drawn as
 * markers on it, or hidden with it in the drawer).
 */
function stacksOnCanvas(m: CardMap, id: string, lookup: ParkLookup): boolean {
  if (strOrNull(m.get('parent')) !== null || m.get('unsorted') === true || m.get('type') === 'line') return false
  const view = lookup(id)
  return !!view && pinTargetIn(lookup, id, view) === null
}

/**
 * Moves each selected card one step up (dir 1) or down (dir -1): just past the nearest card
 * above (below) it that it overlaps. Cards without such a neighbour stay. The selected cards keep
 * their order among themselves, and every other pair of cards keeps its stacking: the cards a
 * moved card passes shift by one slot, reusing the z values already there.
 */
function stepZ(doc: Y.Doc, ids: string[], userId: string, rectOf: RectOf, dir: 1 | -1) {
  const wanted = new Set(ids)
  const order = stackOrder(doc)
  const n = order.length
  const rects = new Map<string, CardRect>()
  const lookup = docParkLookup(doc)
  for (const s of order) {
    if (!stacksOnCanvas(s.m, s.id, lookup)) continue
    let r: CardRect | null = null
    try {
      r = validRect(rectOf(s.id))
    } catch {
      r = null
    }
    if (r) rects.set(s.id, r)
  }
  const keys = order.map((_, i) => i)
  const moving = order.map((s, i) => (wanted.has(s.id) && rects.has(s.id) ? i : -1)).filter((i) => i >= 0)
  if (!moving.length) return
  // Topmost first going up (bottommost first going down), so a card never overtakes another selected one.
  if (dir === 1) moving.reverse()
  let fence = dir === 1 ? Infinity : -Infinity
  let moved = false
  for (const i of moving) {
    const rect = rects.get(order[i].id)!
    let target = -1
    for (let j = i + dir; j >= 0 && j < n; j += dir) {
      const other = rects.get(order[j].id)
      if (!wanted.has(order[j].id) && other && overlaps(rect, other)) {
        target = j
        break
      }
    }
    // Fractions keep several cards landing past the same neighbour in their original order.
    const key = target < 0 ? i : dir === 1 ? target + (i + 1) / (2 * (n + 1)) : target - 1 + (i + 1) / (2 * (n + 1))
    if (target >= 0 && (dir === 1 ? key < fence : key > fence)) {
      keys[i] = key
      moved = true
    }
    fence = keys[i]
  }
  if (!moved) return
  const next = order.map((_, i) => i).sort((a, b) => keys[a] - keys[b])
  let lo = 0
  while (lo < n && next[lo] === lo) lo++
  let hi = n - 1
  while (hi >= 0 && next[hi] === hi) hi--
  if (lo > hi) return
  // The reordered slots reuse their z values. Ties (peer data) are made strict, bumping the cards
  // above the range only as far as needed.
  const patches: Record<string, Record<string, unknown>> = {}
  let prev = lo > 0 ? order[lo - 1].z : -Infinity
  for (let p = lo; p <= hi; p++) {
    const s = order[next[p]]
    const z = Math.max(order[p].z, prev + 1)
    if (z !== s.z) patches[s.id] = { z }
    prev = z
  }
  for (let p = hi + 1; p < n && order[p].z <= prev; p++) {
    prev += 1
    patches[order[p].id] = { z: prev }
  }
  if (Object.keys(patches).length) updateCards(doc, patches, userId)
}

/** Brings each card just above the nearest overlapping card above it (one step forward). */
export function bringForward(doc: Y.Doc, ids: string[], userId: string, rectOf: RectOf) {
  stepZ(doc, ids, userId, rectOf, 1)
}

/** Sends each card just below the nearest overlapping card below it (one step backward). */
export function sendBackward(doc: Y.Doc, ids: string[], userId: string, rectOf: RectOf) {
  stepZ(doc, ids, userId, rectOf, -1)
}

// ---------------------------------------------------------------------------
// Columns

/** Ids of cards inside a column, sorted by `order` (ties broken by id). */
export function columnChildren(doc: Y.Doc, columnId: string): string[] {
  const out: { id: string; order: string }[] = []
  forEachCardMap(doc, (m, id) => {
    if (m.get('parent') === columnId && !isTrashed(m)) out.push({ id, order: str(m.get('order'), 'a0') })
  })
  out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
  return out.map((o) => o.id)
}

/** True for an order key that `fractional-indexing` accepts. Keys written by peers are not trusted. */
export function isValidOrderKey(k: unknown): k is string {
  if (typeof k !== 'string' || !k || k.length > 200) return false
  try {
    generateKeyBetween(k, null)
    return true
  } catch {
    return false
  }
}

/** A key sorting between `a` and `b`; invalid or out-of-order bounds are ignored instead of throwing. */
function keyBetween(a: string | null, b: string | null): string {
  const lo = isValidOrderKey(a) ? a : null
  let hi = isValidOrderKey(b) ? b : null
  if (lo && hi && hi <= lo) hi = null
  try {
    return generateKeyBetween(lo, hi)
  } catch {
    try {
      return generateKeyBetween(lo, null)
    } catch {
      return generateKeyBetween(null, null)
    }
  }
}

/** Current order keys of sorted siblings, or null when they cannot be extended safely (invalid or duplicate keys). */
function siblingKeys(cards: Y.Map<CardMap>, siblings: string[]): string[] | null {
  const keys = siblings.map((id) => cardIn(cards, id)?.get('order'))
  for (let i = 0; i < keys.length; i++) {
    if (!isValidOrderKey(keys[i])) return null
    if (i > 0 && (keys[i] as string) <= (keys[i - 1] as string)) return null
  }
  return keys as string[]
}

// ---------------------------------------------------------------------------
// Unsorted drawer (helpers for model/unsorted.ts, kept here so moveCardsToBoard can use them)

/**
 * A top-level card in the board's Unsorted drawer: `unsorted` is literally true, it is not in a
 * column and not trashed. Lines are never drawer cards (they stay on the canvas).
 */
export function isUnsortedMap(m: CardMap): boolean {
  return m.get('unsorted') === true && strOrNull(m.get('parent')) === null && !isTrashed(m) && m.get('type') !== 'line'
}

/** What isParked needs to know about an active card. A board/cardIndex IndexedCard fits. */
export interface ParkView {
  readonly type: string
  readonly parent: string | null
  /** In the drawer itself, as readCard reports it (which agrees with isUnsortedMap). */
  readonly unsorted: boolean
  /** The card's fields: `attachedTo` of a comment, `from` / `to` of a line. */
  readonly card: object
}

/** Looks up an active card (undefined for trashed or missing ones), e.g. `(id) => index.get(id)`. */
export type ParkLookup = (id: string) => ParkView | null | undefined

/** Ids that may be stored in a comment's `attachedTo` (the same rule as cards/structure/attach.ts). */
const ATTACH_ID = /^[A-Za-z0-9_-]{1,64}$/

function isAttachableType(t: unknown): boolean {
  return typeof t === 'string' && KNOWN_TYPES.has(t) && t !== 'comment' && t !== 'line'
}

function docParkLookup(doc: Y.Doc): ParkLookup {
  const cards = getCards(doc)
  return (id) => {
    const m = cardIn(cards, id)
    if (!m || isTrashed(m)) return undefined
    const type = str(m.get('type'), 'note')
    return {
      type,
      parent: strOrNull(m.get('parent')),
      unsorted: isUnsortedMap(m),
      card: type === 'line' ? { from: lineEnd(m.get('from')), to: lineEnd(m.get('to')) } : { attachedTo: m.get('attachedTo') },
    }
  }
}

/** The card a comment is pinned to: another active card that can carry comments. Null for anything else. */
function pinTargetIn(lookup: ParkLookup, id: string, c: ParkView): string | null {
  if (c.type !== 'comment') return null
  const target = (c.card as { attachedTo?: unknown }).attachedTo
  if (typeof target !== 'string' || target === id || !ATTACH_ID.test(target)) return null
  const t = lookup(target)
  return t && isAttachableType(t.type) ? target : null
}

/** The drawer card hiding `id` (see isParked), or null. */
function parkedBy(lookup: ParkLookup, id: string, depth: number): string | null {
  const c = depth > 3 ? null : lookup(id)
  if (!c) return null
  if (c.unsorted) return id
  if (c.parent) {
    const col = lookup(c.parent)
    if (col && col.type === 'column' && col.unsorted) return c.parent
  }
  if (c.type === 'line') {
    const ends = c.card as { from?: unknown; to?: unknown }
    for (const end of [ends.from, ends.to]) {
      const card = end && typeof end === 'object' ? (end as { card?: unknown }).card : null
      const by = typeof card === 'string' && card !== id ? parkedBy(lookup, card, depth + 1) : null
      if (by) return by
    }
    return null
  }
  const target = pinTargetIn(lookup, id, c)
  return target === null ? null : parkedBy(lookup, target, depth + 1)
}

const parkLookupOf = (src: Y.Doc | ParkLookup): ParkLookup => (src instanceof Y.Doc ? docParkLookup(src) : src)

/**
 * Hidden together with the Unsorted drawer: the card is in the drawer, or its column is, or it is a
 * comment pinned to (or a line ending on) such a card. Parked cards are not drawn on the canvas and
 * keep their attachment, so they come back with their card instead of turning into free cards.
 */
export function isParked(src: Y.Doc | ParkLookup, id: string): boolean {
  return parkedBy(parkLookupOf(src), id, 0) !== null
}

/** The drawer card a parked card is hidden with (itself, its column, or the card it belongs to), or null. */
export function drawerCardOf(src: Y.Doc | ParkLookup, id: string): string | null {
  return parkedBy(parkLookupOf(src), id, 0)
}

/** Ids of the drawer cards in drawer order (`order` key, ties broken by id). */
export function unsortedIds(doc: Y.Doc): string[] {
  const out: { id: string; order: string }[] = []
  forEachActiveCard(doc, (m, id) => {
    if (isUnsortedMap(m)) out.push({ id, order: str(m.get('order'), 'a0') })
  })
  out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : 1))
  return out.map((o) => o.id)
}

/** `count` consecutive order keys after the last drawer card (malformed peer keys are skipped). */
export function unsortedTailKeys(doc: Y.Doc, count: number): string[] {
  if (count <= 0) return []
  let tail: string | null = null
  forEachActiveCard(doc, (m) => {
    if (!isUnsortedMap(m)) return
    const k = m.get('order')
    if (isValidOrderKey(k) && (tail === null || k > tail)) tail = k
  })
  try {
    return generateNKeysBetween(tail, null, count)
  } catch {
    return generateNKeysBetween(null, null, count)
  }
}

/** Fractional key placing a card at `index` among `siblings` (already sorted, excluding the moved card). */
export function orderKeyAt(doc: Y.Doc, siblings: string[], index: number): string {
  const cards = getCards(doc)
  const before = index > 0 ? strOrNull(cardIn(cards, siblings[index - 1])?.get('order')) : null
  const after = index < siblings.length ? strOrNull(cardIn(cards, siblings[index])?.get('order')) : null
  return keyBetween(before, after)
}

function isLiveColumn(cards: Y.Map<CardMap>, id: string): boolean {
  const m = cardIn(cards, id)
  return !!m && m.get('type') === 'column' && !isTrashed(m)
}

/**
 * Moves cards into a column at `index`, preserving their relative order. If the column's existing
 * keys are malformed or duplicated (peer data, concurrent inserts), its children are re-keyed first.
 */
export function insertIntoColumn(doc: Y.Doc, ids: string[], columnId: string, index: number, userId: string) {
  const cards = getCards(doc)
  if (!isLiveColumn(cards, columnId)) return
  const movable = ids.filter((id) => {
    const m = cardIn(cards, id)
    const t = m?.get('type')
    return id !== columnId && !!m && !isTrashed(m) && typeof t === 'string' && COLUMN_CHILD_TYPES.has(t as CardType)
  })
  if (!movable.length) return
  doc.transact(() => {
    const siblings = columnChildren(doc, columnId).filter((id) => !movable.includes(id))
    const patches: Record<string, Record<string, unknown>> = {}
    let keys = siblingKeys(cards, siblings)
    if (!keys) {
      keys = generateNKeysBetween(null, null, siblings.length)
      siblings.forEach((id, i) => (patches[id] = { order: keys![i] }))
    }
    const clamped = Math.max(0, Math.min(index, siblings.length))
    let prev = clamped > 0 ? keys[clamped - 1] : null
    const after = clamped < keys.length ? keys[clamped] : null
    for (const id of movable) {
      const key = keyBetween(prev, after)
      // A stale drawer flag (merged peer edits) would send the card to the drawer once it leaves the column.
      patches[id] = { parent: columnId, order: key, unsorted: undefined }
      prev = key
    }
    updateCards(doc, patches, userId)
  }, LOCAL_ORIGIN)
}

/** Takes cards out of their column and places them freely at the given positions. */
export function placeOnCanvas(doc: Y.Doc, positions: Record<string, { x: number; y: number }>, userId: string) {
  const patches: Record<string, Record<string, unknown>> = {}
  for (const [id, p] of Object.entries(positions)) patches[id] = { parent: null, unsorted: undefined, x: Math.round(p.x), y: Math.round(p.y) }
  updateCards(doc, patches, userId)
}

// ---------------------------------------------------------------------------
// Deleting, trash and restore
//
// Deletion is SOFT: cards stay in the `cards` map with trashedAt/trashedBy/trashGroup set.
// A hard Y.Map.delete would silently discard a teammate's concurrent edits inside the card;
// a soft delete keeps them, and restoring is just clearing the fields.

/** Fields written when a card is deleted or moved away. Restoring removes all of them. */
export const REMOVAL_KEYS = ['trashedAt', 'trashedBy', 'trashGroup', 'movedTo', 'movedId', 'movedState', 'editedAfterMove'] as const

/** Deleted (in trash) or moved away to another board. Such cards are not shown on the canvas. */
export function isTrashed(m: CardMap): boolean {
  return typeof m.get('trashedAt') === 'number'
}

/** Hidden because it was moved to another board (or otherwise removed without a trash entry). */
export function isMovedAway(m: CardMap): boolean {
  return isTrashed(m) && !!m.get('movedTo')
}

/** Visits every card that is on the board (not trashed). */
export function forEachActiveCard(doc: Y.Doc, fn: (m: CardMap, id: string) => void) {
  getCards(doc).forEach((m, id) => {
    if (m instanceof Y.Map && !isTrashed(m)) fn(m, id)
  })
}

/**
 * Expands a set of ids with column children, comments attached to any of them and lines attached
 * to any of them (active cards only), so delete, move, duplicate and copy take them along.
 */
export function expandSelection(doc: Y.Doc, ids: Iterable<string>): Set<string> {
  const set = new Set<string>()
  for (const id of ids) {
    const m = getCardMap(doc, id)
    if (m && !isTrashed(m)) set.add(id)
  }
  // column children
  forEachActiveCard(doc, (m, id) => {
    const p = m.get('parent')
    if (typeof p === 'string' && set.has(p)) set.add(id)
  })
  // attached comments (after column children: a comment may be pinned to a card inside a column)
  forEachActiveCard(doc, (m, id) => {
    if (m.get('type') !== 'comment') return
    const target = m.get('attachedTo')
    if (typeof target === 'string' && set.has(target)) set.add(id)
  })
  // attached lines (last: a line may end on an attached comment)
  forEachActiveCard(doc, (m, id) => {
    if (m.get('type') !== 'line') return
    const f = lineEnd(m.get('from'))
    const t = lineEnd(m.get('to'))
    if ((f.card && set.has(f.card)) || (t.card && set.has(t.card))) set.add(id)
  })
  return set
}

/**
 * Flags exactly the given (active) cards as removed in one trash group. With `movedTo`, the cards
 * are hidden instead of listed in the trash, and a fingerprint of their content is kept so edits
 * that arrive after the move can be detected (see rescueMovedCards).
 */
function markRemoved(
  doc: Y.Doc,
  ids: Iterable<string>,
  userId: string,
  movedTo: string | null,
  opts: { movedIds?: ReadonlyMap<string, string>; origin?: unknown } = {},
): string | null {
  const cards = getCards(doc)
  const targets = Array.from(new Set(ids)).filter((id) => {
    const m = cardIn(cards, id)
    return !!m && !isTrashed(m)
  })
  if (!targets.length) return null
  const group = newId()
  const now = Date.now()
  doc.transact(() => {
    for (const id of targets) {
      const m = cardIn(cards, id)!
      const state = movedTo !== null ? cardContentState(m) : null
      m.set('trashedAt', now)
      m.set('trashedBy', userId)
      m.set('trashGroup', group)
      if (movedTo !== null) {
        m.set('movedTo', movedTo)
        m.set('movedState', state)
        const target = opts.movedIds?.get(id)
        if (target) m.set('movedId', target)
      }
    }
  }, opts.origin ?? LOCAL_ORIGIN)
  return group
}

/**
 * Moves cards (plus column children and attached lines) to the board trash.
 * Returns the trash entry (group) id, or null if nothing was deleted.
 */
export function deleteCards(doc: Y.Doc, ids: Iterable<string>, userId: string): string | null {
  return markRemoved(doc, expandSelection(doc, ids), userId, null)
}

/**
 * Removes cards that were moved to another board (kept hidden for a while, never listed in trash
 * unless someone edits them after the removal). Returns the group id, or null.
 */
export function removeCards(doc: Y.Doc, ids: Iterable<string>, userId = '', movedTo = 'elsewhere'): string | null {
  return markRemoved(doc, expandSelection(doc, ids), userId, movedTo)
}

export interface TrashEntry {
  id: string
  deletedAt: number
  deletedBy: string
  cards: Card[]
}

export function listTrash(doc: Y.Doc): TrashEntry[] {
  const groups = new Map<string, TrashEntry>()
  forEachCardMap(doc, (m, id) => {
    if (!isTrashed(m) || m.get('movedTo')) return
    const g = str(m.get('trashGroup'), id)
    let e = groups.get(g)
    if (!e) {
      e = { id: g, deletedAt: num(m.get('trashedAt'), 0), deletedBy: str(m.get('trashedBy'), ''), cards: [] }
      groups.set(g, e)
    }
    e.cards.push(readCard(m))
  })
  return Array.from(groups.values()).sort((a, b) => b.deletedAt - a.deletedAt)
}

/** Listed (not moved-away) trashed cards of one trash entry. */
function groupIds(doc: Y.Doc, group: string): string[] {
  const ids: string[] = []
  forEachCardMap(doc, (m, id) => {
    if (isTrashed(m) && !m.get('movedTo') && str(m.get('trashGroup'), id) === group) ids.push(id)
  })
  return ids
}

/** Restores a trash entry. Hidden moved-away copies that share the group are never brought back. */
export function restoreTrashEntry(doc: Y.Doc, entryId: string, userId: string): string[] {
  const ids = groupIds(doc, entryId)
  if (!ids.length) return []
  const cards = getCards(doc)
  const inGroup = new Set(ids)
  doc.transact(() => {
    let z = maxZ(doc)
    const now = Date.now()
    for (const id of ids) {
      const m = cardIn(cards, id)!
      for (const k of REMOVAL_KEYS) if (m.has(k)) m.delete(k)
      // A child whose column is gone becomes a free card.
      const parent = strOrNull(m.get('parent'))
      if (parent && !inGroup.has(parent) && !isLiveColumn(cards, parent)) m.set('parent', null)
      m.set('z', ++z)
      m.set('updatedAt', now)
      m.set('updatedBy', userId)
    }
  }, LOCAL_ORIGIN)
  return ids
}

/** Permanently deletes one trash entry. */
export function purgeTrashEntry(doc: Y.Doc, entryId: string) {
  const ids = groupIds(doc, entryId)
  const cards = getCards(doc)
  doc.transact(() => ids.forEach((id) => cards.delete(id)), LOCAL_ORIGIN)
}

/** Permanently deletes everything in the trash (and hidden moved-away copies). */
export function emptyTrash(doc: Y.Doc) {
  const cards = getCards(doc)
  const ids: string[] = []
  forEachCardMap(doc, (m, id) => {
    if (isTrashed(m)) ids.push(id)
  })
  doc.transact(() => ids.forEach((id) => cards.delete(id)), LOCAL_ORIGIN)
}

export const TRASH_RETENTION_MS = 90 * 24 * 3600 * 1000
export const MOVED_RETENTION_MS = 30 * 24 * 3600 * 1000

/** Trash group of a removed card (cards without a valid group form their own). */
export function trashGroupOf(m: CardMap, id: string): string {
  const g = m.get('trashGroup')
  return typeof g === 'string' && g ? g : id
}

/** Every trash group present in the doc (listed entries and hidden moved-away groups). */
export function trashGroups(doc: Y.Doc): Set<string> {
  const out = new Set<string>()
  forEachCardMap(doc, (m, id) => {
    if (isTrashed(m)) out.add(trashGroupOf(m, id))
  })
  return out
}

/**
 * Permanently removes trash older than the retention period. Idempotent, safe to run on every
 * peer; a 2-day grace absorbs small clock skew between devices.
 *
 * `trashedAt` was written by the deleting device's clock, which may be wrong. `firstSeen` (when
 * this device first noticed the group, by its own clock) makes the age local: a group is only
 * purged once it is older than the retention period by both measures. Future timestamps count as now.
 */
export function purgeExpiredTrash(doc: Y.Doc, now = Date.now(), firstSeen?: (group: string) => number | undefined) {
  const cards = getCards(doc)
  const grace = 2 * 24 * 3600 * 1000
  const ids: string[] = []
  forEachCardMap(doc, (m, id) => {
    if (!isTrashed(m)) return
    const at = Math.min(num(m.get('trashedAt'), now), now)
    const seen = firstSeen?.(trashGroupOf(m, id))
    const since = seen !== undefined && Number.isFinite(seen) ? Math.max(at, Math.min(seen, now)) : at
    const limit = (m.get('movedTo') ? MOVED_RETENTION_MS : TRASH_RETENTION_MS) + grace
    if (now - since > limit) ids.push(id)
  })
  if (ids.length) doc.transact(() => ids.forEach((id) => cards.delete(id)), SYSTEM_ORIGIN)
}

// ---------------------------------------------------------------------------
// Edits that land on a moved-away card
//
// Moving cards to another board copies them and hides the originals (`movedTo`). A teammate who
// was offline (or typing at that moment) may still edit the original; those edits never reach the
// copy. Each hidden card keeps a fingerprint of its content at move time (`movedState`): the highest
// Yjs clock per client inside the card, plus the number of live items. Any later insertion has a
// higher clock, any later deletion lowers the count, so every peer can tell deterministically,
// whenever it sees the card, that it was changed after the move, and turn it back into a normal
// trash entry ("edited after it was moved") that can be restored instead of silently expiring.

/** Content fingerprint of a card (see above). */
export interface CardContentState {
  /** Highest clock (exclusive) per Yjs client id among the card's content items. */
  c: Record<string, number>
  /** Number of live (not deleted) content items. */
  n: number
}

/** Top-level fields that are not the card's content: layout, bookkeeping and removal markers. */
const NON_CONTENT_KEYS: ReadonlySet<string> = new Set([
  'id',
  'type',
  'x',
  'y',
  'z',
  'w',
  'h',
  'parent',
  'order',
  'color',
  'locked',
  'unsorted',
  'attachedTo',
  'createdAt',
  'createdBy',
  'updatedAt',
  'updatedBy',
  ...REMOVAL_KEYS,
])
/** Fields some card types copy from elsewhere (child board meta, link previews) rather than from the user. */
const DERIVED_KEYS: Partial<Record<string, ReadonlySet<string>>> = {
  board: new Set(['title', 'icon', 'childCount']),
  link: new Set(['title', 'description', 'siteName', 'imageBlob', 'imageUrl', 'favicon', 'embed', 'previewState', 'previewBy', 'previewFor']),
}

function isContentKey(type: unknown, key: string): boolean {
  if (NON_CONTENT_KEYS.has(key)) return false
  return !(typeof type === 'string' && DERIVED_KEYS[type]?.has(key))
}

/** Computes the content fingerprint of a card map. */
export function cardContentState(m: CardMap): CardContentState {
  const c: Record<string, number> = {}
  let n = 0
  const visit = (s: unknown) => {
    if (!(s instanceof Y.Item)) return
    const k = String(s.id.client)
    const end = s.id.clock + s.length
    if ((c[k] ?? 0) < end) c[k] = end
    if (!s.deleted) n += s.length
    if (s.content instanceof Y.ContentType) visitType(s.content.type)
  }
  const visitType = (t: Y.AbstractType<any>) => {
    t._map.forEach((item) => visit(item))
    for (let it = t._start; it; it = it.right) visit(it)
  }
  const type = m.get('type')
  m._map.forEach((item, key) => {
    if (isContentKey(type, key)) visit(item)
  })
  return { c, n }
}

function parseContentState(v: unknown): CardContentState | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.n !== 'number' || !Number.isFinite(o.n) || !o.c || typeof o.c !== 'object') return null
  const c: Record<string, number> = {}
  for (const [k, end] of Object.entries(o.c as Record<string, unknown>)) {
    if (typeof end === 'number' && Number.isFinite(end)) c[k] = end
  }
  return { c, n: o.n }
}

/** True when the card's content changed since `base` was taken. Unknown/malformed baselines count as unchanged. */
export function cardChangedSince(m: CardMap, base: unknown): boolean {
  const b = parseContentState(base)
  if (!b) return false
  const now = cardContentState(m)
  if (now.n !== b.n) return true
  for (const [k, end] of Object.entries(now.c)) if (end > (b.c[k] ?? 0)) return true
  return false
}

/** Ids of moved-away cards (all, or among `ids`) whose content changed after they were moved. */
export function findEditedMovedCards(doc: Y.Doc, ids?: Iterable<string>): string[] {
  const out: string[] = []
  const check = (m: CardMap, id: string) => {
    if (isMovedAway(m) && cardChangedSince(m, m.get('movedState'))) out.push(id)
  }
  if (ids) {
    for (const id of new Set(ids)) {
      const m = getCardMap(doc, id)
      if (m) check(m, id)
    }
  } else forEachCardMap(doc, check)
  return out
}

/** Suffix of the trash group given to cards that were edited after they were moved away. */
export const EDITED_GROUP_SUFFIX = '-edited'

/**
 * Turns moved-away cards back into ordinary (listed, restorable) trash entries, marked with
 * `editedAfterMove: <board they were moved to>`. Cards rescued from the same move share an entry;
 * the group id is derived, so peers that rescue concurrently agree on it. Not undoable.
 */
export function rescueMovedCards(doc: Y.Doc, ids: Iterable<string>): string[] {
  const out: string[] = []
  const cards = getCards(doc)
  doc.transact(() => {
    const now = Date.now()
    for (const id of new Set(ids)) {
      const m = cardIn(cards, id)
      if (!m || !isMovedAway(m)) continue
      const movedTo = m.get('movedTo')
      const group = trashGroupOf(m, id)
      for (const k of ['movedTo', 'movedState', 'movedId']) if (m.has(k)) m.delete(k)
      m.set('trashGroup', group.endsWith(EDITED_GROUP_SUFFIX) ? group : group + EDITED_GROUP_SUFFIX)
      m.set('trashedAt', now)
      m.set('editedAfterMove', typeof movedTo === 'string' ? movedTo : '')
      out.push(id)
    }
  }, SYSTEM_ORIGIN)
  return out
}

/** Locates the card (and its top-level field) a deep event belongs to. */
function locateCardChange(cards: Y.Map<CardMap>, target: Y.AbstractType<any>): { id: string; map: CardMap; field: string | null } | null {
  let t: Y.AbstractType<any> | null = target
  let child: Y.AbstractType<any> | null = null
  while (t && t.parent && t.parent !== cards) {
    child = t
    t = t.parent as Y.AbstractType<any>
  }
  if (!(t instanceof Y.Map) || t.parent !== cards) return null
  const id = t._item?.parentSub
  if (typeof id !== 'string') return null
  return { id, map: t as CardMap, field: child ? (child._item?.parentSub ?? null) : null }
}

/**
 * Keeps edits that land on moved-away cards: rescues the ones already changed, then watches every
 * later transaction. Cards hidden before fingerprints existed are rescued when their content changes.
 * Returns the unsubscribe function.
 */
export function watchMovedCards(doc: Y.Doc): () => void {
  const cards = getCards(doc)
  const initial = findEditedMovedCards(doc)
  if (initial.length) rescueMovedCards(doc, initial)
  const onDeep = (events: Y.YEvent<any>[]) => {
    const fingerprinted = new Set<string>()
    const legacy = new Set<string>()
    for (const ev of events) {
      if (ev.target === cards) continue
      const hit = locateCardChange(cards, ev.target)
      if (!hit || !isMovedAway(hit.map)) continue
      if (hit.map.get('movedState') !== undefined) {
        fingerprinted.add(hit.id)
        continue
      }
      const type = hit.map.get('type')
      const fields = hit.field !== null ? [hit.field] : ev.target === hit.map ? Array.from((ev as Y.YMapEvent<unknown>).keysChanged) : []
      if (fields.some((f) => isContentKey(type, f))) legacy.add(hit.id)
    }
    const edited = [...findEditedMovedCards(doc, fingerprinted), ...legacy]
    if (edited.length) rescueMovedCards(doc, edited)
  }
  cards.observeDeep(onDeep)
  return () => cards.unobserveDeep(onDeep)
}

// ---------------------------------------------------------------------------
// Cloning (duplicate, copy/paste, move between boards)

/**
 * A card detached from any doc: plain fields plus cloned (not yet integrated) nested Y types.
 * Yjs types that are not integrated cannot be read back, so the plain fields travel separately.
 */
export interface DetachedCard {
  data: Record<string, unknown>
  nested: Record<string, Y.AbstractType<any>>
  /** Id of the card this one was copied from (to look up its measured size). */
  sourceId?: string
  /**
   * Set when the card sat in a column that is not part of the group: its stored x/y are stale
   * (ignored while it was in the column), so it is stacked at the target instead.
   */
  orphan?: { order: string }
}

/** Snapshot of an integrated card map. */
export function detachCard(m: CardMap): DetachedCard {
  const data: Record<string, unknown> = {}
  const nested: Record<string, Y.AbstractType<any>> = {}
  m.forEach((v, k) => {
    if (v instanceof Y.AbstractType) nested[k] = v.clone()
    else data[k] = v
  })
  const id = m.get('id')
  return typeof id === 'string' ? { data, nested, sourceId: id } : { data, nested }
}

/** Builds a fresh (prelim) Y.Map from a detached card. Each DetachedCard may be attached once. */
export function attachCard(d: DetachedCard): CardMap {
  const m: CardMap = new Y.Map<unknown>()
  for (const [k, v] of Object.entries(d.data)) if (v !== undefined) m.set(k, v)
  for (const [k, v] of Object.entries(d.nested)) m.set(k, v)
  return m
}

/**
 * Whether an integrated card that is being copied without its parent was shown inside a live column.
 * A parent missing from the card's own doc means it came from a clipboard snapshot, which only keeps
 * the parent when it was a live column.
 */
function wasInLiveColumn(m: CardMap, parent: string): boolean {
  const owner = m.parent
  if (!(owner instanceof Y.Map)) return false
  const pm: unknown = owner.get(parent)
  if (pm === undefined) return true
  return pm instanceof Y.Map && pm.get('type') === 'column' && !isTrashed(pm as CardMap)
}

/**
 * Deep-clones the given (integrated) cards with fresh ids, remapping column parents, line endpoints
 * and comment attachments. A comment whose card is not part of the group becomes a free comment.
 */
export function cloneCardsWithNewIds(sourceMaps: CardMap[]): { cards: DetachedCard[]; idMap: Map<string, string> } {
  const idMap = new Map<string, string>()
  for (const m of sourceMaps) idMap.set(str(m.get('id'), ''), newId())
  const out: DetachedCard[] = []
  for (const m of sourceMaps) {
    const d = detachCard(m)
    d.data.id = idMap.get(str(m.get('id'), ''))!
    const parent = strOrNull(d.data.parent)
    if (parent) {
      const mapped = idMap.get(parent)
      d.data.parent = mapped ?? null
      if (!mapped && wasInLiveColumn(m, parent)) d.orphan = { order: str(d.data.order, 'a0') }
    }
    if (d.data.type === 'line') {
      for (const end of ['from', 'to'] as const) {
        const e = lineEnd(d.data[end])
        d.data[end] = e.card ? { ...e, card: idMap.get(e.card) ?? null } : e
      }
    }
    if (d.data.type === 'comment' && d.data.attachedTo !== undefined) {
      const target = strOrNull(d.data.attachedTo)
      d.data.attachedTo = (target && idMap.get(target)) ?? null
    }
    out.push(d)
  }
  return { cards: out, idMap }
}

/** Top-left of the given cards (lines contribute their free end points), ignoring cards inside columns. */
function groupOrigin(cards: DetachedCard[]): { x: number; y: number } {
  let x = Infinity
  let y = Infinity
  for (const { data } of cards) {
    if (strOrNull(data.parent)) continue
    if (data.type === 'line') {
      for (const end of ['from', 'to'] as const) {
        const e = lineEnd(data[end])
        if (!e.card) {
          x = Math.min(x, e.x)
          y = Math.min(y, e.y)
        }
      }
      continue
    }
    x = Math.min(x, num(data.x, 0))
    y = Math.min(y, num(data.y, 0))
  }
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

export interface InsertOptions {
  /**
   * Rendered height (board units) of the card a detached card was copied from, if known. Used to
   * stack cards that leave their column; stored heights or an estimate are used otherwise.
   */
  heightOf?: (sourceId: string) => number | undefined
}

/** Fallback height of a card that leaves a column and was never measured. */
const ORPHAN_HEIGHT = 120
const STACK_GAP = 10

/**
 * Inserts detached cards into a doc so the group's top-left lands at `at` (null = keep positions).
 * Children whose column is not part of the group become free cards: those that came out of a live
 * column are stacked vertically (their stored positions are stale). Returns the inserted ids.
 */
export function insertClonedCards(
  doc: Y.Doc,
  group: DetachedCard[],
  at: { x: number; y: number } | null,
  userId: string,
  opts: InsertOptions = {},
): string[] {
  const cards = getCards(doc)
  const valid = group.filter((d) => typeof d.data.id === 'string' && d.data.id && typeof d.data.type === 'string')
  const ids = new Set(valid.map((d) => d.data.id as string))
  for (const d of valid) {
    const parent = strOrNull(d.data.parent)
    if (parent && !ids.has(parent) && !cardIn(cards, parent)) d.data.parent = null
  }
  const free = valid.filter((d) => !strOrNull(d.data.parent) && !d.orphan)
  const orphans = valid.filter((d) => !strOrNull(d.data.parent) && d.orphan)
  const origin = groupOrigin(free.length ? free : orphans)
  const dx = at ? at.x - origin.x : 0
  const dy = at ? at.y - origin.y : 0

  // A comment pinned to a card that does not come along (and is not already here) becomes free.
  for (const d of valid) {
    if (d.data.type !== 'comment' || d.data.attachedTo === undefined) continue
    const target = strOrNull(d.data.attachedTo)
    if (!target || !(ids.has(target) || cardIn(cards, target))) d.data.attachedTo = null
  }

  let right = -Infinity
  for (const d of free) {
    const data = d.data
    if (data.type === 'line') {
      for (const end of ['from', 'to'] as const) {
        const e = lineEnd(data[end])
        const attached = e.card && (ids.has(e.card) || cardIn(cards, e.card))
        data[end] = { card: attached ? e.card : null, x: Math.round(e.x + dx), y: Math.round(e.y + dy) }
      }
      continue
    }
    data.x = Math.round(num(data.x, 0) + dx)
    data.y = Math.round(num(data.y, 0) + dy)
    right = Math.max(right, (data.x as number) + num(data.w, 300))
  }

  if (orphans.length) {
    orphans.sort((a, b) => {
      const oa = a.orphan!.order
      const ob = b.orphan!.order
      return oa < ob ? -1 : oa > ob ? 1 : String(a.data.id) < String(b.data.id) ? -1 : 1
    })
    // Next to the free cards when there are any, else where the group lands.
    let x = Number.isFinite(right) ? right + 4 * STACK_GAP : origin.x + dx
    let y = origin.y + dy
    x = Math.round(x)
    for (const d of orphans) {
      d.data.x = x
      d.data.y = Math.round(y)
      const measured = d.sourceId ? opts.heightOf?.(d.sourceId) : undefined
      const stored = typeof d.data.h === 'number' && Number.isFinite(d.data.h) && d.data.h > 0 ? d.data.h : undefined
      y += (measured && measured > 0 ? measured : (stored ?? ORPHAN_HEIGHT)) + STACK_GAP
      delete d.orphan
    }
  }

  const out: string[] = []
  doc.transact(() => {
    let z = maxZ(doc)
    const now = Date.now()
    for (const d of valid) {
      const data = d.data
      const id = data.id as string
      data.z = ++z
      data.updatedAt = now
      data.updatedBy = userId
      if (data.createdAt === undefined) data.createdAt = now
      if (data.createdBy === undefined) data.createdBy = userId
      cards.set(id, attachCard(d))
      out.push(id)
    }
  }, LOCAL_ORIGIN)
  return out
}

/**
 * Removes fields a copy must not inherit (removal markers, per-device jobs, authorship). Copied or
 * moved cards are never locked (they land where they must be movable) nor in the Unsorted drawer,
 * except in a copy of a whole board (`keepPlacement`), which keeps its layout as it was.
 */
function resetCopiedFields(d: DetachedCard, keepAuthor: boolean, keepPlacement = false) {
  for (const k of REMOVAL_KEYS) delete d.data[k]
  delete d.data.previewBy
  if (!keepPlacement) {
    delete d.data.locked
    delete d.data.unsorted
  }
  if (!keepAuthor) {
    delete d.data.createdBy
    delete d.data.createdAt
  }
}

/** A board card that was copied: it now points to a new, empty child board that should receive a copy of `from`. */
export interface BoardFork {
  /** Child board the original card pointed to. */
  from: string
  /** New child board id written on the copied card. */
  to: string
  /** New capability secret of `to`. */
  secret: string
  title: string
}

/**
 * Gives every board card in a detached group its own new child board (fresh id and secret), so a
 * copy never shares the original's nested board (or its secret). Returns what remains to be filled.
 */
export function forkBoardCards(group: DetachedCard[], gen: { id: () => string; secret: () => string } = { id: newBoardId, secret: newSecret }): BoardFork[] {
  const forks: BoardFork[] = []
  for (const d of group) {
    if (d.data.type !== 'board') continue
    const from = str(d.data.boardId, '')
    const to = gen.id()
    const secret = gen.secret()
    d.data.boardId = to
    d.data.secret = secret
    forks.push({ from, to, secret, title: str(d.data.title, 'Untitled board') })
  }
  return forks
}

/**
 * Duplicates cards (with column children and lines between them) next to the originals. Children
 * whose column is not duplicated are copied into the same column, right after their originals.
 * Board cards get new child boards (see forkBoardCards); their forks are appended to `opts.forks`.
 */
export function duplicateCards(
  doc: Y.Doc,
  ids: Iterable<string>,
  userId: string,
  offset = { x: 30, y: 30 },
  opts: { forks?: BoardFork[] } = {},
): string[] {
  const all = expandSelection(doc, ids)
  const cards = getCards(doc)
  // Only keep lines whose both ends are in the set (or free).
  const maps = Array.from(all)
    .map((id) => cardIn(cards, id))
    .filter((m): m is CardMap => !!m)
    .filter((m) => {
      if (m.get('type') !== 'line') return true
      const f = lineEnd(m.get('from'))
      const t = lineEnd(m.get('to'))
      return (!f.card || all.has(f.card)) && (!t.card || all.has(t.card))
    })
  const { cards: clones } = cloneCardsWithNewIds(maps)
  for (const d of clones) resetCopiedFields(d, true)

  // Copies of column children (without their column) go back into the column after their original.
  const byColumn = new Map<string, DetachedCard[]>()
  for (const d of clones) {
    if (!d.orphan || !d.sourceId) continue
    const col = strOrNull(cardIn(cards, d.sourceId)?.get('parent'))
    if (!col || !isLiveColumn(cards, col)) continue
    let list = byColumn.get(col)
    if (!list) byColumn.set(col, (list = []))
    list.push(d)
  }
  let out: string[] = []
  doc.transact(() => {
    for (const [col, list] of byColumn) {
      const siblings = columnChildren(doc, col)
      let keys = siblingKeys(cards, siblings)
      if (!keys) {
        // Malformed or duplicate keys: re-key the column (same order) so the copies can slot in.
        keys = generateNKeysBetween(null, null, siblings.length)
        const patches: Record<string, Record<string, unknown>> = {}
        siblings.forEach((id, i) => (patches[id] = { order: keys![i] }))
        updateCards(doc, patches, userId)
      }
      for (const d of list) {
        const i = siblings.indexOf(d.sourceId!)
        if (i < 0) continue
        d.data.parent = col
        d.data.order = keyBetween(keys[i], i + 1 < keys.length ? keys[i + 1] : null)
        delete d.orphan
      }
    }
    const forks = forkBoardCards(clones)
    opts.forks?.push(...forks)
    const origin = groupOrigin(clones)
    out = insertClonedCards(doc, clones, { x: origin.x + offset.x, y: origin.y + offset.y }, userId)
  }, LOCAL_ORIGIN)
  return out
}

/**
 * Fills an empty board doc with a copy of another board's content: its title/icon/color/relay/cover and
 * active cards (same card ids, fresh history, no trash). Board cards inside are forked too; the
 * returned forks still need their own content. Does nothing when `dst` already has cards.
 */
export function copyBoardContent(
  src: Y.Doc,
  dst: Y.Doc,
  opts: { parentId: string | null; userId: string; title?: string },
): BoardFork[] {
  const meta = readMeta(src)
  const hasMeta = !!getMeta(src).get('id')
  initBoardDoc(
    dst,
    {
      id: dst.guid,
      title: hasMeta ? meta.title : (opts.title ?? meta.title),
      icon: meta.icon,
      color: meta.color,
      parentId: opts.parentId,
      shared: false,
      relay: meta.relay,
      cover: meta.cover,
    },
    opts.userId,
  )
  if (getCards(dst).size) return []
  const group: DetachedCard[] = []
  forEachActiveCard(src, (m) => {
    const d = detachCard(m)
    resetCopiedFields(d, true, true)
    group.push(d)
  })
  group.sort((a, b) => num(a.data.z, 0) - num(b.data.z, 0))
  const forks = forkBoardCards(group)
  insertClonedCards(dst, group, null, opts.userId)
  return forks
}

/**
 * Fills an empty board doc with a copy of Home's own cards (notes, to-dos, images...), for full
 * backups: Home itself is never exported as a board. Board cards are left out, since every board is
 * backed up as itself; lines and comments pinned to them come along unpinned. Keeps the layout,
 * Unsorted drawer included. Returns how many cards were copied (0 leaves `dst` untouched).
 */
export function copyHomeNotes(home: Y.Doc, dst: Y.Doc, opts: { id: string; title: string; parentId: string; userId: string }): number {
  const sources: CardMap[] = []
  forEachActiveCard(home, (m) => {
    if (m.get('type') !== 'board') sources.push(m)
  })
  if (!sources.length) return 0
  initBoardDoc(dst, { id: opts.id, title: opts.title, parentId: opts.parentId }, opts.userId)
  const { cards } = cloneCardsWithNewIds(sources)
  for (const d of cards) resetCopiedFields(d, true, true)
  cards.sort((a, b) => num(a.data.z, 0) - num(b.data.z, 0))
  insertClonedCards(dst, cards, null, opts.userId)
  return cards.length
}

// ---------------------------------------------------------------------------
// Clipboard snapshots: encoded as a Yjs update of a scratch doc so rich text survives exactly.

export const CLIPBOARD_MIME = 'application/x-noema-cards'

/**
 * The app's own clipboard format. Like duplicate and move, it takes comment threads pinned to the
 * copied cards along, so pasting a card keeps its discussion (on purpose: the snapshot is only
 * read back by this app). The plain-text rendition for other apps leaves those threads out
 * (cardsToPlainText).
 */
export function serializeCards(doc: Y.Doc, ids: Iterable<string>): Uint8Array {
  const all = expandSelection(doc, ids)
  const cards = getCards(doc)
  const scratch = new Y.Doc()
  const target = scratch.getMap<CardMap>('cards')
  scratch.transact(() => {
    for (const id of all) {
      const m = cardIn(cards, id)
      if (!m) continue
      if (m.get('type') === 'line') {
        const f = lineEnd(m.get('from'))
        const t = lineEnd(m.get('to'))
        if ((f.card && !all.has(f.card)) || (t.card && !all.has(t.card))) continue
      }
      const d = detachCard(m)
      resetCopiedFields(d, true)
      // Pasted board cards get new boards (forkBoardCards) filled from this device's own copy: the
      // clipboard (which may end up in other apps) never needs the child board's secret.
      if (d.data.type === 'board') delete d.data.secret
      // Keep the parent only when it is a live column (then the card's x/y are stale and it gets stacked).
      const parent = strOrNull(d.data.parent)
      if (parent && !all.has(parent) && !isLiveColumn(cards, parent)) d.data.parent = null
      target.set(id, attachCard(d))
    }
  })
  const update = Y.encodeStateAsUpdate(scratch)
  scratch.destroy()
  return update
}

/**
 * Decodes a clipboard snapshot into detached, re-id'd cards ready for insertClonedCards. The data
 * may come from anywhere (another app window, or a web page that put it on the clipboard): unknown
 * card types are dropped and internal fields (removal markers, authorship, preview jobs) are reset.
 * Board cards still point to their original child boards: callers fork them (forkBoardCards).
 */
export function deserializeCards(update: Uint8Array): DetachedCard[] {
  const scratch = new Y.Doc()
  try {
    Y.applyUpdate(scratch, update)
  } catch {
    scratch.destroy()
    return []
  }
  const src = Array.from(scratch.getMap<CardMap>('cards').values()).filter(
    (m): m is CardMap => m instanceof Y.Map && KNOWN_TYPES.has(m.get('type') as string),
  )
  const { cards } = cloneCardsWithNewIds(src)
  for (const d of cards) resetCopiedFields(d, false)
  scratch.destroy()
  return cards
}

/**
 * The selection as other apps get it: expandSelection without the comment threads that only came
 * along because they are pinned to a selected card. Those hold other people's names and messages,
 * which would otherwise end up in mails and documents whenever someone copies a card.
 */
export function exportSelection(doc: Y.Doc, ids: Iterable<string>): string[] {
  const explicit = new Set(ids)
  const all = expandSelection(doc, explicit)
  return Array.from(all).filter((id) => {
    if (explicit.has(id)) return true
    const m = getCardMap(doc, id)
    if (!m || m.get('type') !== 'comment') return true
    const target = m.get('attachedTo')
    return !(typeof target === 'string' && all.has(target))
  })
}

/** Plain-text rendition of cards for pasting into other apps. */
export function cardsToPlainText(doc: Y.Doc, ids: Iterable<string>): string {
  const parts: string[] = []
  for (const id of exportSelection(doc, ids)) {
    const m = getCardMap(doc, id)
    if (!m) continue
    const c = readCard(m) as Card & Record<string, unknown>
    const pieces: string[] = []
    for (const k of ['title', 'name', 'url', 'hex', 'label']) {
      const v = c[k]
      if (typeof v === 'string' && v) pieces.push(v)
    }
    const content = m.get('content')
    if (content instanceof Y.XmlFragment) pieces.push(xmlToText(content))
    const thread = m.get('thread')
    if (thread instanceof Y.Array)
      for (const msg of thread.toArray()) if (msg instanceof Y.Map) pieces.push(str(msg.get('text'), ''))
    const t = pieces.filter(Boolean).join('\n')
    if (t) parts.push(t)
  }
  return parts.join('\n\n')
}

/** Extracts plain text from a rich-text fragment, one line per block. */
export function xmlToText(node: Y.XmlFragment | Y.XmlElement): string {
  const lines: string[] = []
  const walk = (n: Y.XmlFragment | Y.XmlElement | Y.XmlText, acc: string[]): void => {
    if (n instanceof Y.XmlText) {
      let s = ''
      for (const op of n.toDelta() as { insert?: unknown }[]) if (typeof op.insert === 'string') s += op.insert
      acc.push(s)
      return
    }
    const children = n.toArray() as (Y.XmlElement | Y.XmlText)[]
    const isBlock = n instanceof Y.XmlElement && /^(paragraph|heading|taskItem|listItem|codeBlock|blockquote)$/.test(n.nodeName)
    if (isBlock && !children.some((c) => c instanceof Y.XmlElement && c.nodeName === 'paragraph')) {
      const inner: string[] = []
      children.forEach((c) => walk(c, inner))
      const prefix = n.nodeName === 'taskItem' ? (n.getAttribute('checked') ? '[x] ' : '[ ] ') : ''
      lines.push(prefix + inner.join(''))
      return
    }
    children.forEach((c) => walk(c, acc))
  }
  walk(node, lines)
  return lines.join('\n').trim()
}

// ---------------------------------------------------------------------------
// Moving cards to another board (drop onto a board card)

export interface MoveOptions extends InsertOptions {
  /**
   * Put the moved top-level cards into the destination's Unsorted drawer (after the cards already
   * there). They still get real x/y at `at`, where older versions draw them. Lines and comments
   * pinned to a moved card stay attached instead of becoming drawer cards.
   */
  unsorted?: boolean
}

/**
 * Copies cards (with column children, attached comments and lines between them) into another
 * board doc at position `at`, then hides them in the source (`movedTo`, plus the target card id in
 * `movedId`). Lines from a moved card to a card that stays cannot follow; they go to the
 * source board's trash (restorable) in the same transaction. Returns ids in the target doc.
 */
export function moveCardsToBoard(
  src: Y.Doc,
  dst: Y.Doc,
  ids: Iterable<string>,
  at: { x: number; y: number },
  userId: string,
  opts: MoveOptions = {},
): string[] {
  const all = expandSelection(src, ids)
  const cards = getCards(src)
  const sources: CardMap[] = []
  const sourceIds: string[] = []
  const leftBehind: string[] = []
  for (const id of all) {
    const m = cardIn(cards, id)
    if (!m) continue
    if (m.get('type') === 'line') {
      const f = lineEnd(m.get('from'))
      const t = lineEnd(m.get('to'))
      if ((f.card && !all.has(f.card)) || (t.card && !all.has(t.card))) {
        leftBehind.push(id)
        continue
      }
    }
    sources.push(m)
    sourceIds.push(id)
  }
  if (!sources.length) return []
  const movedSet = new Set(sourceIds)
  // Keep ids when possible (references stay intact); re-id the whole group on collision
  // (e.g. a card moved back to a board that still holds its hidden moved-away copy).
  const dstCards = getCards(dst)
  const collides = sources.some((m) => dstCards.has(str(m.get('id'), '')))
  const group = collides
    ? cloneCardsWithNewIds(sources).cards
    : sources.map((m) => {
        const d = detachCard(m)
        // Cards that were inside a column that is not moved become free cards.
        const parent = strOrNull(d.data.parent)
        if (parent && !movedSet.has(parent)) {
          d.data.parent = null
          if (isLiveColumn(cards, parent)) d.orphan = { order: str(d.data.order, 'a0') }
        }
        return d
      })
  group.forEach((d, i) => {
    resetCopiedFields(d, true)
    d.sourceId = sourceIds[i]
  })
  let out: string[] = []
  dst.transact(() => {
    out = insertClonedCards(dst, group, at, userId, opts)
    if (opts.unsorted) moveIntoDrawer(dst, out, userId)
  }, LOCAL_ORIGIN)
  const movedIds = new Map<string, string>()
  for (const d of group) if (d.sourceId && typeof d.data.id === 'string') movedIds.set(d.sourceId, d.data.id)
  src.transact(() => {
    markRemoved(src, movedSet, userId, dst.guid, { movedIds })
    if (leftBehind.length) markRemoved(src, leftBehind, userId, null)
  }, LOCAL_ORIGIN)
  return out
}

/**
 * Marks just-inserted cards as drawer cards, in reading order (top to bottom, then left to right),
 * after the cards already in the drawer. Column children, lines and comments pinned to one of the
 * cards are left as they are: they follow the card they belong to.
 */
function moveIntoDrawer(doc: Y.Doc, ids: string[], userId: string) {
  const cards = getCards(doc)
  const inserted = new Set(ids)
  const top = ids
    .map((id) => ({ id, m: cardIn(cards, id) }))
    .filter((e): e is { id: string; m: CardMap } => {
      const m = e.m
      if (!m || isTrashed(m) || strOrNull(m.get('parent')) !== null || m.get('type') === 'line') return false
      const target = m.get('type') === 'comment' ? strOrNull(m.get('attachedTo')) : null
      return !(target && inserted.has(target))
    })
    .sort((a, b) => num(a.m.get('y'), 0) - num(b.m.get('y'), 0) || num(a.m.get('x'), 0) - num(b.m.get('x'), 0))
  const keys = unsortedTailKeys(doc, top.length)
  const patches: Record<string, Record<string, unknown>> = {}
  top.forEach((e, i) => (patches[e.id] = { unsorted: true, order: keys[i] }))
  updateCards(doc, patches, userId)
}

/**
 * Undo of a move, on the target side: hides the copies in `dst` (as moved back to `backTo`) that
 * nobody changed since `base` was taken right after the move. If anything was edited or attached to
 * the copies meanwhile, nothing is hidden: a visible duplicate is better than a lost edit.
 */
export function hideMovedCopies(
  dst: Y.Doc,
  base: Record<string, CardContentState>,
  backTo: string,
  userId: string,
): { group: string; ids: string[] } | null {
  const ids: string[] = []
  for (const [id, state] of Object.entries(base)) {
    const m = getCardMap(dst, id)
    if (!m || isTrashed(m)) continue
    if (cardChangedSince(m, state)) return null
    ids.push(id)
  }
  if (!ids.length) return null
  const expanded = expandSelection(dst, ids)
  for (const id of expanded) if (!(id in base)) return null
  const group = markRemoved(dst, ids, userId, backTo, { origin: SYSTEM_ORIGIN })
  return group ? { group, ids } : null
}

/** Redo of a move, on the target side: shows the copies hidden by hideMovedCopies again (unless rescued meanwhile). */
export function unhideMovedCopies(dst: Y.Doc, hidden: { group: string; ids: string[] }): string[] {
  const out: string[] = []
  const cards = getCards(dst)
  dst.transact(() => {
    for (const id of hidden.ids) {
      const m = cardIn(cards, id)
      if (!m || !isMovedAway(m) || m.get('trashGroup') !== hidden.group) continue
      for (const k of REMOVAL_KEYS) if (m.has(k)) m.delete(k)
      out.push(id)
    }
  }, SYSTEM_ORIGIN)
  return out
}

// ---------------------------------------------------------------------------
// Plain text -> rich text helpers (paste, drop, import)

/** Replaces a fragment's content with paragraphs of plain text (one per line). Call inside a transaction. */
export function setFragmentText(frag: Y.XmlFragment, text: string) {
  if (frag.length) frag.delete(0, frag.length)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  frag.insert(
    0,
    lines.map((line) => {
      const p = new Y.XmlElement('paragraph')
      if (line) p.insert(0, [new Y.XmlText(line)])
      return p
    }),
  )
}

/** Creates a note card containing plain text. */
export function createTextNote(doc: Y.Doc, text: string, fields: NewCardFields, userId: string): string {
  let id = ''
  doc.transact(() => {
    id = createCard(doc, 'note', fields, userId)
    const frag = getCardMap(doc, id)?.get('content')
    if (frag instanceof Y.XmlFragment) setFragmentText(frag, text)
  }, LOCAL_ORIGIN)
  return id
}
