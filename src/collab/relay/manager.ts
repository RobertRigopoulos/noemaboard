/**
 * Decides which boards sync through a relay and keeps one RelayConnection per board.
 *
 *  - A board uses the relay set on itself (BoardMeta.relay / LibraryEntry.relay) or inherited from
 *    the nearest parent board that has one, so nested boards stay available too. Home never syncs.
 *  - Open boards and the most recently opened relay boards stay connected in the background (their
 *    docs are kept open so teammates' changes arrive even while the board is not on screen); nested
 *    boards never opened on this device are not, to spare the relay's per-IP connection budget.
 *    Boards with changes the relay has not confirmed stay connected until it has.
 *  - Presence is forwarded for boards that are open; new files are uploaded; missing files are
 *    fetched from the relay.
 */
import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { DEFAULT_RELAY, HOME_BOARD_ID } from '../../config'
import { getMeta, readMeta } from '../../model/board'
import { isValidId } from '../../model/ids'
import { onBlobPut, registerBlobFetcher } from '../blobs'
import { docs, type DocHandle } from '../docs'
import { getLibraryEntry, useLibrary, type LibraryEntry } from '../library'
import { onAwarenessCreated, onAwarenessDestroyed, peekAwareness } from '../presence'
import { RelayBlobSync, downloadBlob, type BlobTarget } from './blobs'
import { RelayConnection } from './connection'
import { deriveRelayKeys } from './keys'
import { localStateStore, type RelayStateStore } from './state'
import { setRelayStatus } from './status'
import { MIXED_CONTENT_MESSAGE, isBlockedMixedContent, parseRelayUrl } from './url'

/** Recently opened relay boards kept connected in the background (each is a WebSocket + an open doc). */
const MAX_BACKGROUND = 16
const RESCAN_MS = 5 * 60_000

interface Running {
  /** Relay address as configured (canonical when valid). */
  url: string
  conn: RelayConnection | null
  handle: DocHandle | null
}

/** Relay address a board syncs through: its own, else the nearest ancestor's. */
export function effectiveRelay(
  boardId: string,
  entries: Record<string, LibraryEntry>,
  fallback: string = DEFAULT_RELAY,
): string | null {
  const seen = new Set<string>()
  let cur: string | null = boardId
  let shared = false
  while (cur && cur !== HOME_BOARD_ID && !seen.has(cur) && seen.size < 32) {
    seen.add(cur)
    const e: LibraryEntry | undefined = entries[cur]
    if (!e) break
    if (typeof e.relay === 'string' && e.relay.trim()) return parseRelayUrl(e.relay)?.canonical ?? e.relay
    shared ||= e.shared
    cur = e.parentId
  }
  // The team's sync server (set at build time) keeps shared boards available; private boards stay local.
  return shared && fallback ? (parseRelayUrl(fallback)?.canonical ?? null) : null
}

export class RelayManager {
  private running = new Map<string, Running>()
  private metaWatchers = new Map<string, () => void>()
  private started = false
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null
  private blobs: RelayBlobSync

  constructor(private store: RelayStateStore = localStateStore) {
    this.blobs = new RelayBlobSync(store, (id) => this.targetFor(id))
  }

