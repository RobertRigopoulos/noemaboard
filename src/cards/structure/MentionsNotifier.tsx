/**
 * Once per board opening (never on Home), tells the person using the app how many new @mentions of
 * them the board holds: comment messages that list them and mention chips in rich text. What was seen
 * is remembered per board in this browser only; nothing about it is sent anywhere.
 */
import { useEffect } from 'react'
import type { BoardContextValue } from '../../board/BoardContext'
import { centerOn } from '../../board/actions'
import { cardBounds } from '../../board/geometry'
import { useSelection, usePanels, useView } from '../../board/store'
import { drawerCardOf, getMeta } from '../../model/board'
import { loadJSON, saveJSON } from '../../collab/profile'
import { getUser } from '../../collab/identity'
import { toast } from '../../ui/toast'
import { attachmentTarget } from './attach'
import { isBoardDocReady } from './helpers'
import { usePins } from './pinStore'
import { hiddenReason, revealCard } from './reveal'
import { findMentions, mentionNotice, newMentions, readSeen, seenKeysToStore, seenStorageKey, type MentionHit } from './mentionsOfMe'

/** Peers and local storage deliver most of a board within this time after it opens. */
const SETTLE_MS = 1500
const NOTICE_MS = 8000
const SEEN_MAX = 500

/**
 * Selects and centres the card a mention is on; a pinned comment opens on its card. A card in a
 * collapsed column is not drawn, so the column stands in for it, and a thread pinned there is not
 * opened (it would only pop up later, when someone expands the column).
 */
export async function showMention(ctx: BoardContextValue, hit: MentionHit) {
  const current = () => !ctx.doc.isDestroyed && useView.getState().boardId === ctx.boardId
  if (!current()) return
  const c = ctx.index.get(hit.cardId)
  if (!c) {
    toast('That card is no longer on this board')
    return
  }
  const pinnedTo = c.type === 'comment' ? attachmentTarget(c.card, (id) => ctx.index.get(id)) : null
  const target = (pinnedTo && ctx.index.get(pinnedTo)) || c
  const sel = useSelection.getState()
  // Hidden with the Unsorted drawer (in it, in a column that is, or pinned to such a card): show its drawer card.
  const drawerCard = drawerCardOf((id) => ctx.index.get(id), target.id)
  if (drawerCard) {
    usePanels.getState().setPanel('unsorted')
    sel.select([drawerCard])
    return
  }
  if (hiddenReason(ctx, target) === 'collapsed' && target.parent) {
    const column = ctx.index.get(target.parent)
    const rect = column ? cardBounds(column) : null
    sel.select([target.parent])
    if (rect) centerOn({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
    toast(pinnedTo ? 'The comment is on a card in a collapsed column. Expand the column to read it.' : 'The mention is in a collapsed column. Expand the column to see it.')
    return
  }
  sel.select([target.id])
  // A card in a column that is out of view is laid out only once its column renders.
  const rect = await revealCard(ctx, target.id)
  if (pinnedTo && rect && current()) usePins.getState().openPin(c.id)
}

export function MentionsNotifier({ ctx }: { ctx: BoardContextValue }) {
  useEffect(() => {
    if (ctx.isHome) return
    const { doc, boardId } = ctx
    const meta = getMeta(doc)
    let timer: ReturnType<typeof setTimeout> | null = null
    let done = false

    const check = () => {
      timer = null
      if (done || doc.isDestroyed) return
      done = true
      const meId = getUser().id
      const hits = findMentions(doc, meId)
      const key = seenStorageKey(boardId)
      const fresh = newMentions(hits, readSeen(loadJSON<unknown>(key, null), SEEN_MAX))
      saveJSON(key, seenKeysToStore(hits, SEEN_MAX))
      if (fresh.length) {
        const first = fresh[0]
        toast(mentionNotice(fresh.length), 'info', NOTICE_MS, { label: 'Show', run: () => void showMention(ctx, first) })
      }
    }

    // A board opened for the first time may still be empty: wait until its data has arrived.
    const arm = () => {
      if (timer || done || !isBoardDocReady(doc)) return
      meta.unobserve(arm)
      timer = setTimeout(check, SETTLE_MS)
    }
    meta.observe(arm)
    arm()
    return () => {
      meta.unobserve(arm)
      if (timer) clearTimeout(timer)
    }
    // The context object changes with read-only state; the check belongs to the board itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.doc, ctx.boardId, ctx.isHome])
  return null
}
