/**
 * Test doubles for the engine's injected dependencies (each simulated device gets its own set).
 * Only imported by *.test.ts files.
 */
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { create } from 'zustand'
import { getCards } from '../../model/board'
import { hashBytes } from '../crypto'
import { SyncEngine, type BlobSource, type DocProvider, type LibrarySource, type PresenceSource, type SyncEngineOptions } from './engine'
import { MemoryHub, MemoryTransport } from './memory'
import { createStoreSink, type SyncStatusState, type useSyncStatus } from './status'

type DocListener = (id: string, doc: Y.Doc) => void

export class TestDocs implements DocProvider {
  readonly entries = new Map<string, { doc: Y.Doc; refs: number }>()
  private readonly loadL = new Set<DocListener>()
  private readonly unloadL = new Set<DocListener>()

  open(id: string) {
    let e = this.entries.get(id)
    if (!e) {
      const doc = new Y.Doc({ guid: id })
      const entry = { doc, refs: 0 }
      e = entry
      this.entries.set(id, entry)
      queueMicrotask(() => {
        if (this.entries.get(id) === entry) this.loadL.forEach((l) => l(id, doc))
      })
    }
    e.refs++
    const entry = e
    let released = false
    return {
      doc: e.doc,
      ready: Promise.resolve(),
      release: () => {
        if (released) return
        released = true
        entry.refs--
      },
    }
  }

  /** A doc held open by "the UI". */
  doc(id: string): Y.Doc {
    return this.open(id).doc
  }

  peek(id: string) {
    return this.entries.get(id)?.doc
  }

  loadedIds() {
    return [...this.entries.keys()]
  }

  onLoad(l: DocListener) {
    this.loadL.add(l)
    return () => {
      this.loadL.delete(l)
    }
  }

  onUnload(l: DocListener) {
    this.unloadL.add(l)
    return () => {
      this.unloadL.delete(l)
    }
  }

  unload(id: string) {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    this.unloadL.forEach((l) => l(id, e.doc))
    e.doc.destroy()
  }
}

export class TestLibrary implements LibrarySource {
  /** `trusted: false` = secret only learned from a board card (like library.ts 'card'). */
  readonly entries = new Map<string, { secret: string; shared: boolean; trusted: boolean }>()
  private readonly listeners = new Set<() => void>()

  set(id: string, secret: string, shared: boolean, trusted = true) {
    this.entries.set(id, { secret, shared, trusted })
    this.listeners.forEach((l) => l())
  }

  remove(id: string) {
    this.entries.delete(id)
    this.listeners.forEach((l) => l())
  }

  sharedBoards() {
    return [...this.entries].filter(([, e]) => e.shared && e.secret).map(([id, e]) => ({ id, secret: e.secret, trusted: e.trusted }))
  }

  secretOf(id: string) {
    return this.entries.get(id)?.secret || undefined
  }

  secretOwner(secret: string) {
    let best: [string, boolean] | undefined
    for (const [id, e] of this.entries) {
      if (e.secret !== secret) continue
      if (!best || (e.trusted && !best[1]) || (e.trusted === best[1] && id < best[0])) best = [id, e.trusted]
    }
    return best?.[0]
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Mirrors sync/index.ts: a card's secret that belongs to another board never opens a room. */
  markShared(id: string, secret: string | null) {
    const prev = this.entries.get(id)
    if (prev?.shared) return
    if (prev?.secret) return this.set(id, prev.secret, true, prev.trusted)
    if (!secret) return
    const owner = this.secretOwner(secret)
    if (owner !== undefined && owner !== id) return
    this.set(id, secret, true, false)
  }
}

export class TestPresence implements PresenceSource {
  private readonly created = new Set<(id: string, a: Awareness) => void>()
  private readonly destroyed = new Set<(id: string, a: Awareness) => void>()
  readonly open = new Map<string, Awareness>()

  onAwarenessCreated(l: (id: string, a: Awareness) => void) {
    this.created.add(l)
    for (const [id, a] of this.open) l(id, a)
    return () => {
      this.created.delete(l)
    }
  }

