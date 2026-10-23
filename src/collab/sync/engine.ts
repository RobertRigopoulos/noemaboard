/**
 * Multi-document sync engine.
 *
 * One P2P room per shared board (library entry with `shared: true`). Every board reachable from
 * the room's root through board cards (its "scope") is multiplexed over that room. A separate
 * "local" room (BroadcastChannel) keeps tabs/windows of the same profile in sync, Home included.
 *
 * All singletons (doc registry, library, presence, blob store, status store) are injected so
 * several engines can run side by side in tests.
 */
import type * as Y from 'yjs'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import { applyAwarenessUpdate, encodeAwarenessUpdate, modifyAwarenessUpdate, removeAwarenessStates, type Awareness } from 'y-protocols/awareness'
import { HOME_BOARD_ID } from '../../config'
import { isValidId } from '../../model/ids'
import { MAX_BLOB_BYTES } from '../blobs'
import { deriveRoomId, deriveRoomPassword, hashBytes, isValidBlobHash } from '../crypto'
import {
  MSG_AWARENESS,
  MSG_AWARENESS_RELAY,
  MSG_HELLO,
  MSG_PEERS,
  MSG_SYNC,
  MSG_WANT,
  decodeHeader,
  encodeAwareness,
  encodeAwarenessRelay,
  encodeHello,
  encodePeers,
  ownHello,
  encodeSyncStep1,
  encodeUpdate,
  encodeWant,
  filterAwarenessUpdate,
  isCompatible,
  readAwarenessEntries,
  readHello,
  readPeers,
  sanitizeMime,
  syncReplyEncoder,
  type AwarenessEntry,
  type DecodedMessage,
} from './protocol'
import {
  acceptedChildren,
  computeScope,
  MAX_LINKS_PER_BOARD,
  MAX_SCOPE,
  observeBoardDoc,
  readBlobRefs,
  readBoardLinks,
  readShared,
  type BoardLinks,
} from './scope'
import type { BoardSyncStatus, StatusSink } from './status'
import { TransportUnavailableError, type BlobReply, type RoomTransport, type TransportFactory } from './transport'

// ---------------------------------------------------------------------------
// Injected dependencies

export interface DocHandleLike {
  doc: Y.Doc
  ready: Promise<void>
  release: () => void
}

/** Structural subset of the DocRegistry in collab/docs.ts. */
export interface DocProvider {
  open(id: string): DocHandleLike
  peek(id: string): Y.Doc | undefined
  loadedIds(): string[]
  onLoad(l: (id: string, doc: Y.Doc) => void): () => void
  onUnload(l: (id: string, doc: Y.Doc) => void): () => void
}

export interface LibrarySource {
  /**
   * Boards whose rooms should be open. `trusted: false` marks a secret only learned from a board
   * card (another board with the same secret wins the room).
   */
  sharedBoards(): { id: string; secret: string; trusted?: boolean }[]
  /** Known capability secret of a board, if any. */
  secretOf(id: string): string | undefined
  /** The board that holds this secret, if we know one (a card reusing it for another id is ignored). */
  secretOwner?(secret: string): string | undefined
  subscribe(cb: () => void): () => void
  /** A board in scope is marked shared in its own meta: keep its own room open too. */
  markShared(id: string, secret: string | null): void
}

export interface PresenceSource {
  onAwarenessCreated(l: (boardId: string, a: Awareness) => void): () => void
  onAwarenessDestroyed(l: (boardId: string, a: Awareness) => void): () => void
}

export interface BlobSource {
  get(hash: string): Promise<Blob | null>
  registerFetcher(f: (hash: string, boardId: string | null) => Promise<Blob | null>): () => void
}

export interface RoomCredentials {
  roomId: string
  password: string
}

export interface SyncEngineOptions {
  docs: DocProvider
  library: LibrarySource
  presence: PresenceSource
  blobs: BlobSource
  status: StatusSink
  createTransport: TransportFactory
  /** Same-device transport (BroadcastChannel). Syncs every loaded doc, Home included. */
  localTransport?: RoomTransport | null
  p2pEnabled?: boolean
  homeId?: string
  maxPeersPerRoom?: number
  maxScope?: number
  /** Child boards one board may add to a scope. */
  maxLinksPerBoard?: number
  /** Periodic SyncStep1 to every peer; 0 disables (tests). */
  antiEntropyMs?: number
  scopeDebounceMs?: number
  /** Delay before telling a room which peers we are connected to (batches joins and leaves). */
  peersDebounceMs?: number
  /** First retry after a room could not be joined; doubles up to `retryMaxMs`. */
  retryBaseMs?: number
  retryMaxMs?: number
  awarenessThrottleMs?: number
  statusDelayMs?: number
  blobIdleTimeoutMs?: number
  /** How long a failed direct connection may stay unresolved before we suggest TURN. */
  turnGraceMs?: number
  deriveRoom?: (secret: string) => Promise<RoomCredentials>
  now?: () => number
}

const defaultDeriveRoom = async (secret: string): Promise<RoomCredentials> => ({
  roomId: await deriveRoomId(secret),
  password: await deriveRoomPassword(secret),
})

const TURN_PROBLEM_TTL_MS = 10 * 60_000
const MAX_PEER_ERRORS = 50
/** Blob reads served to one peer at a time; further requests wait their turn. */
const MAX_CONCURRENT_BLOB_REPLIES = 4
/** Waiting blob requests per peer before we start saying "don't have it". */
const MAX_QUEUED_BLOB_REQUESTS = 256
const MAX_AWARENESS_CLIENTS_PER_PEER = 1024
/**
 * A peer may say something about a client another connected peer speaks for directly only up to
 * this far ahead of that peer's clock (messages crossing on two paths), so it cannot push a fake
 * state with a huge clock that would freeze the real one.
 */
const MAX_FOREIGN_CLOCK_LEAD = 16
/** Presence clients tracked per board for relaying and ownership. */
const MAX_TRACKED_CLIENTS = 4096

// ---------------------------------------------------------------------------
// Internal state

type RoomKind = 'p2p' | 'local'

interface Room {
  kind: RoomKind
  /** Root board id (p2p rooms only). */
  rootId: string | null
  secret: string
  roomId: string | null
  transport: RoomTransport | null
  peers: Map<string, RoomPeer>
  /** Boards this room may sync (p2p rooms only; the local room covers every loaded doc). */
  scope: Set<string>
  /** Bumped whenever a pending connect must be abandoned. */
  generation: number
  closed: boolean
  /** Failed joins in a row (reset on success); drives the retry backoff. */
  failures: number
  retryTimer: ReturnType<typeof setTimeout> | null
  /** Pending PEERS announcement. */
  peersTimer: ReturnType<typeof setTimeout> | null
}

/** Transaction origin for changes applied from a peer, so we can tell them from local edits. */
export class RemoteOrigin {
  constructor(
    readonly room: Readonly<{ kind: RoomKind; rootId: string | null }>,
    readonly peerId: string,
  ) {}
}

