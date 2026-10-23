/**
 * Wire protocol of the sync engine (see README.md in this folder).
 *
 * Every message on the binary action `y` is `[varUint type][varString docId][payload]`.
 * Pure functions only: everything here is unit tested without a network.
 */
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'
import { MAX_BLOB_BYTES } from '../blobs'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_WANT = 2
export const MSG_HELLO = 3
/** Minor 1: "these are the peers I exchange data with in this room", so peers can relay for each other. */
export const MSG_PEERS = 4
/** Minor 1: AWARENESS relayed for a peer the receiver is not connected to (not the sender's own clients). */
export const MSG_AWARENESS_RELAY = 5

/** Major protocol version: peers with a different value are ignored. */
export const PROTOCOL_VERSION = 1
/** Minor version: additive, backwards compatible changes. */
export const PROTOCOL_MINOR = 1
/** App version announced in HELLO (informational; keep in sync with package.json). */
export { APP_VERSION } from '../../config'
import { APP_VERSION } from '../../config'

/** Largest sync message accepted from a peer (a full board state in one SyncStep2). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
export const MAX_AWARENESS_BYTES = 256 * 1024
export const MAX_AWARENESS_CLIENTS = 512
export const MAX_HELLO_BYTES = 4096
export const MAX_DOC_ID_LENGTH = 64
/** Longest peer list accepted in a PEERS message (rooms are capped at 30 usable peers). */
export const MAX_PEER_LIST = 256
export const MAX_PEER_ID_LENGTH = 64
/** Blob replies carry a small header (mime type) in front of the bytes. */
export const MAX_BLOB_REPLY_BYTES = MAX_BLOB_BYTES + 4096

const KNOWN_TYPES = new Set([MSG_SYNC, MSG_AWARENESS, MSG_WANT, MSG_HELLO, MSG_PEERS, MSG_AWARENESS_RELAY])
/** Messages about the room itself rather than one doc: their docId is empty. */
const ROOM_TYPES = new Set([MSG_HELLO, MSG_PEERS])

export interface Hello {
  v: number
  m: number
  app: string
  /** Same-device channel only: the tab's P2P peer id, so other tabs don't count it as a teammate. */
  p?: string
}

export interface DecodedMessage {
  type: number
  docId: string
  /** Positioned right after the header. */
  decoder: decoding.Decoder
}

function encode(type: number, docId: string, write?: (enc: encoding.Encoder) => void): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  encoding.writeVarString(enc, docId)
  write?.(enc)
  return encoding.toUint8Array(enc)
}

/** Encoder with the SYNC header already written; used as the reply buffer for readSyncMessage. */
export function syncReplyEncoder(docId: string): encoding.Encoder {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  encoding.writeVarString(enc, docId)
  return enc
}

export const encodeSyncStep1 = (docId: string, doc: Y.Doc) => encode(MSG_SYNC, docId, (e) => syncProtocol.writeSyncStep1(e, doc))

export const encodeUpdate = (docId: string, update: Uint8Array) => encode(MSG_SYNC, docId, (e) => syncProtocol.writeUpdate(e, update))

export const encodeAwareness = (docId: string, update: Uint8Array) => encode(MSG_AWARENESS, docId, (e) => encoding.writeVarUint8Array(e, update))

export const encodeAwarenessRelay = (docId: string, update: Uint8Array) =>
  encode(MSG_AWARENESS_RELAY, docId, (e) => encoding.writeVarUint8Array(e, update))

export const encodeWant = (docId: string) => encode(MSG_WANT, docId)

export const ownHello = (p2pId?: string | null): Hello =>
  p2pId ? { v: PROTOCOL_VERSION, m: PROTOCOL_MINOR, app: APP_VERSION, p: p2pId } : { v: PROTOCOL_VERSION, m: PROTOCOL_MINOR, app: APP_VERSION }

export function encodeHello(hello: Hello = ownHello()): Uint8Array {
  return encode(MSG_HELLO, '', (e) => encoding.writeVarString(e, JSON.stringify(hello)))
}

/**
 * Reads the header of a message from a peer. Returns null for anything malformed or for
 * message types this version does not know (newer peers may add types; we ignore them).
 */
export function decodeHeader(bytes: Uint8Array): DecodedMessage | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > MAX_MESSAGE_BYTES) return null
  try {
    const decoder = decoding.createDecoder(bytes)
    const type = decoding.readVarUint(decoder)
    if (!KNOWN_TYPES.has(type)) return null
    const docId = decoding.readVarString(decoder)
    if (docId.length > MAX_DOC_ID_LENGTH) return null
    if (ROOM_TYPES.has(type) ? docId !== '' : !docId) return null
    return { type, docId, decoder }
  } catch {
    return null
  }
}