  start() {
    if (this.started) return
    this.started = true
    useLibrary.subscribe(() => this.scheduleReconcile())
    for (const id of docs.loadedIds()) {
      const doc = docs.peek(id)
      if (doc) this.watchMeta(id, doc)
    }
    docs.onLoad((id, doc) => this.watchMeta(id, doc))
    docs.onUnload((id, doc) => {
      this.metaWatchers.get(id)?.()
      this.metaWatchers.delete(id)
      // We hold our docs open, so this only happens when a board's local data is deleted.
      const r = this.running.get(id)
      if (r?.handle?.doc === doc) {
        this.stopBoard(id, !getLibraryEntry(id))
        this.scheduleReconcile()
      }
    })
    onAwarenessCreated((boardId, a) => {
      this.attachAwareness(boardId, a)
      // Open boards always sync, whether or not they were opened before.
      if (!this.running.has(boardId)) this.scheduleReconcile()
    })
    onAwarenessDestroyed((boardId, a) => {
      const r = this.running.get(boardId)
      if (r?.conn && r.handle?.doc === a.doc) r.conn.detachAwareness()
      this.scheduleReconcile()
    })
    onBlobPut((hash, _rec, boardId) => {
      if (boardId && boardId !== HOME_BOARD_ID) this.blobs.enqueue(boardId, hash)
    })
    registerBlobFetcher((hash, boardId) => this.fetchBlob(hash, boardId))
    // Picks up boards whose changes got confirmed (may disconnect) and files added by others.
    setInterval(() => {
      this.scheduleReconcile()
      for (const [id, r] of this.running) {
        if (r.conn?.connected && r.handle) this.blobs.scanBoard(id, r.handle.doc, r.conn.relayEndpoint.wsBase)
      }
    }, RESCAN_MS)
    this.scheduleReconcile()
  }

