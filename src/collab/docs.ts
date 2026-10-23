/**
 * Loads board Y.Docs from local storage (IndexedDB) and keeps them in memory while used.
 * Sync providers (peer-to-peer, relay) subscribe to load/unload events.
 */
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { HOME_BOARD_ID } from '../config'
import { isValidId } from '../model/ids'
import { getCards, getMeta, isTrashed, readMeta, SYSTEM_ORIGIN } from '../model/board'
import { CARD_COLORS } from '../model/types'
import { BOARD_TITLE_MAX, cleanTitle, sanitizeIcon } from '../cards/structure/helpers'
import { STORAGE_PREFIX } from './profile'
import { getLibraryEntry, secretOwner, useLibrary, type LibraryEntry } from './library'
import { reportBoardStorageFailure, reportBoardStorageOk } from './storageHealth'
import { MAX_LINKS_PER_BOARD } from './sync/scope'

interface Entry {
  doc: Y.Doc
  persistence: IndexeddbPersistence | null
  /** Resolves once local data was loaded, or after a timeout (never blocks the UI forever). */
  ready: Promise<void>
  /** Local data really was loaded (not just the timeout). */
  loaded: boolean
  /** The database failed (open, load or write): changes are not being saved. */
  storageError: boolean
  refs: number
  idleTimer: ReturnType<typeof setTimeout> | null
  cleanup: () => void
}

export interface DocHandle {
  doc: Y.Doc
  /** Resolves once local data has been loaded into the doc (or loading gave up, see `isLoaded`). */
  ready: Promise<void>
  release: () => void
}

type Listener = (id: string, doc: Y.Doc) => void

const IDLE_UNLOAD_MS = 60_000
/** `ready` resolves after this long even when the database does not answer. */
const LOAD_TIMEOUT_MS = 8000
/** A database that has still not loaded after this long is reported as broken. */
const LOAD_STALL_MS = 30_000

export function dbNameFor(boardId: string) {
  return `${STORAGE_PREFIX}board:${boardId}`
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name)
      // "blocked": other tabs are asked to close their connections; the delete finishes afterwards.
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}

class DocRegistry {
  private entries = new Map<string, Entry>()
  private loadListeners = new Set<Listener>()
  private unloadListeners = new Set<Listener>()
  /** Set to true in tests to skip IndexedDB. */
  memoryOnly = typeof indexedDB === 'undefined'

  open(id: string): DocHandle {
    let e = this.entries.get(id)
    if (!e) e = this.load(id)
    e.refs++
    if (e.idleTimer) {
      clearTimeout(e.idleTimer)
      e.idleTimer = null
    }
    let released = false
    const entry = e
    return {
      doc: e.doc,
      ready: e.ready,
      release: () => {
        if (released) return
        released = true
        entry.refs--
        if (entry.refs <= 0 && this.entries.get(id) === entry) this.scheduleUnload(id)
      },
    }
  }

  /** Runs `fn` with a loaded doc, keeping it open only for the duration. */
  async withDoc<T>(id: string, fn: (doc: Y.Doc) => T | Promise<T>): Promise<T> {
    const h = this.open(id)
    try {
      await h.ready
      return await fn(h.doc)
    } finally {
      h.release()
    }
  }

  peek(id: string): Y.Doc | undefined {
    return this.entries.get(id)?.doc
  }

  loadedIds(): string[] {
    return Array.from(this.entries.keys())
  }

  /** True once the board's local data was really loaded (false while loading, or when the database failed). */
  isLoaded(id: string): boolean {
    const e = this.entries.get(id)
    return !!e && e.loaded && !e.storageError
  }

  /** False when changes to this (open) board are not being saved on this device. */
  isSaving(id: string): boolean {
    const e = this.entries.get(id)
    return !e || !e.storageError
  }

  onLoad(l: Listener): () => void {
    this.loadListeners.add(l)
    return () => this.loadListeners.delete(l)
  }

  onUnload(l: Listener): () => void {
    this.unloadListeners.add(l)
    return () => this.unloadListeners.delete(l)
  }

  /** Deletes a board's local data (used when leaving a shared board). */
  async destroyLocal(id: string) {
    const e = this.entries.get(id)
    if (e) {
      // A pending idle unload belongs to this entry; it must never touch a board opened again later.
      if (e.idleTimer) clearTimeout(e.idleTimer)
      e.idleTimer = null
      this.unloadListeners.forEach((l) => l(id, e.doc))
      e.cleanup()
      if (this.entries.get(id) === e) this.entries.delete(id)
      await e.persistence?.destroy().catch(() => {})
      e.doc.destroy()
    }
    // Also when the database never opened properly (clearData() would then skip the delete).
    if (!this.memoryOnly) await deleteDatabase(dbNameFor(id))
    reportBoardStorageOk(id)
  }

