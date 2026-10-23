/**
 * Unsent comment text, kept outside React so it survives the card body re-mounting (culling, moving
 * into or out of a column, the pin popover closing). Local to this app instance, never synced.
 */
import type { MentionRef } from './thread'

export interface CommentDraft {
  text: string
  /** People picked in the mention picker while writing. */
  mentions: readonly MentionRef[]
}

/** Oldest drafts are forgotten beyond this many (each one is a few KB at most). */
export const MAX_DRAFTS = 200

const drafts = new Map<string, CommentDraft>()
const listeners = new Map<string, Set<() => void>>()

/** Draft of the reply composer of one thread. */
export function draftKey(boardId: string, cardId: string): string {
  return `${boardId}:${cardId}`
}

/** Draft of an edit to one message. */
export function editDraftKey(boardId: string, cardId: string, messageId: string): string {
  return `${draftKey(boardId, cardId)}:edit:${messageId}`
}

export function getDraft(key: string): CommentDraft | undefined {
  return drafts.get(key)
}

/** True when the draft holds text that was never sent. */
export function hasUnsentText(key: string): boolean {
  return !!drafts.get(key)?.text.trim()
}

function notify(key: string) {
  listeners.get(key)?.forEach((l) => l())
}

/** Stores a draft (an empty one too: an edit cleared to nothing is still an edit in progress). */
export function setDraft(key: string, draft: CommentDraft) {
  if (drafts.get(key) === draft) return
  // Re-inserting keeps the Map in least-recently-written order for eviction.
  drafts.delete(key)
  drafts.set(key, { text: draft.text, mentions: draft.mentions })
  while (drafts.size > MAX_DRAFTS) {
    const oldest = drafts.keys().next().value as string
    drafts.delete(oldest)
    notify(oldest)
  }
  notify(key)
}

export function clearDraft(key: string) {
  if (drafts.delete(key)) notify(key)
}

export function subscribeDraft(key: string, cb: () => void): () => void {
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  set.add(cb)
  return () => {
    set.delete(cb)
    if (!set.size && listeners.get(key) === set) listeners.delete(key)
  }
}

/** Test helper: forgets every draft. */
export function resetDrafts() {
  const keys = Array.from(drafts.keys())
  drafts.clear()
  keys.forEach(notify)
}