  private scheduleReconcile() {
    if (this.reconcileTimer) return
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null
      this.reconcile()
    }, 300)
  }

  /**
   * The board's own meta is authoritative once loaded: mirror a removed or changed relay address
   * into the library (docs.ts only copies non-null values).
   */
  private watchMeta(id: string, doc: Y.Doc) {
    if (id === HOME_BOARD_ID || this.metaWatchers.has(id)) return
    const meta = getMeta(doc)
    const check = () => {
      if (!meta.get('id')) return
      const relay = readMeta(doc).relay
      const want = relay && relay.trim() ? relay : null
      const entry = getLibraryEntry(id)
      if (entry && entry.relay !== want) useLibrary.getState().upsert({ id, relay: want })
    }
    const observer = (e: Y.YMapEvent<unknown>) => {
      if (e.keysChanged.has('relay') || e.keysChanged.has('id')) check()
    }
    meta.observe(observer)
    this.metaWatchers.set(id, () => meta.unobserve(observer))
    check()
  }

  private reconcile() {
    const entries = useLibrary.getState().entries
    const candidates: { id: string; url: string; lastOpened: number }[] = []
    for (const e of Object.values(entries)) {
      if (e.id === HOME_BOARD_ID || !e.secret || !isValidId(e.id)) continue
      const url = effectiveRelay(e.id, entries)
      if (url) candidates.push({ id: e.id, url, lastOpened: e.lastOpened || 0 })
    }
    candidates.sort((a, b) => b.lastOpened - a.lastOpened)
    const byId = new Map(candidates.map((c) => [c.id, c]))
    const desired = new Map<string, string>()
    let background = 0
    for (const c of candidates) {
      // Every socket counts against the relay's per-IP limits, which a whole office behind one
      // address shares: nested boards this person never opened are not kept connected (they
      // connect once opened, and their authors' apps push their changes).
      const open = peekAwareness(c.id) !== undefined
      if (open || (c.lastOpened > 0 && background < MAX_BACKGROUND)) {
        desired.set(c.id, c.url)
        background++
      } else if (this.hasUnsyncedChanges(c.id, c.url)) {
        desired.set(c.id, c.url)
      }
    }

    // Deleting the current entry while iterating a Map is safe.
    for (const [id, r] of this.running) {
      const want = desired.get(id)
      if (want === r.url) continue
      const candidate = byId.get(id)
      const relayGone = !candidate || candidate.url !== r.url
      // A board that dropped out of the background set stays until the relay has its changes.
      if (!relayGone && r.conn && !r.conn.clean) continue
      this.stopBoard(id, relayGone)
    }
    for (const [id, url] of desired) if (!this.running.has(id)) void this.startBoard(id, url)
  }

  private hasUnsyncedChanges(id: string, url: string): boolean {
    const r = this.running.get(id)
    if (r?.conn) return !r.conn.clean
    const ep = parseRelayUrl(url)
    return !!ep && this.store.load(id, ep.wsBase).dirty
  }

  private async startBoard(id: string, url: string) {
    const r: Running = { url, conn: null, handle: null }
    this.running.set(id, r)
    const ep = parseRelayUrl(url)
    if (!ep) {
      setRelayStatus(id, { url, state: 'error', message: 'The relay address is not valid. Use wss://, https://, ws:// or http://.' })
      return
    }
    // A plain ws:// relay (e.g. set by a desktop teammate for their local network) can never work
    // from an https page: say why instead of failing on every attempt.
    if (isBlockedMixedContent(ep, typeof location !== 'undefined' ? location.protocol : undefined)) {
      setRelayStatus(id, { url: ep.display, state: 'error', message: MIXED_CONTENT_MESSAGE })
      return
    }
    setRelayStatus(id, { url: ep.display, state: 'connecting' })
    try {
      const secret = getLibraryEntry(id)?.secret
      if (!secret) throw new Error('missing secret')
      const keys = await deriveRelayKeys(secret)
      if (this.running.get(id) !== r) return
      const handle = docs.open(id)
      r.handle = handle
      await handle.ready
      if (this.running.get(id) !== r) return
      const conn = new RelayConnection({
        boardId: id,
        endpoint: ep,
        keys,
        doc: handle.doc,
        store: this.store,
        onStatus: (s) => {
          if (this.running.get(id) === r) setRelayStatus(id, s)
        },
        onWelcome: () => this.blobs.scanBoard(id, handle.doc, ep.wsBase),
      })
      r.conn = conn
      conn.start()
      const a = peekAwareness(id)
      if (a) this.attachAwareness(id, a)
    } catch (e) {
      if (this.running.get(id) !== r) return
      console.warn('[relay] could not start relay sync for', id, e)
      setRelayStatus(id, { url: ep.display, state: 'error', message: 'Could not start relay sync for this board.' })
    }
  }

  private stopBoard(id: string, forget: boolean) {
    const r = this.running.get(id)
    if (!r) return
    this.running.delete(id)
    r.conn?.stop({ forget })
    r.handle?.release()
    if (forget) {
      this.blobs.forget(id)
      if (!r.conn) this.store.clear(id)
    }
    setRelayStatus(id, null)
  }

  private attachAwareness(boardId: string, a: Awareness) {
    const r = this.running.get(boardId)
    // The awareness must belong to the same doc instance we sync.
    if (r?.conn && r.handle?.doc === a.doc) r.conn.attachAwareness(a)
  }

  private async targetFor(boardId: string): Promise<BlobTarget | null> {
    const r = this.running.get(boardId)
    if (r?.conn) return { endpoint: r.conn.relayEndpoint, keys: r.conn.relayKeys }
    const entries = useLibrary.getState().entries
    const url = effectiveRelay(boardId, entries)
    const secret = entries[boardId]?.secret
    const ep = url ? parseRelayUrl(url) : null
    if (!ep || !secret) return null
    return { endpoint: ep, keys: await deriveRelayKeys(secret) }
  }

  private async fetchBlob(hash: string, boardId: string | null): Promise<Blob | null> {
    const targets: BlobTarget[] = []
    if (boardId) {
      const t = await this.targetFor(boardId).catch(() => null)
      // Boards without a relay are none of our business.
      if (!t) return null
      targets.push(t)
    }
    // Cards can move between boards, so the file may live in another board's room on the same relay.
    for (const [id, r] of this.running) {
      if (targets.length >= 6) break
      if (id === boardId || !r.conn) continue
      if (targets.length && r.conn.relayEndpoint.wsBase !== targets[0].endpoint.wsBase) continue
      targets.push({ endpoint: r.conn.relayEndpoint, keys: r.conn.relayKeys })
    }
    for (const t of targets) {
      try {
        const b = await downloadBlob(t, hash)
        if (b) return b
      } catch {
        // try the next room
      }
    }
    return null
  }
}