interface RoomPeer {
  id: string
  origin: RemoteOrigin
  /** Joined while the room was full: ignored until a slot frees up. */
  overflow: boolean
  /**
   * Peers this peer says it exchanges data with in the room (PEERS message). null until it tells
   * us (older versions never do): then we assume it is connected to everyone (full mesh).
   */
  links: Set<string> | null
}

interface PeerInfo {
  rooms: Set<Room>
  /** null until HELLO arrives. */
  compatible: boolean | null
  app: string
  errors: number
  blocked: boolean
  /** Awareness client ids this peer speaks for, per board. */
  clients: Map<string, Set<number>>
  /** Blob reads in progress for this peer, and requests waiting for a free slot. */
  serving: number
  waiting: ((ok: boolean) => void)[]
  /** For other tabs of this profile: their P2P peer id (they are not teammates). */
  p2pId: string | null
}

interface Seed {
  id: string
  handle: DocHandleLike
  doc: Y.Doc
  ready: boolean
  links: BoardLinks
  linksDirty: boolean
  /** File hashes the board's cards refer to; null = recompute on next use. */
  blobs: Set<string> | null
  unobserve: (() => void) | null
}

/** What we know about one presence client of a board (for ownership and relaying). */
interface AwarenessTrack {
  /** Peer that last spoke for the client; `direct` = as its own client, not relayed. */
  owner: string
  direct: boolean
  /** Highest clock the owner sent. */
  ownerClock: number
  /** Highest clock accepted from anyone (relaying only forwards newer ones). */
  seen: number
  at: number
}

interface AwarenessSlot {
  boardId: string
  aw: Awareness
  lastSent: number
  timer: ReturnType<typeof setTimeout> | null
  closing: boolean
  off: () => void
}

function makeRoom(kind: RoomKind, rootId: string | null, secret: string): Room {
  return {
    kind,
    rootId,
    secret,
    roomId: null,
    transport: null,
    peers: new Map(),
    scope: new Set(),
    generation: 0,
    closed: false,
    failures: 0,
    retryTimer: null,
    peersTimer: null,
  }
}

/** y-indexeddb replays stored updates with itself as origin: those are not new edits. */
function isPersistenceOrigin(origin: unknown): boolean {
  return typeof origin === 'object' && origin !== null && '_storeUpdate' in origin && 'whenSynced' in origin
}

export class SyncEngine {
  private readonly o: Required<Omit<SyncEngineOptions, 'localTransport' | 'p2pEnabled'>> & { localTransport: RoomTransport | null }
  private p2pEnabled: boolean
  private started = false
  private stopped = false
  private webrtcUnavailable = false
  /** Our peer id on the P2P network, shared with our other tabs. */
  private p2pSelfId: string | null = null

  /** P2P rooms by root board id. */
  private readonly rooms = new Map<string, Room>()
  private localRoom: Room | null = null
  private readonly peers = new Map<string, PeerInfo>()
  /** Docs held open because they are in some room's scope. */
  private readonly seeds = new Map<string, Seed>()
  /** Every doc loaded (and ready) in this app instance; scope of the local room. */
  private readonly localDocs = new Map<string, Y.Doc>()
  private readonly watched = new Map<Y.Doc, () => void>()
  private readonly awareness = new Map<string, AwarenessSlot>()
  /** Presence clients per board: who speaks for them and the newest clock seen. */
  private readonly awTrack = new Map<string, Map<number, AwarenessTrack>>()
  private readonly lastSync = new Map<string, number>()
  private readonly connectFailures = new Map<string, number>()
  private readonly cleanups: (() => void)[] = []
  private scopeTimer: ReturnType<typeof setTimeout> | null = null
  private statusTimer: ReturnType<typeof setTimeout> | null = null
  private antiEntropyTimer: ReturnType<typeof setTimeout> | null = null
  private readonly problemTimers = new Set<ReturnType<typeof setTimeout>>()
  /** Transports still leaving; new transports wait for them. */
  private readonly pendingLeaves = new Set<Promise<void>>()

