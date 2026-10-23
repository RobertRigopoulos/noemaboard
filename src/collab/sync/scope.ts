/**
 * Room scope = the boards reachable from a room's root board through board cards.
 * This is the access control of peer-to-peer sync: a peer in a room only ever receives or
 * changes boards inside that room's scope.
 */
import * as Y from 'yjs'
import { getCards, getMeta } from '../../model/board'
import { boardBlobHashes } from '../../model/blobRefs'
import { isValidId } from '../../model/ids'

/** Upper bound of boards one room may pull in, so a hostile board cannot make us open thousands of docs. */
export const MAX_SCOPE = 1000
/**
 * Upper bound of child boards one board adds to a scope (and teaches the library), so a hostile
 * board full of fake board cards cannot crowd the real nested boards out of MAX_SCOPE.
 */
export const MAX_LINKS_PER_BOARD = 200
const MAX_SECRET_LENGTH = 128

/** Child board id -> secrets found on board cards pointing at it (normally exactly one). */
export type BoardLinks = Map<string, string[]>

export function readBoardLinks(doc: Y.Doc, homeId: string): BoardLinks {
  const links: BoardLinks = new Map()
  getCards(doc).forEach((m) => {
    if (!(m instanceof Y.Map) || m.get('type') !== 'board') return
    const boardId = m.get('boardId')
    const secret = m.get('secret')
    if (!isValidId(boardId) || boardId === homeId || boardId === doc.guid) return
    if (typeof secret !== 'string' || !secret || secret.length > MAX_SECRET_LENGTH) return
    const list = links.get(boardId)
    if (!list) links.set(boardId, [secret])
    else if (!list.includes(secret)) list.push(secret)
  })
  return links
}

export const readShared = (doc: Y.Doc) => getMeta(doc).get('shared') === true

/**
 * A board card only grants access to the child when it carries the child's real secret.
 * When we already know the child's secret, a card with a different one is ignored: otherwise a
 * member of one board could pull an unrelated board we own into their room just by naming its id.
 */
export function acceptLink(childId: string, secrets: readonly string[], knownSecret: string | undefined, homeId: string): boolean {
  if (childId === homeId || !isValidId(childId) || !secrets.length) return false
  if (!knownSecret) return true
  return secrets.includes(knownSecret)
}

/**
 * The children a board grants access to: links accepted by acceptLink, boards whose secret we
 * already know first, at most `limit`. A secret that belongs to another board we know is not
 * a key to an unknown board: a card reusing it would pull a second board into that board's room.
 */
export function acceptedChildren(
  links: BoardLinks,
  secretOf: (id: string) => string | undefined,
  ownerOf: (secret: string) => string | undefined,
  homeId: string,
  limit = MAX_LINKS_PER_BOARD,
): string[] {
  const known: string[] = []
  const unknown: string[] = []
  for (const [child, secrets] of links) {
    const knownSecret = secretOf(child)
    if (knownSecret) {
      if (acceptLink(child, secrets, knownSecret, homeId)) known.push(child)
      continue
    }
    const usable = secrets.filter((s) => {
      const owner = ownerOf(s)
      return owner === undefined || owner === child
    })
    if (acceptLink(child, usable, undefined, homeId)) unknown.push(child)
  }
  return [...known, ...unknown].slice(0, Math.max(0, limit))
}

/** Breadth-first walk from the root. `children` returns undefined for boards not loaded yet. */
export function computeScope(
  rootId: string,
  children: (id: string) => Iterable<string> | undefined,
  limit = MAX_SCOPE,
): Set<string> {
  const scope = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length && scope.size < limit) {
    const id = queue.shift()!
    const kids = children(id)
    if (!kids) continue
    for (const k of kids) {
      if (scope.has(k)) continue
      if (scope.size >= limit) break
      scope.add(k)
      queue.push(k)
    }
  }
  return scope
}

const LINK_KEYS = ['type', 'boardId', 'secret']

/** True when a batch of deep events on the cards map may have changed board links. */
export function touchesLinks(events: Y.YEvent<any>[], cards: Y.Map<unknown>): boolean {
  for (const e of events) {
    if (e.target === cards) return true
    if (e instanceof Y.YMapEvent && e.target.parent === cards) {
      for (const k of LINK_KEYS) if (e.keysChanged.has(k)) return true
    }
  }
  return false
}

/**
 * Calls `onLinks` when board cards may have changed and `onShared` when meta.shared changed.
 * Text edits inside cards are filtered out cheaply. `onContent` (optional) hears about every change
 * of the cards or the meta (anything that may change readBlobRefs). Returns the unsubscribe function.
 */
export function observeBoardDoc(doc: Y.Doc, onLinks: () => void, onShared: () => void, onContent?: () => void): () => void {
  const cards = getCards(doc) as Y.Map<unknown>
  const meta = getMeta(doc)
  const onCardEvents = (events: Y.YEvent<any>[]) => {
    onContent?.()
    if (touchesLinks(events, cards)) onLinks()
  }
  const onMeta = (e: Y.YMapEvent<unknown>) => {
    onContent?.()
    if (e.keysChanged.has('shared')) onShared()
  }
  cards.observeDeep(onCardEvents)
  meta.observe(onMeta)
  return () => {
    cards.unobserveDeep(onCardEvents)
    meta.unobserve(onMeta)
  }
}

/**
 * Content hashes of the files a board refers to (image, thumbnail, file, link preview, favicon,
 * card and board covers...), trashed cards included since they can be restored (see
 * model/blobRefs.ts). A peer may only fetch a file that a board in its room's scope refers to.
 */
export function readBlobRefs(doc: Y.Doc): Set<string> {
  return boardBlobHashes(doc)
}
