/**
 * App-level board management: Home bootstrap, joining shared boards from invite links,
 * creating invite links, leaving boards.
 */
import * as Y from 'yjs'
import { HOME_BOARD_ID } from '../config'
import { isValidId } from '../model/ids'
import {
  createCard,
  getCards,
  getMeta,
  initBoardDoc,
  isTrashed,
  maxZ,
  readCard,
  readMeta,
  unsortedTailKeys,
  updateMeta,
  SYSTEM_ORIGIN,
} from '../model/board'
import { docs } from './docs'
import { getUser } from './identity'
import { getLibraryEntry, isProvisionalSecret, secretOwner, useLibrary } from './library'
import { makeInviteLink, makeDesktopLink, type InvitePayload } from './links'

export async function ensureHome() {
  await docs.withDoc(HOME_BOARD_ID, (doc) => {
    initBoardDoc(doc, { id: HOME_BOARD_ID, title: 'Home' }, getUser().id)
  })
}

/** Finds a free spot on a board to the right of existing free cards. */
function freeSpot(cards: ReturnType<typeof getCards>): { x: number; y: number } {
  let maxX = 0
  let minY = Infinity
  cards.forEach((m) => {
    if (m.get('parent') || isTrashed(m)) return
    const c = readCard(m)
    if (c.type === 'line') return
    maxX = Math.max(maxX, c.x + c.w)
    minY = Math.min(minY, c.y)
  })
  if (!Number.isFinite(minY)) return { x: 80, y: 80 }
  return { x: Math.round((maxX + 40) / 10) * 10, y: Math.round(minY / 10) * 10 }
}

/**
 * Adds a board card that arrived on its own (an accepted invite, a board left behind by leaving
 * its parent) to Home's Unsorted drawer. Automatic, so not undoable. It still gets a free spot on
 * the canvas, where versions without the drawer show it.
 */
function addBoardToHome(home: Y.Doc, fields: { boardId: string; secret: string; title: string }, userId: string) {
  home.transact(() => {
    const at = freeSpot(getCards(home))
    const [order] = unsortedTailKeys(home, 1)
    createCard(home, 'board', { ...fields, x: at.x, y: at.y, unsorted: true, order }, userId)
  }, SYSTEM_ORIGIN)
}

/**
 * The invite's key differs from the key this device already has for that board (or belongs to
 * another board). Accepting it would move the board, and every board inside it, into the room of
 * whoever made the link, so it is never applied silently.
 */
export class BoardKeyMismatchError extends Error {
  constructor(
    readonly boardId: string,
    /** The known key was only learned from a board card and the board has no content here: the
     * user may choose to trust the link instead (joinBoard with `replaceUnverifiedKey`). */
    readonly replaceable: boolean,
  ) {
    super("This link doesn't match the board you already have.")
    this.name = 'BoardKeyMismatchError'
  }
}

export interface JoinOptions {
  /**
   * When the invite's key does not match the board this device already has:
   *  - 'open' (default): nothing changes; the existing board's id is returned so it just opens
   *    (Home when the key belongs to another board),
   *  - 'throw': reject with a BoardKeyMismatchError so the UI can explain.
   */
  onMismatch?: 'open' | 'throw'
  /**
   * The user confirmed that the invite's key may replace a key this device only learned from a
   * board card (never from an invite or by creating the board) for a board with no local content.
   */
  replaceUnverifiedKey?: boolean
}

export type InviteCheck = { status: 'new' | 'same' } | { status: 'mismatch'; replaceable: boolean }

async function hasLocalContent(boardId: string): Promise<boolean> {
  return docs.withDoc(boardId, (doc) => getMeta(doc).get('id') !== undefined || getCards(doc).size > 0)
}

