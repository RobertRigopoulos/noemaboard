/**
 * Automatic trash purging must not trust another device's clock: `trashedAt` is written by whoever
 * deleted the cards, and a device whose clock is months behind would make everyone else purge its
 * deletions right away. Each device remembers (locally, per board) when it first saw each trash
 * group and only purges once a group is old by its own clock too.
 */
import type * as Y from 'yjs'
import { purgeExpiredTrash, trashGroups } from '../model/board'
import { loadJSON, saveJSON } from '../collab/profile'

export type FirstSeen = Record<string, number>

/** Pure: keeps the entries of groups still present and records new groups as first seen `now`. */
export function updateFirstSeen(prev: unknown, groups: Iterable<string>, now: number): FirstSeen {
  const old = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {}
  const next: FirstSeen = {}
  for (const g of groups) {
    const t = old[g]
    next[g] = typeof t === 'number' && Number.isFinite(t) && t <= now ? t : now
  }
  return next
}

const storageKey = (boardId: string) => `trashSeen:${boardId}`

/** Purges expired trash of a board, measuring age from max(trashedAt, first seen on this device). */
export function purgeExpiredTrashLocally(doc: Y.Doc, boardId: string, now = Date.now()) {
  const seen = updateFirstSeen(loadJSON<unknown>(storageKey(boardId), {}), trashGroups(doc), now)
  purgeExpiredTrash(doc, now, (group) => seen[group])
  // Forget groups that are gone (purged here or elsewhere, or restored).
  saveJSON(storageKey(boardId), updateFirstSeen(seen, trashGroups(doc), now))
}
