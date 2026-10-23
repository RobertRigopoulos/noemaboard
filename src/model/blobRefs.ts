/**
 * The one rule for finding the files a card refers to: any TOP-LEVEL string field holding a
 * lowercase SHA-256 hex (image, thumbnail, file, link preview image, favicon, cover...). Sync scope
 * checks (a peer may only fetch files its boards refer to) and backups both use it, so a new blob
 * field only has to follow the rule to be synced and exported.
 */
import * as Y from 'yjs'
import { getCards, getMeta, isBlobHash } from './board'

export { isBlobHash }

/** Fields that may hold 64-hex strings without being files: capabilities and ids. */
const NOT_BLOBS: ReadonlySet<string> = new Set(['secret', 'boardId'])

/** Blob hashes a card refers to, deduplicated. Nested objects are never looked into. */
export function cardBlobHashes(m: Y.Map<unknown>): string[] {
  const out = new Set<string>()
  m.forEach((v, k) => {
    if (!NOT_BLOBS.has(k) && isBlobHash(v)) out.add(v)
  })
  return [...out]
}

/**
 * Every file a board refers to: its cards' (trashed ones included, since they can be restored) and
 * its own meta's (the cover), by the same top-level rule.
 */
export function boardBlobHashes(doc: Y.Doc): Set<string> {
  const out = new Set<string>(cardBlobHashes(getMeta(doc)))
  getCards(doc).forEach((m) => {
    if (!(m instanceof Y.Map)) return
    for (const h of cardBlobHashes(m)) out.add(h)
  })
  return out
}
