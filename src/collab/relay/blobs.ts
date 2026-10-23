/**
 * Files (images, attachments) on the relay. Each file is encrypted with the board's content key and
 * stored under the SHA-256 of its ciphertext (the relay verifies it). A keyed alias of the file's
 * real hash lets any board member find it again without the relay learning which file it is.
 *
 *   PUT  /blob/<roomId>/<sha256(ciphertext)>   X-Blob-Alias: HMAC(plainHash)
 *   GET  /blob/<roomId>/<alias>
 */
import * as Y from 'yjs'
import { getLocalBlob } from '../blobs'
import { hashBytes, isValidBlobHash } from '../crypto'
import { boardBlobHashes } from '../../model/blobRefs'
import { KIND, blobAlias, open, seal, type RelayKeys } from './keys'
import { Decoder, Encoder } from './protocol'
import type { RelayStateStore } from './state'
import { blobUrlFor, type RelayEndpoint } from './url'

export interface BlobTarget {
  endpoint: RelayEndpoint
  keys: RelayKeys
}

export type UploadResult = 'uploaded' | 'exists' | 'too-large' | 'quota' | 'failed'

const enc = new TextEncoder()
const dec = new TextDecoder()

function headers(t: BlobTarget, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${t.keys.writeToken}`, ...extra }
  if (t.endpoint.accessKey) h['X-Relay-Key'] = t.endpoint.accessKey
  return h
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Plaintext layout inside the ciphertext: [varString mime][file bytes]. */
export async function encryptBlob(keys: RelayKeys, data: Blob): Promise<Uint8Array> {
  const mime = enc.encode((data.type || 'application/octet-stream').slice(0, 200))
  const header = new Encoder(mime.length + 8).bytes(mime).done()
  const bytes = new Uint8Array(await data.arrayBuffer())
  const plain = new Uint8Array(header.length + bytes.length)
  plain.set(header, 0)
  plain.set(bytes, header.length)
  return seal(keys, KIND.BLOB, plain)
}

export async function decryptBlob(keys: RelayKeys, sealed: Uint8Array): Promise<Blob> {
  const plain = await open(keys, KIND.BLOB, sealed)
  const d = new Decoder(plain)
  const mime = dec.decode(d.bytes(1024))
  const bytes = plain.subarray(d.pos)
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: /^[\w.+-]+\/[\w.+-]+$/.test(mime) ? mime : 'application/octet-stream' })
}

/** True/false when the relay answered, null when it could not be asked. */
export async function relayHasBlob(t: BlobTarget, plainHash: string): Promise<boolean | null> {
  try {
    const alias = await blobAlias(t.keys, plainHash)
    const res = await fetchWithTimeout(blobUrlFor(t.endpoint, t.keys.roomId, alias), { method: 'HEAD', headers: headers(t) }, 15_000)
    if (res.status === 200) return true
    if (res.status === 404) return false
    return null
  } catch {
    return null
  }
}

export async function uploadBlob(t: BlobTarget, plainHash: string, data: Blob): Promise<UploadResult> {
  const has = await relayHasBlob(t, plainHash)
  if (has) return 'exists'
  try {
    const alias = await blobAlias(t.keys, plainHash)
    const sealed = await encryptBlob(t.keys, data)
    const cipherHash = await hashBytes(sealed)
    const res = await fetchWithTimeout(
      blobUrlFor(t.endpoint, t.keys.roomId, cipherHash),
      {
        method: 'PUT',
        headers: headers(t, { 'Content-Type': 'application/octet-stream', 'X-Blob-Alias': alias }),
        body: sealed as Uint8Array<ArrayBuffer>,
      },
      // Generous: large files over slow uplinks.
      10 * 60_000,
    )
    if (res.status === 201) return 'uploaded'
    if (res.status === 200) return 'exists'
    if (res.status === 413) return 'too-large'
    if (res.status === 507) return 'quota'
    return 'failed'
  } catch {
    return 'failed'
  }
}

/** Downloads and decrypts a file. Null when the relay does not have it. The caller verifies the hash. */
export async function downloadBlob(t: BlobTarget, plainHash: string): Promise<Blob | null> {
  const alias = await blobAlias(t.keys, plainHash)
  const res = await fetchWithTimeout(blobUrlFor(t.endpoint, t.keys.roomId, alias), { headers: headers(t) }, 5 * 60_000)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`relay answered ${res.status}`)
  return decryptBlob(t.keys, new Uint8Array(await res.arrayBuffer()))
}

/**
 * Content hashes of every file a board refers to: images, thumbnails, favicons, covers (the board's
 * own and its board cards'), trashed cards included since they can be restored. Same rule as sync
 * scope checks and backups (model/blobRefs.ts).
 */
export function blobHashesIn(doc: Y.Doc): Set<string> {
  return boardBlobHashes(doc)
}

interface Job {
  boardId: string
  hash: string
  tries: number
}

/**
 * Background uploader: makes sure every file used on a relay board is also on the relay, so
 * teammates can load it while the person who added it is offline.
 */
export class RelayBlobSync {
  private queue: Job[] = []
  private queued = new Set<string>()
  private active = 0
  private uploaded = new Map<string, { relay: string; hashes: Set<string> }>()
  /** Files the relay refused for good this session (too large / quota). */
  private refused = new Set<string>()
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private store: RelayStateStore,
    private resolve: (boardId: string) => Promise<BlobTarget | null>,
    private concurrency = 2,
  ) {}

  private uploadedFor(boardId: string, relay: string): Set<string> {
    let u = this.uploaded.get(boardId)
    if (!u || u.relay !== relay) {
      u = { relay, hashes: this.store.loadUploaded(boardId, relay) }
      this.uploaded.set(boardId, u)
    }
    return u.hashes
  }

  enqueue(boardId: string, hash: string) {
    if (!isValidBlobHash(hash)) return
    const key = `${boardId}:${hash}`
    if (this.queued.has(key) || this.refused.has(key)) return
    this.queued.add(key)
    this.queue.push({ boardId, hash, tries: 0 })
    this.pump()
  }

  /** Queues every file on the board that is not yet confirmed on the relay. */
  scanBoard(boardId: string, doc: Y.Doc, relay: string) {
    const done = this.uploadedFor(boardId, relay)
    for (const h of blobHashesIn(doc)) if (!done.has(h)) this.enqueue(boardId, h)
  }

  forget(boardId: string) {
    this.uploaded.delete(boardId)
    this.queue = this.queue.filter((j) => j.boardId !== boardId)
    for (const k of this.queued) if (k.startsWith(`${boardId}:`)) this.queued.delete(k)
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!
      this.active++
      void this.run(job).finally(() => {
        this.active--
        this.pump()
      })
    }
  }

  private async run(job: Job) {
    const key = `${job.boardId}:${job.hash}`
    try {
      const target = await this.resolve(job.boardId)
      if (!target) return
      const relay = target.endpoint.wsBase
      const done = this.uploadedFor(job.boardId, relay)
      if (done.has(job.hash)) return
      // Only the people who have the file can upload it; others will.
      const data = await getLocalBlob(job.hash)
      if (!data) return
      const result = await uploadBlob(target, job.hash, data)
      if (result === 'uploaded' || result === 'exists') {
        done.add(job.hash)
        this.scheduleSave(job.boardId, relay)
      } else if (result === 'too-large' || result === 'quota') {
        this.refused.add(key)
      } else if (job.tries < 3) {
        const retry = { ...job, tries: job.tries + 1 }
        setTimeout(() => {
          this.queued.add(key)
          this.queue.push(retry)
          this.pump()
        }, 5000 * 2 ** job.tries)
      }
    } finally {
      this.queued.delete(key)
    }
  }

  private scheduleSave(boardId: string, relay: string) {
    if (this.saveTimers.has(boardId)) return
    this.saveTimers.set(
      boardId,
      setTimeout(() => {
        this.saveTimers.delete(boardId)
        const u = this.uploaded.get(boardId)
        if (u && u.relay === relay) this.store.saveUploaded(boardId, relay, u.hashes)
      }, 2000),
    )
  }
}
