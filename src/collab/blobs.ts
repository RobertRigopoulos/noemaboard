/**
 * Content-addressed blob store for images and files. Bytes live in IndexedDB keyed by their
 * SHA-256 hex; boards only store the hash. Missing blobs are fetched from peers/relays through
 * registered fetchers (see collab/sync and collab/relay).
 */
import { openDB, type IDBPDatabase } from 'idb'
import { useEffect, useState } from 'react'
import { STORAGE_PREFIX } from './profile'
import { hashBytes, isValidBlobHash } from './crypto'

interface BlobRecord {
  hash: string
  mime: string
  size: number
  blob: Blob
  createdAt: number
}

let dbPromise: Promise<IDBPDatabase> | null = null
const memory = new Map<string, BlobRecord>()

function db(): Promise<IDBPDatabase> | null {
  if (typeof indexedDB === 'undefined') return null
  if (!dbPromise) {
    dbPromise = openDB(`${STORAGE_PREFIX}blobs`, 1, {
      upgrade(d) {
        d.createObjectStore('blobs', { keyPath: 'hash' })
      },
    })
  }
  return dbPromise
}

/** Max size accepted from disk/clipboard/peers. */
export const MAX_BLOB_BYTES = 200 * 1024 * 1024

type Fetcher = (hash: string, boardId: string | null) => Promise<Blob | null>
const fetchers = new Set<Fetcher>()
type PutListener = (hash: string, rec: { mime: string; size: number }, boardId: string | null) => void
const putListeners = new Set<PutListener>()

/** Sync layers register a way to fetch blobs from other devices. */
export function registerBlobFetcher(f: Fetcher): () => void {
  fetchers.add(f)
  return () => fetchers.delete(f)
}

/** Relay layer can upload new blobs when they are added. */
export function onBlobPut(l: PutListener): () => void {
  putListeners.add(l)
  return () => putListeners.delete(l)
}

export async function putBlob(data: Blob, boardId: string | null = null): Promise<{ hash: string; size: number; mime: string }> {
  if (data.size > MAX_BLOB_BYTES) throw new Error(`File is larger than ${MAX_BLOB_BYTES / 1024 / 1024} MB`)
  const buf = await data.arrayBuffer()
  const hash = await hashBytes(buf)
  const mime = data.type || 'application/octet-stream'
  await storeBlob(hash, new Blob([buf], { type: mime }))
  putListeners.forEach((l) => l(hash, { mime, size: data.size }, boardId))
  return { hash, size: data.size, mime }
}

/** Stores bytes received from a peer after verifying their hash. Returns false on mismatch. */
export async function putVerifiedBlob(hash: string, data: Blob): Promise<boolean> {
  if (!isValidBlobHash(hash) || data.size > MAX_BLOB_BYTES) return false
  const actual = await hashBytes(await data.arrayBuffer())
  if (actual !== hash) return false
  await storeBlob(hash, data)
  return true
}

async function storeBlob(hash: string, blob: Blob) {
  const rec: BlobRecord = { hash, mime: blob.type, size: blob.size, blob, createdAt: Date.now() }
  const d = db()
  if (!d) {
    memory.set(hash, rec)
    return
  }
  await (await d).put('blobs', rec)
}

export async function getLocalBlob(hash: string): Promise<Blob | null> {
  if (!isValidBlobHash(hash)) return null
  const d = db()
  if (!d) return memory.get(hash)?.blob ?? null
  const rec = (await (await d).get('blobs', hash)) as BlobRecord | undefined
  return rec?.blob ?? null
}

export async function hasBlob(hash: string): Promise<boolean> {
  if (!isValidBlobHash(hash)) return false
  const d = db()
  if (!d) return memory.has(hash)
  return (await (await d).getKey('blobs', hash)) !== undefined
}

const inflight = new Map<string, Promise<Blob | null>>()

/** Local blob, or fetched from peers/relay (deduplicated). Resolves null if nobody has it. */
export function getBlob(hash: string, boardId: string | null = null): Promise<Blob | null> {
  let p = inflight.get(hash)
  if (p) return p
  p = (async () => {
    const local = await getLocalBlob(hash)
    if (local) return local
    for (const f of fetchers) {
      try {
        const b = await f(hash, boardId)
        if (b && (await putVerifiedBlob(hash, b))) return b
      } catch {
        // try next source
      }
    }
    return null
  })()
  inflight.set(hash, p)
  p.finally(() => inflight.delete(hash))
  return p
}

// ---------------------------------------------------------------------------
// Object URLs with ref counting so many cards can show the same image cheaply.

const urls = new Map<string, { url: string; refs: number; timer: ReturnType<typeof setTimeout> | null }>()

function acquireUrl(hash: string, blob: Blob): string {
  let e = urls.get(hash)
  if (!e) {
    e = { url: URL.createObjectURL(blob), refs: 0, timer: null }
    urls.set(hash, e)
  }
  if (e.timer) {
    clearTimeout(e.timer)
    e.timer = null
  }
  e.refs++
  return e.url
}

function releaseUrl(hash: string) {
  const e = urls.get(hash)
  if (!e) return
  e.refs--
  if (e.refs <= 0 && !e.timer) {
    e.timer = setTimeout(() => {
      URL.revokeObjectURL(e.url)
      urls.delete(hash)
    }, 30_000)
  }
}

export type BlobState = 'loading' | 'ready' | 'missing'

/** Object URL for a blob; retries periodically while it is missing (a peer may come online). */
export function useBlobUrl(hash: string | null | undefined, boardId: string | null = null): { url: string | null; state: BlobState } {
  const [res, setRes] = useState<{ url: string | null; state: BlobState }>({ url: null, state: hash ? 'loading' : 'missing' })
  useEffect(() => {
    if (!hash || !isValidBlobHash(hash)) {
      setRes({ url: null, state: 'missing' })
      return
    }
    let cancelled = false
    let acquired = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const attempt = async () => {
      const blob = await getBlob(hash, boardId)
      if (cancelled) return
      if (blob) {
        acquired = true
        setRes({ url: acquireUrl(hash, blob), state: 'ready' })
      } else {
        setRes({ url: null, state: attempts === 0 ? 'loading' : 'missing' })
        attempts++
        retry = setTimeout(attempt, Math.min(30_000, 2000 * attempts))
      }
    }
    void attempt()
    return () => {
      cancelled = true
      if (retry) clearTimeout(retry)
      if (acquired) releaseUrl(hash)
    }
  }, [hash, boardId])
  return res
}
