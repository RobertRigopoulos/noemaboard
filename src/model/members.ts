/**
 * Board member roster: everyone who has opened a board, including people who are offline now.
 *
 * Stored in the top-level map `members` of the board doc: key = user id, value = one plain object
 * { name, color, seenAt } per user, so writes by different people never conflict. Entries come from
 * peers and are untrusted: every read validates them, and timestamps are for display only.
 */
import * as Y from 'yjs'
import { HOME_BOARD_ID } from '../config'
import { SYSTEM_ORIGIN } from './board'
import type { UserProfile } from './types'

export interface Member {
  id: string
  name: string
  color: string
  /** When this person last opened the board (their clock). 0 when unknown. */
  seenAt: number
}

export const getMembers = (doc: Y.Doc) => doc.getMap<unknown>('members')

export const MEMBER_ID = /^[A-Za-z0-9_-]{1,64}$/
const MEMBER_COLOR = /^#[0-9a-f]{6}$/i
/** Neutral grey for members whose colour is missing or malformed. */
export const DEFAULT_MEMBER_COLOR = '#8b8d98'
export const MAX_MEMBERS = 500
export const MAX_MEMBER_NAME = 60
/** An unchanged entry is refreshed at most once a day, so opening a board does not churn the doc. */
export const MEMBER_REFRESH_MS = 24 * 3600 * 1000
/**
 * seenAt values further in the future than this count as unknown (0): a peer could otherwise pin
 * entries at the top of the roster (it keeps the most recently seen) with far-future timestamps.
 */
export const MEMBER_FUTURE_MS = 24 * 3600 * 1000
/** Own entries dated later than this ahead of our clock were not written by us: they are rewritten. */
const OWN_ENTRY_SKEW_MS = 10 * 60 * 1000

/** Display name with control and invisible format characters removed, or null when unusable. */
export function cleanMemberName(v: unknown): string | null {
  if (typeof v !== 'string') return null
  // oxlint-disable-next-line no-control-regex -- removing control characters is intended
  const name = v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\p{Cf}/gu, '').trim()
  const length = Array.from(name).length
  return length >= 1 && length <= MAX_MEMBER_NAME ? name : null
}

function cleanColor(v: unknown): string {
  return typeof v === 'string' && MEMBER_COLOR.test(v) ? v : DEFAULT_MEMBER_COLOR
}

function cleanSeenAt(v: unknown, now: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0
  return v > now + MEMBER_FUTURE_MS ? 0 : v
}

function plainObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Y.AbstractType) return null
  return v as Record<string, unknown>
}

/** Validates one roster entry; null when it must be skipped. `now` judges seenAt (see MEMBER_FUTURE_MS). */
export function readMemberEntry(id: unknown, value: unknown, now = Date.now()): Member | null {
  if (typeof id !== 'string' || !MEMBER_ID.test(id)) return null
  const o = plainObject(value)
  if (!o) return null
  const name = cleanMemberName(o.name)
  if (!name) return null
  return { id, name, color: cleanColor(o.color), seenAt: cleanSeenAt(o.seenAt, now) }
}

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Valid members, at most the MAX_MEMBERS most recently seen, sorted by name. */
export function readMembers(doc: Y.Doc, now = Date.now()): Member[] {
  const out: Member[] = []
  getMembers(doc).forEach((v, k) => {
    const m = readMemberEntry(k, v, now)
    if (m) out.push(m)
  })
  if (out.length > MAX_MEMBERS) {
    out.sort((a, b) => b.seenAt - a.seenAt || (a.id < b.id ? -1 : 1))
    out.length = MAX_MEMBERS
  }
  return out.sort(byName)
}

/** The roster name of a user, or null when they are not (validly) on the roster. */
export function memberName(doc: Y.Doc, id: string): string | null {
  if (!MEMBER_ID.test(id)) return null
  return readMemberEntry(id, getMembers(doc).get(id))?.name ?? null
}

/**
 * Records the current user on the board's roster. Never on Home (it is never shared). Writes
 * (not undoable) only when the entry is missing or invalid, the name or colour changed, or it was
 * last refreshed more than a day ago or is dated in the future. Returns whether it wrote.
 */
export function upsertMember(doc: Y.Doc, user: UserProfile, now = Date.now()): boolean {
  if (doc.guid === HOME_BOARD_ID || !Number.isFinite(now) || now <= 0) return false
  if (typeof user?.id !== 'string' || !MEMBER_ID.test(user.id)) return false
  const name = cleanMemberName(user.name)
  if (!name) return false
  const color = cleanColor(user.color)
  const members = getMembers(doc)
  const cur = readMemberEntry(user.id, members.get(user.id), now)
  const fresh = !!cur && cur.seenAt <= now + OWN_ENTRY_SKEW_MS && now - cur.seenAt <= MEMBER_REFRESH_MS
  if (cur && fresh && cur.name === name && cur.color === color) return false
  doc.transact(() => members.set(user.id, { name, color, seenAt: now }), SYSTEM_ORIGIN)
  return true
}

/**
 * People who can be mentioned or assigned: the roster plus `extra` (live peers, comment authors),
 * validated like roster entries and deduplicated by id (the roster entry wins, then the first extra).
 * The current user comes first, everyone else by name.
 */
export function mentionCandidates(doc: Y.Doc, extra: readonly { id: string; name: string; color: string }[], meId: string): Member[] {
  const byId = new Map<string, Member>()
  for (const m of readMembers(doc)) byId.set(m.id, m)
  for (const e of extra) {
    const m = readMemberEntry(e?.id, { name: e?.name, color: e?.color })
    if (m && !byId.has(m.id)) byId.set(m.id, m)
  }
  return [...byId.values()].sort((a, b) => (a.id === meId ? -1 : b.id === meId ? 1 : byName(a, b)))
}