  private load(id: string): Entry {
    const doc = new Y.Doc({ guid: id })
    const entry: Entry = {
      doc,
      persistence: null,
      ready: Promise.resolve(),
      loaded: this.memoryOnly,
      storageError: false,
      refs: 0,
      idleTimer: null,
      cleanup: () => {},
    }
    if (!this.memoryOnly) {
      const persistence = this.persist(id, doc, entry)
      entry.persistence = persistence
      const synced = persistence.whenSynced.then(() => {
        entry.loaded = true
        if (!entry.storageError) reportBoardStorageOk(id)
      })
      // Still not loaded: warn (cleared again if it loads after all, see `synced`).
      const stall = setTimeout(() => {
        if (!entry.loaded && this.entries.get(id) === entry) reportBoardStorageFailure(id, new Error('the board database did not load'))
      }, LOAD_STALL_MS)
      void synced.then(() => clearTimeout(stall))
      // Never block the UI forever on a broken database; isLoaded() tells the two cases apart.
      entry.ready = Promise.race([synced, new Promise<void>((r) => setTimeout(r, LOAD_TIMEOUT_MS))])
    }
    entry.cleanup = indexDoc(id, doc, () => entry.loaded && !entry.storageError)
    this.entries.set(id, entry)
    void entry.ready.then(() => {
      if (this.entries.get(id) === entry) this.loadListeners.forEach((l) => l(id, doc))
    })
    return entry
  }

  /**
   * y-indexeddb with failures made visible: a database that cannot be opened or written is
   * reported (instead of edits silently going nowhere), and a write to a closed database can
   * never throw inside a Yjs transaction.
   */
  private persist(id: string, doc: Y.Doc, entry: Entry): IndexeddbPersistence {
    const p = new IndexeddbPersistence(dbNameFor(id), doc)
    const fail = (err: unknown) => {
      if (p._destroyed || this.entries.get(id) !== entry) return
      entry.storageError = true
      reportBoardStorageFailure(id, err)
    }
    let openFailed = false
    p._db.then(
      (db) => {
        db.addEventListener('error', (ev) => fail((ev.target as IDBRequest | null)?.error ?? ev))
        db.addEventListener('abort', (ev) => fail((ev.target as IDBTransaction | null)?.error ?? ev))
        // Closed by the browser (storage cleared, disk failure), not by us.
        db.addEventListener('close', () => fail(new Error('the board database was closed')))
      },
      (err) => {
        openFailed = true
        fail(err)
      },
    )
    const original = p._storeUpdate
    const safe = (update: Uint8Array, origin: unknown) => {
      if (origin === p) return
      if (openFailed) {
        // Re-warns (throttled) while the user keeps editing a board that cannot be saved.
        fail(new Error('the board database could not be opened'))
        return
      }
      try {
        original(update, origin)
      } catch (err) {
        fail(err)
      }
    }
    doc.off('update', original)
    doc.on('update', safe)
    // destroy() unregisters whatever _storeUpdate holds.
    p._storeUpdate = safe
    return p
  }

  private scheduleUnload(id: string) {
    const e = this.entries.get(id)
    if (!e || e.idleTimer) return
    e.idleTimer = setTimeout(() => {
      e.idleTimer = null
      // Reopened, or deleted (and maybe created again) meanwhile: not ours to unload.
      if (e.refs > 0 || this.entries.get(id) !== e) return
      this.unloadListeners.forEach((l) => l(id, e.doc))
      e.cleanup()
      this.entries.delete(id)
      // A board that never got any content (e.g. a board card whose board nobody ever sent us)
      // leaves no empty database behind.
      const empty = e.loaded && !e.storageError && e.doc.store.clients.size === 0
      if (empty && e.persistence) e.persistence.clearData().catch(() => {})
      // Destroying the doc also lets y-indexeddb flush and close.
      else e.persistence?.destroy().catch(() => {})
      e.doc.destroy()
    }, IDLE_UNLOAD_MS)
  }
}

export const docs = new DocRegistry()

// ---------------------------------------------------------------------------
// Library indexing. Board docs come from peers: everything copied into the library is clamped.

const COLORS = new Set<string>(CARD_COLORS)
const MAX_RELAY_URL = 512

export const cleanBoardTitle = (v: unknown): string => cleanTitle(v, BOARD_TITLE_MAX) || 'Untitled board'
export const cleanBoardColor = (v: unknown): string | null => (typeof v === 'string' && COLORS.has(v) ? v : null)
const cleanRelay = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_RELAY_URL ? v : null)
const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/

interface CardLink {
  boardId: string
  secret: string
  title: unknown
  trashed: boolean
}

/**
 * Keeps the library in sync with a loaded doc:
 *  - board cards teach us child board secrets and titles,
 *  - the doc's own meta updates its library entry and the cached title on its parent's card.
 * `loaded` says whether the doc holds its full local data (only then may missing cards prune).
 */