/** How an invite relates to the boards this device knows. */
export async function checkInvite(invite: InvitePayload): Promise<InviteCheck> {
  const entries = useLibrary.getState().entries
  const owner = secretOwner(entries, invite.k)
  if (owner !== undefined && owner !== invite.b) return { status: 'mismatch', replaceable: false }
  const existing = entries[invite.b]
  if (!existing?.secret) return { status: 'new' }
  if (existing.secret === invite.k) return { status: 'same' }
  const replaceable = isProvisionalSecret(existing) && !existing.shared && !(await hasLocalContent(invite.b))
  return { status: 'mismatch', replaceable }
}

/**
 * Board ids linked by board cards of a board (trashed cards included: they can be restored).
 * `verified`: only cards carrying the board's known key (anyone in a shared board can add a card
 * naming any id, and such a card must never make one of our boards count as "inside" it).
 */
async function linkedBoards(boardId: string, verified = false): Promise<string[]> {
  const entries = useLibrary.getState().entries
  return docs.withDoc(boardId, (doc) => {
    const out = new Set<string>()
    getCards(doc).forEach((m) => {
      if (!(m instanceof Y.Map) || m.get('type') !== 'board') return
      const b = m.get('boardId')
      if (!isValidId(b) || b === boardId || b === HOME_BOARD_ID) return
      const known = entries[b]?.secret
      if (verified && known && m.get('secret') !== known) return
      out.add(b)
    })
    return [...out]
  })
}

/** True when `parentId` has an active board card for `childId` (with `secret`, when given). */
async function hasActiveCard(parentId: string, childId: string, secret?: string): Promise<boolean> {
  return docs.withDoc(parentId, (doc) => {
    let ok = false
    getCards(doc).forEach((m) => {
      if (ok || !(m instanceof Y.Map) || isTrashed(m) || m.get('type') !== 'board' || m.get('boardId') !== childId) return
      if (!secret || m.get('secret') === secret) ok = true
    })
    return ok
  })
}

/**
 * True when the library's parent chain of a board really leads to Home: every parent is a board
 * we know whose doc has an active board card for the child (with the child's key). A parent link
 * learned long ago may point at a board that was left, deleted or no longer contains the card.
 */
export async function isReachableFromHome(boardId: string, secret?: string): Promise<boolean> {
  const entries = useLibrary.getState().entries
  const seen = new Set<string>([boardId])
  let child = boardId
  let childSecret = secret ?? entries[boardId]?.secret
  for (let hops = 0; hops < 32; hops++) {
    const parent = entries[child]?.parentId
    if (!parent || seen.has(parent)) return false
    if (parent !== HOME_BOARD_ID && !entries[parent]?.secret) return false
    if (!(await hasActiveCard(parent, child, childSecret || undefined))) return false
    if (parent === HOME_BOARD_ID) return true
    seen.add(parent)
    child = parent
    childSecret = entries[parent].secret
  }
  return false
}

/**
 * Accepts an invite: remembers the board's secret, puts a board card on Home (once) and
 * marks it shared so the sync engine joins its room. Returns the board id to open.
 *
 * An invite never changes the key of a board this device already has (see JoinOptions).
 */
