/**
 * Comment thread operations on a comment card's `thread` field (Y.Array<Y.Map>).
 * Reads sanitise peer data; writes run in LOCAL_ORIGIN transactions so they are undoable.
 */
import * as Y from 'yjs'
import { ensureArray, LOCAL_ORIGIN } from '../../model/board'
import { newId } from '../../model/ids'
import type { CardMap, CommentMessage, UserProfile } from '../../model/types'
import { cleanMentionLabel } from '../../editor/mentionAttrs'
import { truncate } from './helpers'
import { ID_RE } from './attach'
import { containsMention } from './linkify'

export const THREAD_FIELD = 'thread'
export const COMMENT_MAX = 5000
/** Most people one message can mention. */
export const MENTIONS_MAX = 20
/** Entries of a peer's mention list looked at before giving up (the list itself is untrusted). */
const MENTIONS_SCAN = 200
const NAME_MAX = 60
const ID_MAX = 64
const FALLBACK_COLOR = '#8b8d98'

/**
 * Removed from message text, peer data included: C0 controls except tab and newline, C1 controls,
 * zero-width space, direction marks, embeddings, overrides and isolates (they reorder what a
 * message shows, e.g. to disguise a link), and the byte-order mark. Zero-width joiners stay because
 * emoji sequences and several scripts need them. Author names are cleaned like mention labels,
 * which removes those too, so a name cannot be made to look like someone else's.
 * Built from code points so the source stays plain ASCII.
 */
