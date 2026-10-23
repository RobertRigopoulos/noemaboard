/**
 * Local search index: the searchable text of every board on this device, kept in IndexedDB so
 * search covers boards that are not loaded. One record per board, rebuilt from the board doc:
 *  - when a doc loads (if its content changed since the record was written),
 *  - 2 s after edits to a loaded doc (local or from teammates),
 *  - by a background indexer that loads boards without a record, a few at a time, while the
 *    search dialog is open or the app is idle.
 * Records hold card text, which came from peers: everything read back is validated and capped.
 */
import * as Y from 'yjs'
import { openDB, type IDBPDatabase } from 'idb'
import { create } from 'zustand'
import { HOME_BOARD_ID } from '../../config'
import { canOpenBoard } from '../../app/boardAccess'
import { docs } from '../../collab/docs'
import { STORAGE_PREFIX } from '../../collab/profile'
import { useLibrary, type LibraryEntry } from '../../collab/library'
import { isValidId } from '../../model/ids'
import { collectDocItems, docTitle, makeItem, type SearchItem, type SearchItemType } from './collect'

export const INDEX_VERSION = 1
export const INDEX_LIMITS = { title: 200, body: 2000, items: 2000 }
const DEBOUNCE_MS = 2000
const BATCH = 3

export interface StoredItem {
  cardId: string | null
  type: SearchItemType
  title: string
  body: string
}

export interface IndexRecord {
  v: number
  boardId: string
  title: string
  items: StoredItem[]
  /** FNV-1a (hex) of the doc's state vector when indexed: tells whether the doc changed since. */
  sv: string
  indexedAt: number
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

/** 32-bit FNV-1a of bytes, as 8 hex digits. */
export function fnv1aHex(bytes: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function stateVectorHash(doc: Y.Doc): string {
  return fnv1aHex(Y.encodeStateVector(doc))
}

const ITEM_TYPES: ReadonlySet<string> = new Set([
  'board-title',
  'note',
  'todo',
  'link',
  'image',
  'file',
  'board',
  'column',
  'line',
  'comment',
  'swatch',
  'sketch',
  'document',
])
const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max * 2).replace(CONTROL, '').slice(0, max) : ''
}

const isBoardKey = (id: unknown): id is string => id === HOME_BOARD_ID || isValidId(id)

/** The record for a loaded board doc, capped like every stored record. */
export function buildRecord(boardId: string, doc: Y.Doc, fallbackTitle: string, now = Date.now()): IndexRecord {
  const items: StoredItem[] = []
  for (const it of collectDocItems(boardId, doc)) {
    if (items.length >= INDEX_LIMITS.items) break
    items.push({ cardId: it.cardId, type: it.type, title: cleanText(it.title, INDEX_LIMITS.title), body: cleanText(it.body, INDEX_LIMITS.body) })
  }
  const title = boardId === HOME_BOARD_ID ? 'Home' : docTitle(doc, fallbackTitle)
  return { v: INDEX_VERSION, boardId, title: cleanText(title, INDEX_LIMITS.title), items, sv: stateVectorHash(doc), indexedAt: now }
}

/** Validates a record read back from storage (older formats, damaged data): null when unusable. */
export function sanitizeRecord(raw: unknown): IndexRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== INDEX_VERSION || !isBoardKey(r.boardId)) return null
  if (typeof r.sv !== 'string' || !/^[0-9a-f]{8}$/.test(r.sv)) return null
  const indexedAt = typeof r.indexedAt === 'number' && Number.isFinite(r.indexedAt) && r.indexedAt >= 0 ? r.indexedAt : 0
  const items: StoredItem[] = []
  if (Array.isArray(r.items)) {
    for (const it of r.items) {
      if (items.length >= INDEX_LIMITS.items) break
      if (!it || typeof it !== 'object') continue
      const o = it as Record<string, unknown>
      if (typeof o.type !== 'string' || !ITEM_TYPES.has(o.type) || o.type === 'board-title') continue
      if (typeof o.cardId !== 'string' || !CARD_ID.test(o.cardId)) continue
      const title = cleanText(o.title, INDEX_LIMITS.title)
      const body = cleanText(o.body, INDEX_LIMITS.body)
      if (!title && !body) continue
      items.push({ cardId: o.cardId, type: o.type as SearchItemType, title, body })
    }
  }
  return { v: INDEX_VERSION, boardId: r.boardId, title: cleanText(r.title, INDEX_LIMITS.title), items, sv: r.sv, indexedAt }
}

