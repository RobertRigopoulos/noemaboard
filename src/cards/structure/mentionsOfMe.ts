/**
 * Where the person using this app is @mentioned on a board: comment messages that list their id, and
 * 'mention' nodes in rich text (notes, to-dos, documents, captions). Pure Yjs reads, no React.
 */
import * as Y from 'yjs'
import { forEachActiveCard } from '../../model/board'
import { CARD_YTYPES, type CardType } from '../../model/types'
import { getThread, readThread } from './thread'

export interface MentionHit {
  /**
   * Stable while the mention exists: `cardId:msgId` for comments, `cardId:client.clock` for rich text
   * (the Yjs id of the mention node, unique per inserted node), so a mention deleted and written
   * again, or one whose position shifts, is still told apart from the ones already seen.
   */
  key: string
  cardId: string
}

/** Nodes visited per card before giving up (peer content can be arbitrarily large). */
const NODE_BUDGET = 20_000

/** The 'mention' elements naming `meId` in a fragment. */
export function richMentions(frag: Y.XmlFragment, meId: string): Y.XmlElement[] {
  const out: Y.XmlElement[] = []
  let budget = NODE_BUDGET
  const stack: (Y.XmlFragment | Y.XmlElement)[] = [frag]
  while (stack.length && budget > 0) {
    const node = stack.pop()!
    for (const child of node.toArray()) {
      if (--budget <= 0) break
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === 'mention' && child.getAttribute('id') === meId) out.push(child)
      stack.push(child)
    }
  }
  return out
}

/** Number of 'mention' elements naming `meId` in a fragment. */
export function countRichMentions(frag: Y.XmlFragment, meId: string): number {
  return richMentions(frag, meId).length
}

/** Every mention of `meId` on the board, in card order. Messages written by `meId` do not count. */
export function findMentions(doc: Y.Doc, meId: string): MentionHit[] {
  const out: MentionHit[] = []
  if (!meId) return out
  forEachActiveCard(doc, (m, cardId) => {
    const type = m.get('type')
    if (type === 'comment') {
      for (const msg of readThread(getThread(m))) {
        if (msg.authorId !== meId && msg.mentions.includes(meId)) out.push({ key: `${cardId}:${msg.id}`, cardId })
      }
      return
    }
    const fields = typeof type === 'string' ? CARD_YTYPES[type as CardType] : undefined
    if (!fields) return
    let n = 0
    for (const [field, kind] of Object.entries(fields)) {
      if (kind !== 'xml') continue
      const frag = m.get(field)
      if (!(frag instanceof Y.XmlFragment)) continue
      for (const node of richMentions(frag, meId)) {
        const id = node._item?.id
        // Positional only for a node that is not in a doc, which board content always is.
        out.push({ key: id ? `${cardId}:${id.client}.${id.clock}` : `${cardId}:m${n}`, cardId })
        n++
      }
    }
  })
  return out
}

/** Hits whose key is not in `seen`. */
export function newMentions(hits: readonly MentionHit[], seen: ReadonlySet<string>): MentionHit[] {
  return hits.filter((h) => !seen.has(h.key))
}

/** Keys to remember: the current ones, at most `max` (the last ones win). */
export function seenKeysToStore(hits: readonly MentionHit[], max = 500): string[] {
  const keys = Array.from(new Set(hits.map((h) => h.key)))
  return keys.length > max ? keys.slice(keys.length - max) : keys
}

/** 'You were mentioned 3 times on this board'. */
export function mentionNotice(n: number): string {
  return n === 1 ? 'You were mentioned once on this board' : `You were mentioned ${n} times on this board`
}

/** Local-storage key (see collab/profile) of the mention keys already notified on a board. */
export const seenStorageKey = (boardId: string) => `mentionsSeen:${boardId}`

const SEEN_KEY_MAX = 200

/** Stored keys from local storage; anything malformed is ignored, at most `max` are kept. */
export function readSeen(raw: unknown, max = 500): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(raw)) return out
  for (const k of raw.slice(0, max)) if (typeof k === 'string' && k.length <= SEEN_KEY_MAX) out.add(k)
  return out
}