function indexDoc(id: string, doc: Y.Doc, loaded: () => boolean): () => void {
  const cards = getCards(doc)
  const meta = getMeta(doc)
  let timer: ReturnType<typeof setTimeout> | null = null

  const indexCards = () => {
    const lib = useLibrary.getState()
    // One entry per linked board: a card with the key we know wins, then an active card.
    const links = new Map<string, CardLink>()
    const rank = (l: CardLink) => (lib.entries[l.boardId]?.secret === l.secret ? 2 : 0) + (l.trashed ? 0 : 1)
    cards.forEach((m) => {
      if (!(m instanceof Y.Map) || m.get('type') !== 'board') return
      const boardId = m.get('boardId')
      const secret = m.get('secret')
      if (typeof boardId !== 'string' || typeof secret !== 'string' || !isValidId(boardId) || !SECRET_RE.test(secret)) return
      if (boardId === id || boardId === HOME_BOARD_ID) return
      const link: CardLink = { boardId, secret, title: m.get('title'), trashed: isTrashed(m) }
      const prev = links.get(boardId)
      if (!prev || rank(link) > rank(prev)) links.set(boardId, link)
    })
    // A hostile board can carry thousands of fake board cards: only so many new boards are
    // learned per board, boards we already know first.
    const known: CardLink[] = []
    const fresh: CardLink[] = []
    for (const l of links.values()) (lib.entries[l.boardId] ? known : fresh).push(l)
    fresh.sort((a, b) => Number(a.trashed) - Number(b.trashed))
    const learn = [...known, ...fresh.slice(0, Math.max(0, MAX_LINKS_PER_BOARD - known.length))]
    for (const l of learn) {
      const prev = useLibrary.getState().entries[l.boardId]
      // A card may claim any id and any secret: it never replaces a secret we know (see
      // library.upsert), and a secret that belongs to another board is not learned at all.
      if (!prev?.secret) {
        const owner = secretOwner(useLibrary.getState().entries, l.secret)
        if (owner !== undefined && owner !== l.boardId) continue
      }
      // Only a live card with the board's real key is a parent link (a card naming the id with
      // another key must not re-parent one of our boards); a parent we no longer know is replaced.
      const keyMatches = !prev?.secret || prev.secret === l.secret
      const parentGone = !!prev?.parentId && prev.parentId !== HOME_BOARD_ID && !useLibrary.getState().entries[prev.parentId]
      const parentId = !keyMatches || l.trashed || (prev?.parentId && !parentGone) ? undefined : id
      lib.upsert({
        id: l.boardId,
        secret: l.secret,
        secretFrom: 'card',
        title: prev?.title ?? cleanBoardTitle(l.title),
        ...(parentId !== undefined ? { parentId } : {}),
      })
    }
    // Boards learned from this board's cards, never opened or shared, whose card is gone for good.
    if (loaded()) {
      const stale: string[] = []
      for (const e of Object.values(useLibrary.getState().entries) as LibraryEntry[]) {
        if (e.parentId !== id || e.secretFrom !== 'card' || e.lastOpened || e.shared || links.has(e.id) || docs.peek(e.id)) continue
        stale.push(e.id)
      }
      if (stale.length) useLibrary.getState().removeMany(stale)
    }
  }

  const indexMeta = () => {
    if (id === HOME_BOARD_ID || !meta.get('id')) return
    const m = readMeta(doc)
    const title = cleanBoardTitle(m.title)
    const icon = sanitizeIcon(m.icon)
    const color = cleanBoardColor(m.color)
    const prev = getLibraryEntry(id)
    useLibrary.getState().upsert({
      id,
      title,
      icon,
      color,
      shared: (prev?.shared ?? false) || m.shared,
      relay: cleanRelay(m.relay),
    })
    // Refresh the cached title on loaded parents' board cards. Only cards that carry this board's
    // real secret: a card naming our id with another secret (planted by someone who learned the
    // id) must not receive our title, icon and color, which would then sync to its board's peers.
    const secret = getLibraryEntry(id)?.secret
    if (!secret) return
    for (const parentId of docs.loadedIds()) {
      const pdoc = docs.peek(parentId)
      if (!pdoc || pdoc === doc) continue
      const pcards = getCards(pdoc)
      pcards.forEach((c) => {
        if (!(c instanceof Y.Map) || c.get('type') !== 'board' || c.get('boardId') !== id || c.get('secret') !== secret) return
        if (c.get('title') !== title || c.get('icon') !== icon || c.get('color') !== color) {
          pdoc.transact(() => {
            if (c.get('title') !== title) c.set('title', title)
            if (c.get('icon') !== icon) c.set('icon', icon)
            if (c.get('color') !== color) c.set('color', color)
          }, SYSTEM_ORIGIN)
        }
      })
    }
  }

  const schedule = () => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      indexCards()
      indexMeta()
    }, 250)
  }
  cards.observeDeep(schedule)
  meta.observe(schedule)
  schedule()
  return () => {
    if (timer) clearTimeout(timer)
    cards.unobserveDeep(schedule)
    meta.unobserve(schedule)
  }
}