export async function joinBoard(invite: InvitePayload, opts: JoinOptions = {}): Promise<string> {
  const check = await checkInvite(invite)
  const replacing = check.status === 'mismatch' && check.replaceable && opts.replaceUnverifiedKey === true
  if (check.status === 'mismatch' && !replacing) {
    if (opts.onMismatch === 'throw') throw new BoardKeyMismatchError(invite.b, check.replaceable)
    console.warn('[join] the invite link does not match the board this device already has; nothing was changed')
    return getLibraryEntry(invite.b) ? invite.b : HOME_BOARD_ID
  }
  const existing = getLibraryEntry(invite.b)
  // The board's own meta decides its relay once we have it (relay manager); a link may only fill
  // in a relay for a board we know nothing about yet.
  const metaLoaded = existing ? await docs.withDoc(invite.b, (doc) => getMeta(doc).get('id') !== undefined) : false
  const relay = existing?.relay || metaLoaded ? undefined : (invite.r ?? null)
  // Only a parent that still has this board's card (and is itself reachable) keeps it off Home.
  const reachable = !!existing?.parentId && existing.parentId !== HOME_BOARD_ID && (await isReachableFromHome(invite.b, invite.k))
  useLibrary.getState().upsert({
    id: invite.b,
    secret: invite.k,
    secretFrom: 'invite',
    title: existing?.title && existing.title !== 'Untitled board' ? existing.title : invite.t,
    parentId: reachable ? existing!.parentId : HOME_BOARD_ID,
    shared: true,
    ...(relay !== undefined ? { relay } : {}),
    lastOpened: Date.now(),
  })
  await ensureHome()
  await docs.withDoc(HOME_BOARD_ID, (home) => {
    const cards = getCards(home)
    let found = false
    let trashedId: string | null = null
    let trashedAt = -Infinity
    const ours: Y.Map<unknown>[] = []
    cards.forEach((m, id) => {
      if (!(m instanceof Y.Map) || m.get('type') !== 'board' || m.get('boardId') !== invite.b) return
      if (!isTrashed(m)) {
        found = true
        ours.push(m)
      } else if (!m.get('movedTo')) {
        const at = m.get('trashedAt') as number
        if (at > trashedAt) {
          trashedAt = at
          trashedId = id
        }
      }
    })
    const user = getUser().id
    home.transact(() => {
      // Re-joining a board whose card was deleted from Home brings back that card only (not the
      // other cards deleted together with it).
      if (!found && trashedId) {
        const m = cards.get(trashedId)!
        for (const k of ['trashedAt', 'trashedBy', 'trashGroup', 'movedTo']) if (m.has(k)) m.delete(k)
        const parent = m.get('parent')
        if (typeof parent === 'string' && parent) {
          const pm = cards.get(parent)
          if (!pm || isTrashed(pm)) m.set('parent', null)
        }
        m.set('z', maxZ(home) + 1)
        m.set('updatedAt', Date.now())
        m.set('updatedBy', user)
        ours.push(m)
        found = true
      }
      // Cards on Home carry the key we now trust.
      for (const m of ours) if (m.get('secret') !== invite.k) m.set('secret', invite.k)
    }, SYSTEM_ORIGIN)
    // Only add to Home when we don't already reach it through another board.
    if (!found && !reachable) addBoardToHome(home, { boardId: invite.b, secret: invite.k, title: invite.t }, user)
  })
  return invite.b
}

/** Builds invite links for a board, marking it shared (so everyone keeps its room open). */
export async function createInvite(boardId: string): Promise<{ web: string; desktop: string; payload: InvitePayload } | null> {
  const entry = getLibraryEntry(boardId)
  if (!entry?.secret) return null
  let title = entry.title
  let relay = entry.relay
  await docs.withDoc(boardId, (doc) => {
    const meta = readMeta(doc)
    title = meta.title
    relay = meta.relay ?? relay
    if (!meta.shared) updateMeta(doc, { shared: true }, SYSTEM_ORIGIN)
  })
  useLibrary.getState().upsert({ id: boardId, shared: true })
  const payload: InvitePayload = { b: boardId, k: entry.secret, t: title }
  if (relay) payload.r = relay
  return { web: makeInviteLink(payload), desktop: makeDesktopLink(payload), payload }
}

/**
 * Boards visited by following board cards from `starts` (never into `skip`; only cards with the
 * right key when `verified`). null when the walk hit its limit.
 */
async function reachableBoards(starts: Iterable<string>, skip: ReadonlySet<string>, verified = false, limit = 5000): Promise<Set<string> | null> {
  const seen = new Set<string>()
  let queue = [...starts]
  while (queue.length) {
    const batch: string[] = []
    for (const id of queue) {
      if (seen.has(id) || skip.has(id) || !isValidId(id) || id === HOME_BOARD_ID) continue
      seen.add(id)
      batch.push(id)
    }
    if (seen.size > limit) return null
    queue = []
    // Only boards this device has (a key, or local data) can lead further.
    const readable = batch.filter((id) => !!useLibrary.getState().entries[id] || !!docs.peek(id))
    for (let i = 0; i < readable.length; i += 16) {
      const links = await Promise.all(readable.slice(i, i + 16).map((id) => linkedBoards(id, verified).catch(() => [] as string[])))
      for (const l of links) queue.push(...l)
    }
  }
  return seen
}