const TEXT_CONTROL = new RegExp(
  `[${[
    [0x00, 0x08],
    [0x0b, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200b],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
  'g',
)
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g')

/** Message text without control or direction-changing characters; line and paragraph separators become newlines. */
export function scrubCommentText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(LINE_SEPARATORS, '\n').replace(TEXT_CONTROL, '')
}

/** An author name that is safe to show and to offer in the mention picker ('' when nothing is left). */
export function cleanAuthorName(v: unknown): string {
  // Capped before cleaning: a peer can store a huge string.
  return typeof v === 'string' ? truncate(cleanMentionLabel(truncate(v, NAME_MAX * 4)), NAME_MAX).trim() : ''
}

/** Normalises line endings, removes control characters, trims surrounding blank space and caps the length. */
export function normalizeCommentText(text: string): string {
  if (typeof text !== 'string') return ''
  return truncate(scrubCommentText(truncate(text, COMMENT_MAX * 2)).trim(), COMMENT_MAX)
}

export function safeColor(v: unknown): string {
  return typeof v === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v) ? v : FALLBACK_COLOR
}

function shortStr(v: unknown, max: number): string {
  return typeof v === 'string' ? truncate(v, max) : ''
}

function time(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** A message with the people it mentions (ids; the text keeps '@Name' literally). */
export type ThreadMessage = CommentMessage & { mentions: string[] }

/** A person picked in the mention picker. `name` is unknown for ids whose member is not known here. */
export interface MentionRef {
  id: string
  name?: string
}

/** Valid, unique mention ids from untrusted data (a plain array), at most MENTIONS_MAX. */
export function readMentions(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const out: string[] = []
  const n = Math.min(v.length, MENTIONS_SCAN)
  for (let i = 0; i < n && out.length < MENTIONS_MAX; i++) {
    const id: unknown = v[i]
    if (typeof id === 'string' && ID_RE.test(id) && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Ids to store with a message: the picked people whose '@Name' is still in the text. People whose
 * name is not known on this device are kept (their mention cannot be checked, and must not be lost
 * when the author edits the message on another device).
 */
export function mentionedIds(text: string, picked: readonly MentionRef[]): string[] {
  const keep: string[] = []
  for (const p of picked) {
    if (!p || typeof p.id !== 'string' || !ID_RE.test(p.id) || keep.includes(p.id)) continue
    if (typeof p.name === 'string' && p.name && !containsMention(text, p.name)) continue
    keep.push(p.id)
    if (keep.length >= MENTIONS_MAX) break
  }
  return keep
}

/** One message from the thread, or null when the entry is malformed. */
export function readMessage(v: unknown): ThreadMessage | null {
  if (!(v instanceof Y.Map)) return null
  const id = shortStr(v.get('id'), ID_MAX)
  const raw = v.get('text')
  const text = typeof raw === 'string' ? truncate(scrubCommentText(truncate(raw, COMMENT_MAX * 2)), COMMENT_MAX) : ''
  if (!id || !text.trim()) return null
  return {
    id,
    authorId: shortStr(v.get('authorId'), ID_MAX),
    authorName: cleanAuthorName(v.get('authorName')) || 'Someone',
    authorColor: safeColor(v.get('authorColor')),
    text,
    createdAt: time(v.get('createdAt')) ?? 0,
    editedAt: time(v.get('editedAt')),
    mentions: readMentions(v.get('mentions')),
  }
}

export function getThread(map: CardMap): Y.Array<unknown> | null {
  const v = map.get(THREAD_FIELD)
  return v instanceof Y.Array ? (v as Y.Array<unknown>) : null
}

/** Sanitised messages in thread order (malformed entries skipped, duplicate ids kept once). */
export function readThread(arr: Y.Array<unknown> | null | undefined): ThreadMessage[] {
  if (!arr) return []
  const out: ThreadMessage[] = []
  const seen = new Set<string>()
  for (const item of arr.toArray()) {
    const m = readMessage(item)
    if (!m || seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}

/**
 * Whether a pinned thread gets a marker: once it has a message, or for the person who started it
 * (who may still be writing the first one). Nobody else sees an empty pin.
 */
export function showsMarker(map: CardMap, meId: string): boolean {
  return readThread(getThread(map)).length > 0 || (!!meId && map.get('createdBy') === meId)
}

function touch(map: CardMap, userId: string, now: number) {
  map.set('updatedAt', now)
  map.set('updatedBy', userId)
}

function indexOfMessage(arr: Y.Array<unknown>, messageId: string): number {
  const items = arr.toArray()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it instanceof Y.Map && it.get('id') === messageId) return i
  }
  return -1
}

/**
 * Appends a message by `author`. Returns its id, or null when the text is empty. `mentions` are the
 * people picked while writing; only those still named in the text are stored.
 */
export function addComment(
  doc: Y.Doc,
  map: CardMap,
  author: UserProfile,
  text: string,
  now = Date.now(),
  mentions: readonly MentionRef[] = [],
): string | null {
  const body = normalizeCommentText(text)
  if (!body) return null
  const arr = ensureArray<Y.Map<unknown>>(doc, map, THREAD_FIELD)
  const id = newId()
  const ids = mentionedIds(body, mentions)
  doc.transact(() => {
    const msg = new Y.Map<unknown>()
    msg.set('id', id)
    msg.set('authorId', author.id)
    msg.set('authorName', cleanAuthorName(author.name) || 'Anonymous')
    msg.set('authorColor', safeColor(author.color))
    msg.set('text', body)
    msg.set('createdAt', now)
    msg.set('editedAt', null)
    if (ids.length) msg.set('mentions', ids)
    arr.push([msg])
    touch(map, author.id, now)
  }, LOCAL_ORIGIN)
  return id
}

/**
 * Replaces the text of one of `userId`'s own messages. Empty text is refused (delete instead).
 * `mentions` are the message's current mentions plus anyone picked while editing; ids whose '@Name'
 * is no longer in the text are dropped. Omitted, the stored mentions are kept as they are.
 */
export function editComment(
  doc: Y.Doc,
  map: CardMap,
  messageId: string,
  userId: string,
  text: string,
  now = Date.now(),
  mentions?: readonly MentionRef[],
): boolean {
  const arr = getThread(map)
  const body = normalizeCommentText(text)
  if (!arr || !body) return false
  const i = indexOfMessage(arr, messageId)
  if (i < 0) return false
  const msg = arr.get(i) as Y.Map<unknown>
  if (msg.get('authorId') !== userId) return false
  const before = readMentions(msg.get('mentions'))
  const ids = mentions ? mentionedIds(body, mentions) : before
  const sameMentions = ids.length === before.length && ids.every((id, k) => id === before[k])
  if (msg.get('text') === body && sameMentions) return true
  doc.transact(() => {
    if (msg.get('text') !== body) {
      msg.set('text', body)
      msg.set('editedAt', now)
    }
    if (!sameMentions) {
      if (ids.length) msg.set('mentions', ids)
      else msg.delete('mentions')
    }
    touch(map, userId, now)
  }, LOCAL_ORIGIN)
  return true
}

/** Removes one of `userId`'s own messages. */
export function deleteComment(doc: Y.Doc, map: CardMap, messageId: string, userId: string, now = Date.now()): boolean {
  const arr = getThread(map)
  if (!arr) return false
  const i = indexOfMessage(arr, messageId)
  if (i < 0) return false
  const msg = arr.get(i) as Y.Map<unknown>
  if (msg.get('authorId') !== userId) return false
  doc.transact(() => {
    arr.delete(i, 1)
    touch(map, userId, now)
  }, LOCAL_ORIGIN)
  return true
}

/**
 * Which messages a long thread shows while folded: the opening message and the latest replies,
 * with the number hidden in between.
 */
export function foldThread<T>(messages: readonly T[], keepLast = 2, threshold = 6): { head: T[]; hidden: number; tail: T[] } {
  if (messages.length <= threshold) return { head: [...messages], hidden: 0, tail: [] }
  return {
    head: messages.slice(0, 1),
    hidden: messages.length - 1 - keepLast,
    tail: messages.slice(messages.length - keepLast),
  }
}

/** Plain-text copy of a thread ('Name: text' per message). */
export function threadToText(messages: readonly CommentMessage[]): string {
  return messages.map((m) => `${m.authorName}: ${m.text}`).join('\n\n')
}