/** A record still describes the doc when it has the current format and the same state vector. */
export function isFreshRecord(record: IndexRecord | undefined, sv: string): boolean {
  return !!record && record.v === INDEX_VERSION && record.sv === sv
}

/** Boards this device can open (Home first) that have no record yet: what the background indexer loads. */
export function boardsToIndex(entries: Record<string, LibraryEntry>, records: ReadonlyMap<string, IndexRecord>, skip: ReadonlySet<string> = new Set()): string[] {
  const ids = [HOME_BOARD_ID, ...Object.keys(entries).filter((id) => id !== HOME_BOARD_ID)]
  return ids.filter((id) => !skip.has(id) && !records.has(id) && canOpenBoard(id, entries))
}

/** Records of boards that left the library (left, deleted, or never ours). */
export function recordsToDrop(entries: Record<string, LibraryEntry>, records: ReadonlyMap<string, IndexRecord>): string[] {
  return [...records.keys()].filter((id) => id !== HOME_BOARD_ID && !canOpenBoard(id, entries))
}

const foldedCache = new WeakMap<IndexRecord, SearchItem[]>()

/** Search items of a stored record (folded once per record). */
export function recordItems(record: IndexRecord): SearchItem[] {
  let items = foldedCache.get(record)
  if (!items) {
    items = record.items.map((it) => makeItem(record.boardId, it.cardId, it.type, it.title, it.body))
    foldedCache.set(record, items)
  }
  return items
}

// ---------------------------------------------------------------------------
// Storage and live updates

interface IndexState {
  /** Bumps whenever a record changes. */
  version: number
  /** The background indexer is loading boards. */
  indexing: boolean
  /** Openable boards with a record, and all openable boards (for "Indexed 37 of 120 boards"). */
  done: number
  total: number
}

export const useSearchIndex = create<IndexState>(() => ({ version: 0, indexing: false, done: 0, total: 0 }))

const records = new Map<string, IndexRecord>()
let dbPromise: Promise<IDBPDatabase> | null = null
let loadPromise: Promise<void> | null = null

function db(): Promise<IDBPDatabase> | null {
  if (typeof indexedDB === 'undefined') return null
  dbPromise ??= openDB(`${STORAGE_PREFIX}search`, 1, {
    upgrade(d) {
      d.createObjectStore('boards', { keyPath: 'boardId' })
    },
  })
  return dbPromise
}

const bump = () => useSearchIndex.setState((s) => ({ version: s.version + 1 }))

function loadRecords(): Promise<void> {
  loadPromise ??= (async () => {
    const d = db()
    if (!d) return
    try {
      const all = await (await d).getAll('boards')
      for (const raw of all) {
        const rec = sanitizeRecord(raw)
        // A live doc may already have written a newer record.
        if (rec && !records.has(rec.boardId)) records.set(rec.boardId, rec)
      }
      bump()
    } catch (err) {
      console.warn('Search index could not be read', err)
    }
  })()
  return loadPromise
}

async function putRecord(rec: IndexRecord) {
  records.set(rec.boardId, rec)
  bump()
  try {
    await (await db())?.put('boards', rec)
  } catch (err) {
    console.warn('Search index could not be saved', err)
  }
}

async function dropRecords(ids: readonly string[]) {
  if (!ids.length) return
  for (const id of ids) records.delete(id)
  bump()
  try {
    const d = await db()
    if (!d) return
    const tx = d.transaction('boards', 'readwrite')
    await Promise.all([...ids.map((id) => tx.store.delete(id)), tx.done])
  } catch (err) {
    console.warn('Search index could not be cleaned up', err)
  }
}

function libraryTitle(id: string): string {
  return useLibrary.getState().entries[id]?.title ?? 'Board'
}

/** Rebuilds a board's record from its (loaded) doc unless the stored one is still fresh. */
function indexDoc(id: string, doc: Y.Doc, force = false) {
  if (doc.isDestroyed || !canOpenBoard(id, useLibrary.getState().entries)) return
  const sv = stateVectorHash(doc)
  if (!force && isFreshRecord(records.get(id), sv)) return
  void putRecord(buildRecord(id, doc, libraryTitle(id)))
}