/**
 * Removes a shared board from this device (other people keep their copies), together with the
 * boards inside it that nothing else on this device leads to: from Home, from another shared
 * board, or because they were joined with their own invite (those move onto Home instead).
 */
export async function leaveBoard(boardId: string) {
  let homeLinks: string[] = []
  await docs.withDoc(HOME_BOARD_ID, (home) => {
    const cards = getCards(home)
    const ids: string[] = []
    cards.forEach((m, id) => {
      if (m.get('type') === 'board' && m.get('boardId') === boardId) ids.push(id)
    })
    home.transact(() => ids.forEach((id) => cards.delete(id)), SYSTEM_ORIGIN)
  })
  homeLinks = await linkedBoards(HOME_BOARD_ID)

  const left = new Set([boardId])
  const entries = () => useLibrary.getState().entries
  // Everything inside the left board: through its cards (with the right keys), and through parent
  // links in the library. The keep-walks below follow every card: keeping too much is harmless.
  const inside = (await reachableBoards([boardId], new Set(), true)) ?? new Set<string>()
  inside.delete(boardId)
  for (const e of Object.values(entries())) {
    let cur: string | null = e.parentId
    for (let hops = 0; cur && hops < 32; hops++) {
      if (cur === boardId) {
        inside.add(e.id)
        break
      }
      cur = entries()[cur]?.parentId ?? null
    }
  }

  const remove: string[] = []
  const toHome: string[] = []
  if (inside.size) {
    // Roots that keep boards: Home, boards joined by invite, shared boards outside the left one.
    const invited = [...inside].filter((id) => entries()[id]?.secretFrom === 'invite')
    const sharedOutside = Object.values(entries())
      .filter((e) => e.shared && e.id !== boardId && !inside.has(e.id))
      .map((e) => e.id)
    const fromHome = await reachableBoards([...homeLinks, ...sharedOutside], left)
    const fromInvites = await reachableBoards(invited, left)
    // A walk that hit its limit proves nothing: then only the left board itself goes.
    if (fromHome && fromInvites) {
      for (const id of inside) if (!fromHome.has(id) && !fromInvites.has(id)) remove.push(id)
      for (const id of invited) if (!fromHome.has(id)) toHome.push(id)
    }
  }

  // Boards joined with their own invite stay; they were only reachable through the left board.
  if (toHome.length) {
    for (const id of toHome) useLibrary.getState().upsert({ id, parentId: HOME_BOARD_ID })
    await docs.withDoc(HOME_BOARD_ID, (home) => {
      const user = getUser().id
      for (const id of toHome) {
        const e = getLibraryEntry(id)
        if (e?.secret) addBoardToHome(home, { boardId: id, secret: e.secret, title: e.title }, user)
      }
    })
  }

  const gone = [boardId, ...remove]
  // Library first: rooms close and nothing re-opens these boards while their data is deleted.
  useLibrary.getState().removeMany(gone)
  for (const id of gone) await docs.destroyLocal(id)
}

/** Breadcrumb chain from Home to the board, using parent links from the library. */
export function breadcrumbs(boardId: string): { id: string; title: string; icon: string | null }[] {
  const lib = useLibrary.getState().entries
  const chain: { id: string; title: string; icon: string | null }[] = []
  const seen = new Set<string>()
  let cur: string | null = boardId
  while (cur && cur !== HOME_BOARD_ID && !seen.has(cur) && chain.length < 32) {
    seen.add(cur)
    const e: (typeof lib)[string] | undefined = lib[cur]
    chain.unshift({ id: cur, title: e?.title ?? 'Board', icon: e?.icon ?? null })
    cur = e?.parentId ?? null
  }
  chain.unshift({ id: HOME_BOARD_ID, title: 'Home', icon: null })
  return chain
}
