/**
 * Everything the relay client derives from a board's capability secret (HKDF-SHA256, WebCrypto).
 * The relay only ever learns `roomId` and `writeToken`; the content key never leaves the device,
 * so the relay operator cannot read boards.
 *
 *   roomId       16 bytes, base64url  public id of the board's relay room
 *   writeToken   32 bytes, base64url  proves knowledge of the secret (relay stores its SHA-256)
 *   contentKey   AES-256-GCM          encrypts updates, snapshots, presence and files
 *   blobAliasKey HMAC-SHA256          maps a file's plaintext hash to an opaque lookup id
 */
import { bytesToBase64Url } from '../../model/ids'

const enc = new TextEncoder()
const SALT = enc.encode('noema/relay/v1')

export interface RelayKeys {
  roomId: string
  writeToken: string
  contentKey: CryptoKey
  blobAliasKey: CryptoKey
}

/** Payload kinds sealed inside the ciphertext so one kind can never be replayed as another. */
export const KIND = {
  UPDATE: 1,
  SNAPSHOT: 2,
  AWARENESS: 3,
  BLOB: 4,
} as const
export type Kind = (typeof KIND)[keyof typeof KIND]

const FORMAT_VERSION = 1
const IV_BYTES = 12

const cache = new Map<string, Promise<RelayKeys>>()

function hkdf(info: string) {
  return { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: enc.encode(info) } as const
}

/** Uncached derivation (prefer deriveRelayKeys). */
export async function deriveRelayKeysUncached(secret: string): Promise<RelayKeys> {
  if (!secret) throw new Error('missing board secret')
  const ikm = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits', 'deriveKey'])
  const [room, token, contentKey, blobAliasKey] = await Promise.all([
    crypto.subtle.deriveBits(hkdf('mnf relay room id'), ikm, 16 * 8),
    crypto.subtle.deriveBits(hkdf('mnf relay write token'), ikm, 32 * 8),
    crypto.subtle.deriveKey(hkdf('mnf relay content key'), ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']),
    crypto.subtle.deriveKey(hkdf('mnf relay blob alias'), ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']),
  ])
  return {
    roomId: bytesToBase64Url(new Uint8Array(room)),
    writeToken: bytesToBase64Url(new Uint8Array(token)),
    contentKey,
    blobAliasKey,
  }
}

/** Deterministic: the same secret always yields the same room, token and keys (cached). */
export function deriveRelayKeys(secret: string): Promise<RelayKeys> {
  let p = cache.get(secret)
  if (!p) {
    p = deriveRelayKeysUncached(secret)
    cache.set(secret, p)
    p.catch(() => cache.delete(secret))
  }
  return p
}

/**
 * Encrypts `plain` as `[version][iv(12)][AES-GCM(kind || plain)]` with a fresh random IV and the
 * room id as additional authenticated data (ciphertext from one board cannot be moved to another).
 */
export async function seal(keys: RelayKeys, kind: Kind, plain: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const body = new Uint8Array(plain.length + 1)
  body[0] = kind
  body.set(plain, 1)
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.roomId) }, keys.contentKey, body),
  )
  const out = new Uint8Array(1 + IV_BYTES + ct.length)
  out[0] = FORMAT_VERSION
  out.set(iv, 1)
  out.set(ct, 1 + IV_BYTES)
  return out
}

/** Bytes added by seal() on top of the plaintext. */
export const SEAL_OVERHEAD = 1 + IV_BYTES + 1 + 16

/** Decrypts and authenticates a sealed payload of the expected kind. Throws on any mismatch. */
export async function open(keys: RelayKeys, kind: Kind, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < SEAL_OVERHEAD || sealed[0] !== FORMAT_VERSION) throw new Error('malformed ciphertext')
  const iv = sealed.slice(1, 1 + IV_BYTES)
  const ct = sealed.slice(1 + IV_BYTES)
  const body = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.roomId) }, keys.contentKey, ct),
  )
  if (body[0] !== kind) throw new Error('unexpected payload kind')
  return body.subarray(1)
}

/** Opaque, stable lookup id for a file on the relay (hides the file's real hash from the operator). */
export async function blobAlias(keys: RelayKeys, plainHash: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', keys.blobAliasKey, enc.encode(plainHash)))
  let hex = ''
  for (const b of mac) hex += b.toString(16).padStart(2, '0')
  return hex
}