/** Stored items of a board that is not loaded (null when it was never indexed). */
export function cachedItems(boardId: string): SearchItem[] | null {
  const r = records.get(boardId)
  return r ? recordItems(r) : null
}

export function cachedTitle(boardId: string): string | null {
  return records.get(boardId)?.title || null
}

const watched = new Map<Y.Doc, { timer: ReturnType<typeof setTimeout> | null; off: () => void; id: string }>()

function watchDoc(id: string, doc: Y.Doc) {
  if (watched.has(doc) || doc.isDestroyed) return
  const entry = { timer: null as ReturnType<typeof setTimeout> | null, off: () => {}, id }
  const onUpdate = () => {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      indexDoc(id, doc, true)
    }, DEBOUNCE_MS)
  }
  doc.on('update', onUpdate)
  entry.off = () => doc.off('update', onUpdate)
  watched.set(doc, entry)
  // Loaded with changes made elsewhere since the record was written.
  void loadRecords().then(() => indexDoc(id, doc))
}

function unwatchDoc(doc: Y.Doc) {
  const entry = watched.get(doc)
  if (!entry) return
  watched.delete(doc)
  entry.off()
  if (entry.timer) {
    clearTimeout(entry.timer)
    // Still readable here: the registry destroys the doc after its unload listeners ran.
    indexDoc(entry.id, doc, true)
  }
}

// ---------------------------------------------------------------------------
// Background indexer

let started = false
let running = false
let fast = false
const failed = new Set<string>()

function openableCount(entries: Record<string, LibraryEntry>): { done: number; total: number } {
  let done = 0
  let total = 0
  for (const id of [HOME_BOARD_ID, ...Object.keys(entries).filter((x) => x !== HOME_BOARD_ID)]) {
    if (!canOpenBoard(id, entries)) continue
    total++
    if (records.has(id)) done++
  }
  return { done, total }
}

function idle(): Promise<void> {
  return new Promise((resolve) => {
    if (fast) setTimeout(resolve, 0)
    else if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 8000 })
    else setTimeout(resolve, 1500)
  })
}

async function indexBoard(id: string) {
  const h = docs.open(id)
  try {
    await h.ready
    if (!docs.isLoaded(id)) {
      // The database did not load: try again another time rather than store an empty record.
      failed.add(id)
      return
    }
    indexDoc(id, h.doc, true)
  } catch (err) {
    failed.add(id)
    console.warn('Could not index a board for search', err)
  } finally {
    h.release()
  }
}

async function runIndexer() {
  if (running) return
  running = true
  try {
    await loadRecords()
    await dropRecords(recordsToDrop(useLibrary.getState().entries, records))
    for (;;) {
      const entries = useLibrary.getState().entries
      const todo = boardsToIndex(entries, records, failed)
      useSearchIndex.setState({ indexing: todo.length > 0, ...openableCount(entries) })
      if (!todo.length) break
      await Promise.all(todo.slice(0, BATCH).map(indexBoard))
      await idle()
    }
  } finally {
    running = false
    useSearchIndex.setState({ indexing: false, ...openableCount(useLibrary.getState().entries) })
  }
}

/**
 * Starts live indexing (idempotent). The background indexer first runs once the app has been idle
 * for a while, then again whenever the library changes.
 */
export function startSearchIndex() {
  if (started || typeof window === 'undefined') return
  started = true
  for (const id of docs.loadedIds()) {
    const doc = docs.peek(id)
    if (doc && docs.isLoaded(id)) watchDoc(id, doc)
  }
  docs.onLoad((id, doc) => watchDoc(id, doc))
  docs.onUnload((_id, doc) => unwatchDoc(doc))
  let libTimer: ReturnType<typeof setTimeout> | null = null
  useLibrary.subscribe((s, prev) => {
    if (s.entries === prev.entries) return
    if (libTimer) clearTimeout(libTimer)
    libTimer = setTimeout(() => void idle().then(runIndexer), 5000)
  })
  setTimeout(() => void idle().then(runIndexer), 15_000)
}

/** The search dialog is open: index without waiting for idle time. */
export function setIndexerFast(on: boolean) {
  fast = on
  if (on) {
    failed.clear()
    void runIndexer()
  }
}

/** Loads stored records (for the dialog's first render). */
export function ensureIndexLoaded(): Promise<void> {
  return loadRecords()
}