  onAwarenessDestroyed(l: (id: string, a: Awareness) => void) {
    this.destroyed.add(l)
    return () => {
      this.destroyed.delete(l)
    }
  }

  /** Opens a board's presence like BoardView does. */
  acquire(boardId: string, doc: Y.Doc): Awareness {
    const a = new Awareness(doc)
    this.open.set(boardId, a)
    this.created.forEach((l) => l(boardId, a))
    return a
  }

  /** Mirrors presence.ts: listeners first, then the local state is cleared and the instance destroyed. */
  release(boardId: string) {
    const a = this.open.get(boardId)
    if (!a) return
    this.open.delete(boardId)
    this.destroyed.forEach((l) => l(boardId, a))
    a.setLocalState(null)
    a.destroy()
  }

  releaseAll() {
    for (const id of this.open.keys()) this.release(id)
  }
}

export class TestBlobs implements BlobSource {
  readonly store = new Map<string, Blob>()
  private readonly fetchers = new Set<(hash: string, boardId: string | null) => Promise<Blob | null>>()

  async put(bytes: Uint8Array, mime: string): Promise<string> {
    const hash = await hashBytes(bytes)
    this.store.set(hash, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
    return hash
  }

  async get(hash: string) {
    return this.store.get(hash) ?? null
  }

  registerFetcher(f: (hash: string, boardId: string | null) => Promise<Blob | null>) {
    this.fetchers.add(f)
    return () => {
      this.fetchers.delete(f)
    }
  }

  /** Like collab/blobs.ts getBlob: local first, then fetchers, keeping only verified bytes. */
  async fetch(hash: string, boardId: string | null): Promise<Blob | null> {
    const local = this.store.get(hash)
    if (local) return local
    for (const f of this.fetchers) {
      const b = await f(hash, boardId)
      if (b && (await hashBytes(new Uint8Array(await b.arrayBuffer()))) === hash) {
        this.store.set(hash, b)
        return b
      }
    }
    return null
  }
}

export interface TestDevice {
  name: string
  engine: SyncEngine
  docs: TestDocs
  library: TestLibrary
  presence: TestPresence
  blobs: TestBlobs
  status: ReturnType<typeof createStoreSink>
  store: typeof useSyncStatus
  /** Transports the engine created, by room id. */
  transports: Map<string, MemoryTransport>
}

export function makeDevice(hub: MemoryHub, name: string, opts: Partial<SyncEngineOptions> = {}): TestDevice {
  const docs = new TestDocs()
  const library = new TestLibrary()
  const presence = new TestPresence()
  const blobs = new TestBlobs()
  const store = create<SyncStatusState>(() => ({ online: true, boards: {}, problem: null }))
  const status = createStoreSink(store)
  const transports = new Map<string, MemoryTransport>()
  const engine = new SyncEngine({
    docs,
    library,
    presence,
    blobs,
    status,
    createTransport: ({ roomId }) => {
      const t = hub.transport(roomId, name)
      transports.set(roomId, t)
      return t
    },
    antiEntropyMs: 0,
    scopeDebounceMs: 5,
    peersDebounceMs: 5,
    retryBaseMs: 20,
    retryMaxMs: 200,
    awarenessThrottleMs: 5,
    statusDelayMs: 0,
    turnGraceMs: 20,
    ...opts,
  })
  return { name, engine, docs, library, presence, blobs, status, store, transports }
}

export async function waitFor(cond: () => boolean, what = 'condition', timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function cardIds(doc: Y.Doc | undefined): string[] {
  return doc ? [...getCards(doc).keys()].sort() : []
}

/** Same content on both sides (state vectors and card sets agree). */
export function converged(a: Y.Doc | undefined, b: Y.Doc | undefined): boolean {
  if (!a || !b) return false
  const sa = Y.decodeStateVector(Y.encodeStateVector(a))
  const sb = Y.decodeStateVector(Y.encodeStateVector(b))
  if (sa.size !== sb.size) return false
  for (const [client, clock] of sa) if (sb.get(client) !== clock) return false
  return cardIds(a).join() === cardIds(b).join()
}