  constructor(opts: SyncEngineOptions) {
    this.o = {
      homeId: HOME_BOARD_ID,
      maxPeersPerRoom: 30,
      maxScope: MAX_SCOPE,
      maxLinksPerBoard: MAX_LINKS_PER_BOARD,
      antiEntropyMs: 60_000,
      scopeDebounceMs: 150,
      peersDebounceMs: 250,
      retryBaseMs: 2000,
      retryMaxMs: 60_000,
      awarenessThrottleMs: 50,
      statusDelayMs: 250,
      blobIdleTimeoutMs: 120_000,
      turnGraceMs: 15_000,
      deriveRoom: defaultDeriveRoom,
      now: Date.now,
      ...opts,
      localTransport: opts.localTransport ?? null,
    }
    this.p2pEnabled = opts.p2pEnabled ?? true
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    const { docs, library, presence, blobs } = this.o
    if (this.o.localTransport) {
      this.localRoom = makeRoom('local', null, '')
      this.attach(this.localRoom, this.o.localTransport)
    }
    this.cleanups.push(library.subscribe(() => this.syncRooms()))
    this.cleanups.push(docs.onLoad((id, doc) => this.onDocLoaded(id, doc)))
    this.cleanups.push(docs.onUnload((id, doc) => this.onDocUnloaded(id, doc)))
    for (const id of docs.loadedIds()) {
      const doc = docs.peek(id)
      if (doc) this.onDocLoaded(id, doc)
    }
    this.cleanups.push(presence.onAwarenessCreated((id, a) => this.onAwarenessCreated(id, a)))
    this.cleanups.push(presence.onAwarenessDestroyed((id, a) => this.onAwarenessDestroyed(id, a)))
    this.cleanups.push(blobs.registerFetcher((hash, boardId) => this.fetchBlob(hash, boardId)))
    this.syncRooms()
    this.scheduleAntiEntropy()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const t of [this.scopeTimer, this.statusTimer, this.antiEntropyTimer, ...this.problemTimers]) if (t) clearTimeout(t)
    this.problemTimers.clear()
    this.cleanups.splice(0).forEach((f) => f())
    for (const slot of this.awareness.values()) this.forgetAwareness(slot)
    const leaves: Promise<void>[] = []
    for (const room of this.rooms.values()) {
      room.closed = true
      this.clearRoomTimers(room)
      leaves.push(this.detach(room))
    }
    this.rooms.clear()
    this.awTrack.clear()
    if (this.localRoom) leaves.push(this.detach(this.localRoom))
    for (const s of this.seeds.values()) {
      s.unobserve?.()
      s.handle.release()
    }
    this.seeds.clear()
    for (const off of this.watched.values()) off()
    this.watched.clear()
    await Promise.allSettled(leaves)
  }

  setP2PEnabled(on: boolean): void {
    if (this.p2pEnabled === on) return
    this.p2pEnabled = on
    this.syncRooms()
    this.updateProblems()
  }

  /** Leaves every P2P room and joins again (network settings changed). */
  reconnectAll(): Promise<void> {
    return this.reconnectRooms([...this.rooms.values()])
  }

  /** Network came back: resync now and rejoin rooms that have nobody in them. */
  networkBack(): void {
    this.antiEntropy()
    void this.reconnectRooms([...this.rooms.values()].filter((r) => !r.transport || r.peers.size === 0))
  }

  /** Sends SyncStep1 for every doc to every peer, so both sides converge even after lost messages. */
  antiEntropy(): void {
    if (this.stopped) return
    const done = new Set<string>()
    const rooms = [...this.rooms.values()]
    if (this.localRoom) rooms.push(this.localRoom)
    for (const room of rooms) {
      if (!room.transport) continue
      const peers = this.usablePeers(room)
      if (!peers.length) continue
      for (const [docId, doc] of this.readyDocs(room)) {
        const targets = peers.filter((p) => !done.has(`${p}\n${docId}`))
        if (!targets.length) continue
        for (const p of targets) done.add(`${p}\n${docId}`)
        this.sendTo(room, targets, encodeSyncStep1(docId, doc))
      }
    }
    this.updateProblems()
  }

  /** True while at least one P2P room has a live transport (signaling should be up). */
  hasP2PTransports(): boolean {
    for (const r of this.rooms.values()) if (r.transport) return true
    return false
  }

  /** Snapshot for diagnostics and tests. */
  inspect() {
    return {
      rooms: [...this.rooms.values()].map((r) => ({
        rootId: r.rootId,
        roomId: r.roomId,
        connected: !!r.transport,
        peers: [...r.peers.keys()],
        scope: [...r.scope].sort(),
      })),
      localPeers: this.localRoom ? [...this.localRoom.peers.keys()] : [],
      seeded: [...this.seeds.keys()].sort(),
    }
  }

  // -------------------------------------------------------------------------
  // Rooms

  private syncRooms() {
    if (this.stopped) return
    const desired = new Map<string, string>()
    if (this.p2pEnabled) {
      // Two boards with one secret would share one Trystero room (and the second could never
      // join it): only one may own it. A secret confirmed by creation or an invite beats one only
      // learned from a card; the loser gets its room as soon as the winner is gone.
      const bySecret = new Map<string, { id: string; trusted: boolean }>()
      for (const e of this.o.library.sharedBoards()) {
        if (!isValidId(e.id) || e.id === this.o.homeId || typeof e.secret !== 'string' || !e.secret) continue
        const cand = { id: e.id, trusted: e.trusted !== false }
        const cur = bySecret.get(e.secret)
        if (!cur || this.preferRoomOwner(cand, cur, e.secret)) bySecret.set(e.secret, cand)
      }
      for (const [secret, { id }] of bySecret) desired.set(id, secret)
    }
    for (const [id, room] of this.rooms) if (desired.get(id) !== room.secret) this.closeRoom(room)
    for (const [id, secret] of desired) {
      if (this.rooms.has(id)) continue
      const room = makeRoom('p2p', id, secret)
      this.rooms.set(id, room)
      void this.connectRoom(room)
    }
    this.scheduleScope()
    this.scheduleStatus()
  }

  /** True when `a` should own a room (secret) rather than `b`. */
  private preferRoomOwner(a: { id: string; trusted: boolean }, b: { id: string; trusted: boolean }, secret: string): boolean {
    if (a.trusted !== b.trusted) return a.trusted
    // Keep the room that is already open, so the owner does not flip back and forth.
    const ra = this.rooms.get(a.id)?.secret === secret
    const rb = this.rooms.get(b.id)?.secret === secret
    if (ra !== rb) return ra
    return a.id < b.id
  }

  private async connectRoom(room: Room) {
    const gen = ++room.generation
    if (room.retryTimer) clearTimeout(room.retryTimer)
    room.retryTimer = null
    const stale = () => room.closed || gen !== room.generation || this.stopped
    try {
      const creds = await this.o.deriveRoom(room.secret)
      if (stale()) return
      // Two library entries with the same secret would fight over one Trystero room (syncRooms
      // lets only one of them have a room; this is the last line of defence). Try again later.
      for (const other of this.rooms.values()) {
        if (other !== room && other.roomId === creds.roomId && !other.closed) {
          this.scheduleRetry(room, false)
          return
        }
      }
      // Trystero keeps a strategy's relay config until every room of it has left, and a room id
      // still leaving would be handed back to us: wait for leaves in flight first.
      if (this.pendingLeaves.size) await Promise.allSettled(this.pendingLeaves)
      if (stale()) return
      room.roomId = creds.roomId
      const t = await this.o.createTransport({ roomId: creds.roomId, password: creds.password, label: room.rootId ?? '' })
      if (stale()) {
        void this.trackLeave(t.leave())
        return
      }
      this.webrtcUnavailable = false
      room.failures = 0
      this.attach(room, t)
    } catch (err) {
      if (err instanceof TransportUnavailableError) this.webrtcUnavailable = true
      else if (!stale()) {
        // E.g. the WebRTC code could not be loaded (a new version was deployed meanwhile) or the
        // crypto API failed: keep trying with backoff, and tell the user (see updateProblems).
        console.warn('[sync] could not join room', err)
        this.scheduleRetry(room, true)
      }
    }
    this.updateProblems()
    this.scheduleStatus()
  }

  private scheduleRetry(room: Room, failed: boolean) {
    if (room.closed || this.stopped || room.retryTimer) return
    if (failed) room.failures++
    const delay = Math.min(this.o.retryMaxMs, this.o.retryBaseMs * 2 ** Math.min(Math.max(room.failures - 1, 0), 16))
    room.retryTimer = setTimeout(() => {
      room.retryTimer = null
      if (!room.closed && !this.stopped && !room.transport) void this.connectRoom(room)
    }, delay)
  }

  private clearRoomTimers(room: Room) {
    if (room.retryTimer) clearTimeout(room.retryTimer)
    if (room.peersTimer) clearTimeout(room.peersTimer)
    room.retryTimer = null
    room.peersTimer = null
  }

  private reconnectRooms(rooms: Room[]): Promise<void> {
    if (this.stopped || !rooms.length) return Promise.resolve()
    const leaving = rooms.map((r) => {
      r.generation++
      return this.detach(r)
    })
    // connectRoom waits for these leaves before joining again.
    for (const r of rooms) if (!r.closed) void this.connectRoom(r)
    this.scheduleStatus()
    return Promise.allSettled(leaving).then(() => {})
  }

  private trackLeave(p: Promise<void>): Promise<void> {
    const tracked: Promise<void> = p.catch(() => {}).finally(() => this.pendingLeaves.delete(tracked))
    this.pendingLeaves.add(tracked)
    return tracked
  }

  private closeRoom(room: Room) {
    room.closed = true
    room.generation++
    this.clearRoomTimers(room)
    if (room.rootId && this.rooms.get(room.rootId) === room) this.rooms.delete(room.rootId)
    void this.detach(room)
    this.scheduleScope()
    this.scheduleStatus()
    this.updateProblems()
  }

  private attach(room: Room, t: RoomTransport) {
    room.transport = t
    if (room.kind === 'p2p' && t.selfId && this.p2pSelfId !== t.selfId) {
      this.p2pSelfId = t.selfId
      // Our other tabs connect to us over WebRTC too; tell them who we are so they don't count us.
      const local = this.localRoom
      if (local?.transport) this.sendTo(local, this.usablePeers(local), encodeHello(ownHello(t.selfId)))
    }
    const live = () => room.transport === t && !this.stopped
    t.connect({
      onPeerJoin: (p) => {
        if (live()) this.onPeerJoin(room, p)
      },
      onPeerLeave: (p) => {
        if (live()) this.onPeerLeave(room, p)
      },
      onMessage: (data, p) => {
        if (live()) this.onMessage(room, p, data)
      },
      onBlobRequest: (hash, p) => (live() ? this.serveBlob(room, p, hash) : Promise.resolve(null)),
      onConnectFailure: (p) => {
        if (live()) this.onConnectFailure(p)
      },
    })
    this.scheduleStatus()
  }

  private detach(room: Room): Promise<void> {
    const t = room.transport
    if (!t) return Promise.resolve()
    room.transport = null
    for (const p of room.peers.keys()) this.onPeerLeave(room, p)
    return this.trackLeave(t.leave())
  }

  // -------------------------------------------------------------------------
  // Peers

  private onPeerJoin(room: Room, peerId: string) {
    if (room.closed || typeof peerId !== 'string' || !peerId) return
    const existing = room.peers.get(peerId)
    if (existing) {
      // Reconnected through another path: resync.
      if (!existing.overflow) this.greet(room, peerId)
      return
    }
    let usable = 0
    for (const p of room.peers.values()) if (!p.overflow) usable++
    const overflow = room.kind === 'p2p' && usable >= this.o.maxPeersPerRoom
    room.peers.set(peerId, { id: peerId, origin: new RemoteOrigin(room, peerId), overflow, links: null })
    let info = this.peers.get(peerId)
    if (!info) {
      info = {
        rooms: new Set(),
        compatible: null,
        app: '',
        errors: 0,
        blocked: false,
        clients: new Map(),
        serving: 0,
        waiting: [],
        p2pId: null,
      }
      this.peers.set(peerId, info)
    }
    info.rooms.add(room)
    this.connectFailures.delete(peerId)
    if (!overflow) {
      this.greet(room, peerId)
      this.schedulePeersAnnounce(room)
    }
    this.updateProblems()
    this.scheduleStatus()
  }

  private onPeerLeave(room: Room, peerId: string) {
    const rp = room.peers.get(peerId)
    if (!rp) return
    room.peers.delete(peerId)
    const info = this.peers.get(peerId)
    if (info) {
      info.rooms.delete(room)
      if (!info.rooms.size) {
        this.peers.delete(peerId)
        this.dropAwareness(peerId, info, rp.origin)
        // Blob requests still waiting for a slot will never be answered.
        for (const w of info.waiting.splice(0)) w(false)
      }
    }
    if (!rp.overflow) {
      // A peer that was turned away because the room was full can take the free slot.
      for (const p of room.peers.values()) {
        if (!p.overflow) continue
        p.overflow = false
        this.greet(room, p.id)
        break
      }
      this.schedulePeersAnnounce(room)
    }
    this.updateProblems()
    this.scheduleStatus()
  }

  /**
   * Tells the room's peers whom we exchange data with, so a peer connected to two others that
   * cannot reach each other (partial mesh: NATs, full rooms) relays between them.
   */
  private schedulePeersAnnounce(room: Room) {
    if (room.kind !== 'p2p' || room.peersTimer || room.closed || this.stopped) return
    room.peersTimer = setTimeout(() => {
      room.peersTimer = null
      if (room.closed || this.stopped || !room.transport) return
      const peers = this.usablePeers(room)
      this.sendTo(room, peers, encodePeers(peers))
    }, this.o.peersDebounceMs)
  }

  /**
   * True when `to` did not get a message from `from` directly: either side said (PEERS) it is not
   * connected to the other. Peers that never said (older versions) count as a full mesh.
   */
  private notConnected(room: Room, from: string, to: string): boolean {
    const a = room.peers.get(from)?.links
    const b = room.peers.get(to)?.links
    return (!!a && !a.has(to)) || (!!b && !b.has(from))
  }

  /**
   * A peer told us whom it exchanges data with. Peers of the room it (newly) cannot reach may have
   * missed each other's changes so far: resync both sides through us (we relay from now on).
   */
  private onPeersList(room: Room, rp: RoomPeer, links: Set<string>) {
    const before = rp.links
    rp.links = links
    if (rp.overflow) return
    const missing = this.usablePeers(room).filter((p) => {
      if (p === rp.id || links.has(p)) return false
      // Was connected and is not any more.
      if (before?.has(p)) return true
      // First list from this peer: only when the other side agrees they are apart (connections
      // still being set up when everybody joins at once would otherwise all resync through us).
      const theirs = room.peers.get(p)?.links
      return before === null && !!theirs && !theirs.has(rp.id)
    })
    if (!missing.length) return
    const both = [rp.id, ...missing]
    for (const [docId, doc] of this.readyDocs(room)) {
      // Step1 + WANT: each side sends us what we lack (relayed on to the other side), and our
      // answers to their Step1 carry what they lack.
      this.sendTo(room, both, encodeSyncStep1(docId, doc))
      this.sendTo(room, both, encodeWant(docId))
    }
    // Presence they could not exchange, for boards open here (others renew theirs within 15 s).
    for (const slot of this.awareness.values()) {
      if (slot.closing || !room.scope.has(slot.boardId)) continue
      this.relayPresence(room, slot, rp.id, missing)
      for (const p of missing) this.relayPresence(room, slot, p, [rp.id])
    }
  }

  private relayPresence(room: Room, slot: AwarenessSlot, from: string, to: string[]) {
    const clients = [...(this.peers.get(from)?.clients.get(slot.boardId) ?? [])].filter((c) => slot.aw.meta.has(c))
    if (!clients.length) return
    try {
      this.sendTo(room, to, encodeAwarenessRelay(slot.boardId, encodeAwarenessUpdate(slot.aw, clients)))
    } catch {
      // state changed under us; it is renewed soon anyway
    }
  }

  /** P2P peer ids of our own other tabs (they get everything over the local channel). */
  private ownTabIds(): Set<string> {
    const out = new Set<string>()
    for (const p of this.localRoom?.peers.keys() ?? []) {
      const id = this.peers.get(p)?.p2pId
      if (id) out.add(id)
    }
    return out
  }

  /** HELLO, then SyncStep1 for every doc we share with this peer, then our presence. */
  private greet(room: Room, peerId: string) {
    const to = [peerId]
    this.sendTo(room, to, encodeHello(ownHello(room.kind === 'local' ? this.p2pSelfId : null)))
    for (const [docId, doc] of this.readyDocs(room)) this.sendTo(room, to, encodeSyncStep1(docId, doc))
    for (const slot of this.awareness.values()) {
      if (slot.closing || (room.kind === 'p2p' && !room.scope.has(slot.boardId))) continue
      const msg = this.ownAwareness(slot)
      if (msg) this.sendTo(room, to, msg)
    }
  }

  private usable(info: PeerInfo | undefined): boolean {
    return !!info && info.compatible !== false && !info.blocked
  }

  private usablePeers(room: Room): string[] {
    const out: string[] = []
    for (const p of room.peers.values()) if (!p.overflow && this.usable(this.peers.get(p.id))) out.push(p.id)
    return out
  }

  private onConnectFailure(peerId: string) {
    if (typeof peerId !== 'string' || this.peers.has(peerId)) return
    this.connectFailures.set(peerId, this.o.now())
    // Give the other signaling strategy a chance to connect before we complain.
    const t = setTimeout(() => {
      this.problemTimers.delete(t)
      this.updateProblems()
    }, this.o.turnGraceMs + 10)
    this.problemTimers.add(t)
  }

  private notePeerError(peerId: string) {
    const info = this.peers.get(peerId)
    if (info && ++info.errors > MAX_PEER_ERRORS) info.blocked = true
  }

  // -------------------------------------------------------------------------
  // Messages

  private onMessage(room: Room, peerId: string, data: Uint8Array) {
    if (room.closed || this.stopped) return
    const rp = room.peers.get(peerId)
    const info = this.peers.get(peerId)
    if (!rp || rp.overflow || !info || info.blocked || info.compatible === false) return
    if (!(data instanceof Uint8Array)) return
    const msg = decodeHeader(data)
    if (!msg) return
    if (msg.type === MSG_HELLO) {
      this.onHello(room, info, msg)
      return
    }
    if (msg.type === MSG_PEERS) {
      if (room.kind === 'p2p') {
        const links = readPeers(msg.decoder)
        if (links) this.onPeersList(room, rp, links)
        else this.notePeerError(peerId)
      }
      return
    }
    // Access control: a peer may only touch docs inside this room's scope.
    if (!this.acceptsDoc(room, msg.docId)) return
    // Still loading from disk: we announce it (Step1 + WANT) once ready, which resyncs everything.
    const doc = this.readyDoc(room, msg.docId)
    if (!doc) return
    try {
      if (msg.type === MSG_SYNC) this.onSync(room, rp, msg, doc)
      else if (msg.type === MSG_AWARENESS) this.onAwareness(room, info, rp, msg, doc, false)
      else if (msg.type === MSG_AWARENESS_RELAY) this.onAwareness(room, info, rp, msg, doc, true)
      else if (msg.type === MSG_WANT) this.onWant(room, peerId, msg.docId, doc)
    } catch {
      this.notePeerError(peerId)
    }
  }

  private onHello(room: Room, info: PeerInfo, msg: DecodedMessage) {
    const hello = readHello(msg.decoder)
    if (!hello) return
    info.app = hello.app
    if (room.kind === 'local' && info.p2pId !== (hello.p ?? null)) {
      info.p2pId = hello.p ?? null
      this.scheduleStatus()
    }
    const ok = isCompatible(hello)
    if (info.compatible === ok) return
    info.compatible = ok
    // Who we exchange data with changed.
    for (const r of info.rooms) this.schedulePeersAnnounce(r)
    this.updateProblems()
    this.scheduleStatus()
  }

  private onSync(room: Room, rp: RoomPeer, msg: DecodedMessage, doc: Y.Doc) {
    const reply = syncReplyEncoder(msg.docId)
    const kind = syncProtocol.readSyncMessage(msg.decoder, reply, doc, rp.origin, () => this.notePeerError(rp.id))
    if (kind === syncProtocol.messageYjsSyncStep1) this.sendTo(room, [rp.id], encoding.toUint8Array(reply))
    if (room.kind === 'p2p') this.markSynced(msg.docId)
  }

  /**
   * Presence from a peer: its own clients (`relayed` false) or clients of peers it relays for.
   * Entries for our own client are dropped (nobody may speak for us), and a peer may not push a
   * client that another connected peer speaks for directly far ahead of that peer's clock (which
   * would freeze the real presence). New entries are relayed to peers of the room that are not
   * connected to the sender.
   */
  private onAwareness(room: Room, info: PeerInfo, rp: RoomPeer, msg: DecodedMessage, doc: Y.Doc, relayed: boolean) {
    const update = decoding.readVarUint8Array(msg.decoder)
    const slot = this.awareness.get(msg.docId)
    const own = slot && !slot.closing ? slot.aw.clientID : doc.clientID
    const track = this.trackFor(msg.docId)
    const now = this.o.now()
    const fresh = new Set<number>()
    const accepted = filterAwarenessUpdate(update, (e) => {
      if (e.clientID === own || e.clientID === doc.clientID) return false
      if (!this.acceptAwarenessEntry(track, e, rp.id, relayed, now)) return false
      const t = track.get(e.clientID)!
      if (e.clock > t.seen) {
        t.seen = e.clock
        fresh.add(e.clientID)
      }
      return true
    })
    if (!accepted) return
    const entries = readAwarenessEntries(accepted)
    if (!entries) return
    let clients = info.clients.get(msg.docId)
    if (!clients) info.clients.set(msg.docId, (clients = new Set()))
    for (const e of entries) {
      if (e.removed) clients.delete(e.clientID)
      else if (clients.size < MAX_AWARENESS_CLIENTS_PER_PEER) clients.add(e.clientID)
    }
    // Presence states must be plain objects; anything else is treated as "gone".
    const clean = modifyAwarenessUpdate(accepted, (s: unknown) => (s && typeof s === 'object' && !Array.isArray(s) ? s : null))
    // Presence only matters for boards open here (but is relayed either way).
    if (slot && !slot.closing) applyAwarenessUpdate(slot.aw, clean, rp.origin)
    if (room.kind !== 'p2p' || !fresh.size) return
    const targets = this.usablePeers(room).filter((p) => p !== rp.id && this.notConnected(room, rp.id, p))
    if (!targets.length) return
    const relay = filterAwarenessUpdate(clean, (e) => fresh.has(e.clientID))
    if (relay) this.sendTo(room, targets, encodeAwarenessRelay(msg.docId, relay))
  }

  private trackFor(docId: string): Map<number, AwarenessTrack> {
    let track = this.awTrack.get(docId)
    if (!track) this.awTrack.set(docId, (track = new Map()))
    return track
  }

  private acceptAwarenessEntry(track: Map<number, AwarenessTrack>, e: AwarenessEntry, from: string, relayed: boolean, now: number): boolean {
    const t = track.get(e.clientID)
    // Someone else, still connected, speaks for this client as its own.
    const directOwner = !!t && t.direct && t.owner !== from && this.peers.has(t.owner)
    if (directOwner) {
      // Only copies that cross on another path (at most a little ahead) are fine; a relay of it is
      // never needed (we hear the client itself).
      return !relayed && e.clock <= t!.ownerClock + MAX_FOREIGN_CLOCK_LEAD
    }
    if (!t) {
      if (track.size >= MAX_TRACKED_CLIENTS) this.pruneTrack(track, now)
      if (track.size >= MAX_TRACKED_CLIENTS) return false
      track.set(e.clientID, { owner: from, direct: !relayed, ownerClock: e.clock, seen: -1, at: now })
      return true
    }
    // A relayed copy never takes over from a direct speaker; a direct one replaces a relay.
    if (relayed && t.direct && t.owner === from) return true
    if (t.owner !== from || (!relayed && !t.direct)) {
      t.owner = from
      t.direct = !relayed
      t.ownerClock = e.clock
    } else t.ownerClock = Math.max(t.ownerClock, e.clock)
    t.at = now
    return true
  }

  private pruneTrack(track: Map<number, AwarenessTrack>, now: number) {
    // Presence expires after 30 s without renewal; anything not heard from for minutes is gone.
    for (const [id, t] of track) if (now - t.at > 5 * 60_000 || !this.peers.has(t.owner)) track.delete(id)
  }

  private onWant(room: Room, peerId: string, docId: string, doc: Y.Doc) {
    this.sendTo(room, [peerId], encodeSyncStep1(docId, doc))
    const slot = this.awareness.get(docId)
    const own = slot && !slot.closing ? this.ownAwareness(slot) : null
    if (own) this.sendTo(room, [peerId], own)
  }

  private acceptsDoc(room: Room, docId: string): boolean {
    if (room.kind === 'local') return docId === this.o.homeId || isValidId(docId)
    return docId !== this.o.homeId && isValidId(docId) && room.scope.has(docId)
  }

  private readyDoc(room: Room, docId: string): Y.Doc | null {
    if (room.kind === 'local') {
      const doc = this.localDocs.get(docId)
      return doc && !doc.isDestroyed ? doc : null
    }
    const s = this.seeds.get(docId)
    return s?.ready && !s.doc.isDestroyed ? s.doc : null
  }

  private *readyDocs(room: Room): Generator<[string, Y.Doc]> {
    if (room.kind === 'local') {
      for (const [id, doc] of this.localDocs) if (!doc.isDestroyed) yield [id, doc]
      return
    }
    for (const id of room.scope) {
      const s = this.seeds.get(id)
      if (s?.ready && !s.doc.isDestroyed) yield [id, s.doc]
    }
  }

  private sendTo(room: Room, targets: readonly string[], msg: Uint8Array) {
    if (!room.transport || !targets.length) return
    try {
      room.transport.send(msg, targets)
    } catch (err) {
      console.warn('[sync] send failed', err)
    }
  }

  /** P2P rooms that may carry this doc; the board's own room first (most direct). */
  private coveringRooms(docId: string): Room[] {
    const out: Room[] = []
    if (docId === this.o.homeId) return out
    for (const room of this.rooms.values()) {
      if (room.closed || !room.transport || !room.scope.has(docId)) continue
      if (room.rootId === docId) out.unshift(room)
      else out.push(room)
    }
    return out
  }

  /**
   * Sends a doc-level message to every P2P peer that shares the doc with us, once per peer.
   * When relaying a change from a peer, the peers of its room that are connected to it already
   * have it; the others (partial mesh) get it from us. Yjs updates are idempotent and a duplicate
   * produces no new update event, so relaying stops by itself.
   */
  private fanoutP2P(docId: string, msg: Uint8Array, source: RemoteOrigin | null) {
    const sent = new Set<string>()
    const room0 = source && source.room.kind === 'p2p' ? (source.room as Room) : null
    if (source) sent.add(source.peerId)
    if (room0) for (const p of room0.peers.keys()) if (!this.notConnected(room0, source!.peerId, p)) sent.add(p)
    for (const room of this.coveringRooms(docId)) {
      const targets = this.usablePeers(room).filter((p) => !sent.has(p))
      for (const p of targets) sent.add(p)
      this.sendTo(room, targets, msg)
    }
  }

  /**
   * A change made in another tab of ours: that tab sends it to its own peers. Peers it is not
   * connected to (they told us whom they are connected to) get it from us.
   */
  private relayForTab(docId: string, msg: Uint8Array, tabPeerId: string) {
    const tabP2pId = this.peers.get(tabPeerId)?.p2pId ?? null
    const ownTabs = this.ownTabIds()
    const sent = new Set<string>()
    for (const room of this.coveringRooms(docId)) {
      const targets = this.usablePeers(room).filter((p) => {
        if (sent.has(p) || ownTabs.has(p)) return false
        const links = room.peers.get(p)?.links
        // A tab without a P2P identity reaches nobody; an older peer (no list) is assumed reached.
        return tabP2pId ? !!links && !links.has(tabP2pId) : true
      })
      for (const p of targets) sent.add(p)
      this.sendTo(room, targets, msg)
    }
  }

  private sendLocal(msg: Uint8Array) {
    const room = this.localRoom
    if (room?.transport) this.sendTo(room, this.usablePeers(room), msg)
  }

  /** Step1 + WANT: "here is what I have, and please send me what you have". */
  private announceDoc(room: Room, docId: string, doc: Y.Doc) {
    const peers = this.usablePeers(room)
    if (!peers.length) return
    this.sendTo(room, peers, encodeSyncStep1(docId, doc))
    this.sendTo(room, peers, encodeWant(docId))
  }

  private markSynced(docId: string) {
    // Second resolution keeps the status store from churning on every keystroke.
    const t = Math.floor(this.o.now() / 1000) * 1000
    if (this.lastSync.get(docId) === t) return
    this.lastSync.set(docId, t)
    this.scheduleStatus()
  }

  // -------------------------------------------------------------------------
  // Docs: local edits out, loaded docs for the local room

  private watchDoc(doc: Y.Doc) {
    if (this.watched.has(doc)) return
    const onUpdate = (update: Uint8Array, origin: unknown) => this.onDocUpdate(update, origin, doc)
    doc.on('update', onUpdate)
    this.watched.set(doc, () => doc.off('update', onUpdate))
  }

  private onDocUpdate(update: Uint8Array, origin: unknown, doc: Y.Doc) {
    if (this.stopped || doc.isDestroyed || isPersistenceOrigin(origin)) return
    const docId = doc.guid
    const remote = origin instanceof RemoteOrigin ? origin : null
    const msg = encodeUpdate(docId, update)
    // Other tabs publish their own edits to their own peers (and other tabs got it from them).
    if (remote?.room.kind === 'local') {
      this.relayForTab(docId, msg, remote.peerId)
      return
    }
    this.fanoutP2P(docId, msg, remote)
    if (this.localDocs.get(docId) === doc) this.sendLocal(msg)
  }

  private onDocLoaded(id: string, doc: Y.Doc) {
    if (this.stopped || doc.isDestroyed || doc.guid !== id) return
    this.localDocs.set(id, doc)
    this.watchDoc(doc)
    if (this.localRoom) this.announceDoc(this.localRoom, id, doc)
  }

  private onDocUnloaded(id: string, doc: Y.Doc) {
    if (this.localDocs.get(id) === doc) this.localDocs.delete(id)
    this.watched.get(doc)?.()
    this.watched.delete(doc)
    const s = this.seeds.get(id)
    if (s && s.doc === doc) {
      // Destroyed under us (board left / deleted): reopen if it is still in scope.
      this.seeds.delete(id)
      s.unobserve?.()
      this.scheduleScope()
    }
  }

  // -------------------------------------------------------------------------
  // Scope & seeding

  private scheduleScope() {
    if (this.stopped || this.scopeTimer) return
    this.scopeTimer = setTimeout(() => {
      this.scopeTimer = null
      this.recomputeScope()
    }, this.o.scopeDebounceMs)
  }

  private recomputeScope() {
    if (this.stopped) return
    const { library, homeId } = this.o
    for (const s of this.seeds.values()) {
      if (s.ready && s.linksDirty && !s.doc.isDestroyed) {
        s.links = readBoardLinks(s.doc, homeId)
        s.linksDirty = false
      }
    }
    const secretOf = (child: string) => library.secretOf(child)
    const ownerOf = (secret: string) => library.secretOwner?.(secret)
    const children = (id: string): string[] | undefined => {
      const s = this.seeds.get(id)
      if (!s?.ready) return undefined
      return acceptedChildren(s.links, secretOf, ownerOf, homeId, this.o.maxLinksPerBoard)
    }
    const union = new Set<string>()
    for (const room of this.rooms.values()) {
      if (room.closed || !room.rootId) continue
      const prev = room.scope
      room.scope = computeScope(room.rootId, children, this.o.maxScope)
      for (const id of room.scope) {
        union.add(id)
        if (prev.has(id) || !room.transport) continue
        const s = this.seeds.get(id)
        if (s?.ready && !s.doc.isDestroyed) this.announceDoc(room, id, s.doc)
      }
    }
    for (const id of union) if (!this.seeds.has(id)) this.seed(id)
    for (const id of this.seeds.keys()) if (!union.has(id)) this.unseed(id)
    this.scheduleStatus()
  }

  private seed(id: string) {
    let handle: DocHandleLike
    try {
      handle = this.o.docs.open(id)
    } catch (err) {
      console.warn('[sync] could not open board', id, err)
      return
    }
    const s: Seed = { id, handle, doc: handle.doc, ready: false, links: new Map(), linksDirty: false, blobs: null, unobserve: null }
    this.seeds.set(id, s)
    const onReady = () => this.onSeedReady(s)
    handle.ready.then(onReady, onReady)
  }

  private unseed(id: string) {
    const s = this.seeds.get(id)
    if (!s) return
    this.seeds.delete(id)
    s.unobserve?.()
    s.handle.release()
    this.awTrack.delete(id)
  }

  private onSeedReady(s: Seed) {
    if (this.stopped || this.seeds.get(s.id) !== s || s.doc.isDestroyed) return
    s.ready = true
    this.watchDoc(s.doc)
    s.links = readBoardLinks(s.doc, this.o.homeId)
    s.unobserve = observeBoardDoc(
      s.doc,
      () => {
        s.linksDirty = true
        this.scheduleScope()
      },
      () => {
        if (readShared(s.doc)) this.markShared(s.id)
      },
      () => {
        s.blobs = null
      },
    )
    if (readShared(s.doc)) this.markShared(s.id)
    for (const room of this.rooms.values()) {
      if (room.transport && room.scope.has(s.id)) this.announceDoc(room, s.id, s.doc)
    }
    this.scheduleScope()
    this.scheduleStatus()
  }

  /** Someone invited people directly to this nested board: serve its own room too. */
  private markShared(id: string) {
    if (id === this.o.homeId) return
    let secret = this.o.library.secretOf(id) ?? null
    if (!secret) {
      // Never a secret that belongs to another board: a card reusing it (with meta.shared set by
      // whoever wrote the card) would otherwise open a second room with that board's secret.
      const usable = (s: string) => {
        const owner = this.o.library.secretOwner?.(s)
        return owner === undefined || owner === id
      }
      for (const s of this.seeds.values()) {
        const found = s.links.get(id)?.find(usable)
        if (found) {
          secret = found
          break
        }
      }
    }
    this.o.library.markShared(id, secret)
  }

  // -------------------------------------------------------------------------
  // Awareness (presence)

  private onAwarenessCreated(boardId: string, aw: Awareness) {
    if (this.stopped) return
    const prev = this.awareness.get(boardId)
    if (prev) {
      if (prev.aw === aw) return
      this.forgetAwareness(prev)
    }
    const slot: AwarenessSlot = { boardId, aw, lastSent: 0, timer: null, closing: false, off: () => {} }
    const onUpdate = (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin instanceof RemoteOrigin) return
      // Only our own state: other clients publish theirs (timeouts of remote states stay local).
      const me = aw.clientID
      if (!change.added.includes(me) && !change.updated.includes(me) && !change.removed.includes(me)) return
      if (slot.closing) this.flushAwareness(slot)
      else this.throttleAwareness(slot)
    }
    aw.on('update', onUpdate)
    slot.off = () => aw.off('update', onUpdate)
    this.awareness.set(boardId, slot)
    // Show up for everyone already here, and ask them for their presence (WANT is answered with it).
    const own = this.ownAwareness(slot)
    const want = encodeWant(boardId)
    if (own) this.fanoutP2P(boardId, own, null)
    this.fanoutP2P(boardId, want, null)
    if (own) this.sendLocal(own)
    if (this.localDocs.has(boardId)) this.sendLocal(want)
  }

  private onAwarenessDestroyed(boardId: string, aw: Awareness) {
    const slot = this.awareness.get(boardId)
    if (!slot || slot.aw !== aw) return
    // presence.ts clears the local state right after this callback; that update goes out at once.
    slot.closing = true
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    queueMicrotask(() => this.forgetAwareness(slot))
  }

  private forgetAwareness(slot: AwarenessSlot) {
    slot.off()
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    if (this.awareness.get(slot.boardId) === slot) this.awareness.delete(slot.boardId)
  }

  private ownAwareness(slot: AwarenessSlot): Uint8Array | null {
    try {
      return encodeAwareness(slot.boardId, encodeAwarenessUpdate(slot.aw, [slot.aw.clientID]))
    } catch {
      return null
    }
  }

  private throttleAwareness(slot: AwarenessSlot) {
    const wait = slot.lastSent + this.o.awarenessThrottleMs - this.o.now()
    if (wait <= 0) this.flushAwareness(slot)
    else if (!slot.timer) {
      slot.timer = setTimeout(() => {
        slot.timer = null
        this.flushAwareness(slot)
      }, wait)
    }
  }

  private flushAwareness(slot: AwarenessSlot) {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    slot.lastSent = this.o.now()
    const msg = this.ownAwareness(slot)
    if (!msg) return
    this.fanoutP2P(slot.boardId, msg, null)
    this.sendLocal(msg)
  }

  /** Removes the presence of a peer that left, unless another connected peer still vouches for it. */
  private dropAwareness(peerId: string, info: PeerInfo, origin: RemoteOrigin) {
    for (const [boardId, clients] of info.clients) {
      const slot = this.awareness.get(boardId)
      if (!slot || !clients.size) continue
      const remove = [...clients].filter((c) => {
        if (c === slot.aw.clientID) return false
        for (const [other, oi] of this.peers) if (other !== peerId && oi.clients.get(boardId)?.has(c)) return false
        return true
      })
      if (!remove.length) continue
      removeAwarenessStates(slot.aw, remove, origin)
      // Forget their clocks too: when the peer comes back it resends the same, unchanged state,
      // which would otherwise be ignored as old until its next 15 s renewal.
      for (const c of remove) slot.aw.meta.delete(c)
    }
  }

  // -------------------------------------------------------------------------
  // Blobs

  /** Files referenced by a seeded board (cached until its cards change). */
  private blobRefsOf(id: string): Set<string> | null {
    const s = this.seeds.get(id)
    if (!s?.ready || s.doc.isDestroyed) return null
    s.blobs ??= readBlobRefs(s.doc)
    return s.blobs
  }

  /** A file a peer of this room may fetch: one that a board in the room's scope refers to. */
  private roomRefersTo(room: Room, hash: string): boolean {
    // Our own other tabs see everything we have anyway.
    if (room.kind === 'local') return true
    for (const id of room.scope) if (this.blobRefsOf(id)?.has(hash)) return true
    return false
  }

  private async serveBlob(room: Room, peerId: string, hash: string): Promise<BlobReply | null> {
    const rp = room.peers.get(peerId)
    const info = this.peers.get(peerId)
    if (!rp || rp.overflow || !info || !this.usable(info) || !isValidBlobHash(hash)) return null
    // Access control: only files of boards this room may see (not every file on this device).
    if (!this.roomRefersTo(room, hash)) return null
    // Busy serving this peer: wait for a slot instead of answering "don't have it".
    if (!(await this.acquireBlobSlot(info))) return null
    try {
      if (room.closed || !room.peers.has(peerId)) return null
      const blob = await this.o.blobs.get(hash)
      if (!blob || blob.size > MAX_BLOB_BYTES) return null
      return { mime: blob.type, data: blob }
    } catch {
      return null
    } finally {
      this.releaseBlobSlot(info)
    }
  }

  private acquireBlobSlot(info: PeerInfo): Promise<boolean> {
    if (info.serving < MAX_CONCURRENT_BLOB_REPLIES) {
      info.serving++
      return Promise.resolve(true)
    }
    if (info.waiting.length >= MAX_QUEUED_BLOB_REQUESTS) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      info.waiting.push((ok) => {
        if (ok) info.serving++
        resolve(ok)
      })
    })
  }

  private releaseBlobSlot(info: PeerInfo) {
    info.serving--
    info.waiting.shift()?.(true)
  }

  /**
   * Asks peers of the rooms that cover the board in turn (for an unknown board: rooms whose boards
   * refer to the file); only bytes matching the hash are kept. Rooms that do not carry the board
   * are never asked, so the hashes of private files never reach unrelated people.
   */
  private async fetchBlob(hash: string, boardId: string | null): Promise<Blob | null> {
    if (this.stopped || !isValidBlobHash(hash)) return null
    const tried = new Set<string>()
    const next = (): [Room, string] | null => {
      const pool = boardId
        ? this.coveringRooms(boardId)
        : [...this.rooms.values()].filter((r) => r.transport && !r.closed && this.roomRefersTo(r, hash))
      for (const room of pool) for (const p of this.usablePeers(room)) if (!tried.has(p)) return [room, p]
      return null
    }
    for (let pick = next(); pick; pick = next()) {
      const [room, peerId] = pick
      tried.add(peerId)
      const t = room.transport
      if (!t) continue
      try {
        const res = await t.requestBlob(hash, peerId, { idleTimeoutMs: this.o.blobIdleTimeoutMs })
        if (!res || !(res.bytes instanceof Uint8Array) || res.bytes.byteLength > MAX_BLOB_BYTES) continue
        if ((await hashBytes(res.bytes)) !== hash) {
          this.notePeerError(peerId)
          continue
        }
        return new Blob([res.bytes as Uint8Array<ArrayBuffer>], { type: sanitizeMime(res.mime) })
      } catch {
        // try the next peer
      }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Status

  private scheduleStatus() {
    if (this.stopped || this.statusTimer) return
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null
      this.publishStatus()
    }, this.o.statusDelayMs)
  }

  private publishStatus() {
    if (this.stopped) return
    const boards: Record<string, BoardSyncStatus> = {}
    if (!this.p2pEnabled) {
      for (const e of this.o.library.sharedBoards()) {
        if (e.id !== this.o.homeId) boards[e.id] = { peers: 0, active: false, lastSyncAt: this.lastSync.get(e.id) ?? 0 }
      }
    } else {
      // Our other tabs reach us over WebRTC as well; they are not teammates.
      const ownTabs = this.ownTabIds()
      const peerSets = new Map<string, Set<string>>()
      for (const room of this.rooms.values()) {
        if (room.closed) continue
        const peers = this.usablePeers(room).filter((p) => !ownTabs.has(p))
        const scope = room.scope.size ? room.scope : new Set([room.rootId!])
        for (const id of scope) {
          let set = peerSets.get(id)
          if (!set) peerSets.set(id, (set = new Set()))
          for (const p of peers) set.add(p)
          boards[id] = {
            peers: 0,
            active: (boards[id]?.active ?? false) || room.transport !== null,
            lastSyncAt: this.lastSync.get(id) ?? 0,
          }
        }
      }
      for (const [id, set] of peerSets) boards[id].peers = set.size
    }
    this.o.status.setBoards(boards)
  }

  private updateProblems() {
    if (this.stopped) return
    let version = false
    let tabVersion = false
    for (const info of this.peers.values()) {
      if (info.compatible !== false) continue
      for (const r of info.rooms) {
        if (r.kind === 'local') tabVersion = true
        else version = true
      }
    }
    let full = false
    let startFailed = false
    for (const room of this.rooms.values()) {
      for (const p of room.peers.values()) if (p.overflow) full = true
      if (!room.closed && !room.transport && room.failures > 0) startFailed = true
    }
    const now = this.o.now()
    let unreachable = false
    for (const [peerId, at] of this.connectFailures) {
      if (now - at > TURN_PROBLEM_TTL_MS || this.peers.has(peerId)) this.connectFailures.delete(peerId)
      else if (now - at >= this.o.turnGraceMs) unreachable = true
    }
    const on = this.p2pEnabled
    const s = this.o.status
    s.setProblem('version', on && version)
    s.setProblem('tab-version', tabVersion)
    s.setProblem('full', on && full)
    s.setProblem('turn', on && unreachable)
    s.setProblem('webrtc', on && this.webrtcUnavailable && this.rooms.size > 0)
    s.setProblem('start', on && startFailed)
  }

  private scheduleAntiEntropy() {
    if (!this.o.antiEntropyMs || this.stopped) return
    // Jitter keeps a room of peers from all resyncing at the same instant.
    const ms = this.o.antiEntropyMs * (0.8 + Math.random() * 0.4)
    this.antiEntropyTimer = setTimeout(() => {
      this.antiEntropy()
      this.scheduleAntiEntropy()
    }, ms)
  }
}