export function readHello(decoder: decoding.Decoder): Hello | null {
  try {
    const raw = decoding.readVarString(decoder)
    if (raw.length > MAX_HELLO_BYTES) return null
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (!obj || typeof obj !== 'object' || typeof obj.v !== 'number' || !Number.isInteger(obj.v)) return null
    const hello: Hello = {
      v: obj.v,
      m: typeof obj.m === 'number' && Number.isInteger(obj.m) ? obj.m : 0,
      app: typeof obj.app === 'string' ? obj.app.slice(0, 32) : '',
    }
    if (typeof obj.p === 'string' && obj.p.length <= 64) hello.p = obj.p
    return hello
  } catch {
    return null
  }
}

export const isCompatible = (hello: Hello) => hello.v === PROTOCOL_VERSION

/** PEERS: the ids of the peers the sender currently exchanges data with in this room. */
export function encodePeers(peerIds: readonly string[]): Uint8Array {
  const ids = peerIds.filter((p) => typeof p === 'string' && p.length > 0 && p.length <= MAX_PEER_ID_LENGTH).slice(0, MAX_PEER_LIST)
  return encode(MSG_PEERS, '', (e) => {
    encoding.writeVarUint(e, ids.length)
    for (const id of ids) encoding.writeVarString(e, id)
  })
}

export function readPeers(decoder: decoding.Decoder): Set<string> | null {
  try {
    const n = decoding.readVarUint(decoder)
    if (n > MAX_PEER_LIST) return null
    const out = new Set<string>()
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarString(decoder)
      if (!id || id.length > MAX_PEER_ID_LENGTH) return null
      out.add(id)
    }
    return out
  } catch {
    return null
  }
}

export interface AwarenessEntry {
  clientID: number
  clock: number
  /** The update says this client went away (state null). */
  removed: boolean
}

/**
 * Parses the client list of a y-protocols awareness update without applying it, so we can
 * remember which clients a peer speaks for and remove them when it disconnects.
 */
export function readAwarenessEntries(update: Uint8Array): AwarenessEntry[] | null {
  if (update.byteLength > MAX_AWARENESS_BYTES) return null
  try {
    const d = decoding.createDecoder(update)
    const n = decoding.readVarUint(d)
    if (n > MAX_AWARENESS_CLIENTS) return null
    const out: AwarenessEntry[] = []
    for (let i = 0; i < n; i++) {
      const clientID = decoding.readVarUint(d)
      const clock = decoding.readVarUint(d)
      const json = decoding.readVarString(d)
      out.push({ clientID, clock, removed: json === 'null' })
    }
    return out
  } catch {
    return null
  }
}

/**
 * Re-encodes an awareness update with only the entries `keep` accepts (null when none is left).
 * Lets the engine drop entries a peer may not send (our own client, someone else's client with a
 * forged clock) and relay only entries that are new.
 */
export function filterAwarenessUpdate(update: Uint8Array, keep: (e: AwarenessEntry) => boolean): Uint8Array | null {
  if (update.byteLength > MAX_AWARENESS_BYTES) return null
  try {
    const d = decoding.createDecoder(update)
    const n = decoding.readVarUint(d)
    if (n > MAX_AWARENESS_CLIENTS) return null
    const kept: [number, number, string][] = []
    for (let i = 0; i < n; i++) {
      const clientID = decoding.readVarUint(d)
      const clock = decoding.readVarUint(d)
      const json = decoding.readVarString(d)
      if (keep({ clientID, clock, removed: json === 'null' })) kept.push([clientID, clock, json])
    }
    if (!kept.length) return null
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, kept.length)
    for (const [clientID, clock, json] of kept) {
      encoding.writeVarUint(e, clientID)
      encoding.writeVarUint(e, clock)
      encoding.writeVarString(e, json)
    }
    return encoding.toUint8Array(e)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Blob replies: [varUint 1][varString mime][bytes...]

const BLOB_ENVELOPE_VERSION = 1

export function encodeBlobHeader(mime: string): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, BLOB_ENVELOPE_VERSION)
  encoding.writeVarString(enc, mime.slice(0, 255))
  return encoding.toUint8Array(enc)
}

export function decodeBlobReply(bytes: Uint8Array): { mime: string; bytes: Uint8Array } | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BLOB_REPLY_BYTES) return null
  try {
    const d = decoding.createDecoder(bytes)
    if (decoding.readVarUint(d) !== BLOB_ENVELOPE_VERSION) return null
    const mime = decoding.readVarString(d)
    if (mime.length > 255) return null
    return { mime, bytes: decoding.readTailAsUint8Array(d) }
  } catch {
    return null
  }
}

const SAFE_MIME =
  /^(image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon|tiff|heic|heif)|video\/(mp4|webm|ogg|quicktime)|audio\/(mpeg|ogg|wav|x-wav|webm|mp4|aac|flac)|application\/(pdf|zip|json)|text\/(plain|csv|markdown))$/

/**
 * Mime types claimed by peers are untrusted. Anything that a browser could render as an active
 * document from a blob: URL (HTML, XML, JS...) is downgraded to an opaque download.
 */
export function sanitizeMime(mime: unknown): string {
  if (typeof mime !== 'string') return 'application/octet-stream'
  const base = mime.split(';')[0].trim().toLowerCase()
  return SAFE_MIME.test(base) ? base : 'application/octet-stream'
}
