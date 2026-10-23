/**
 * Everything derived from a board's capability secret. The secret itself never leaves the
 * invite link / local storage; signaling relays and relay servers only ever see derived values.
 */
import { bytesToBase64Url } from '../model/ids'

const enc = new TextEncoder()

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

const cache = new Map<string, Promise<string>>()

function derive(label: string, secret: string, length: number): Promise<string> {
  const key = `${label}\u0000${secret}`
  let p = cache.get(key)
  if (!p) {
    p = sha256(`${label}:${secret}`).then((b) => bytesToBase64Url(b).slice(0, length))
    cache.set(key, p)
  }
  return p
}

/** Public rendezvous id for the board's peer-to-peer room. */
export const deriveRoomId = (secret: string) => derive('noema-room-v1', secret, 32)

/** Password used to encrypt WebRTC signaling (SDP) for the room. */
export const deriveRoomPassword = (secret: string) => derive('noema-pass-v1', secret, 43)

/** Token proving knowledge of the secret to an (optional) relay server. */
export const deriveRelayToken = (secret: string) => derive('noema-relay-v1', secret, 43)

/** Hex SHA-256 of bytes, used as content address for blobs (images, files). */
export async function hashBytes(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buf as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const b of digest) hex += b.toString(16).padStart(2, '0')
  return hex
}

export function isValidBlobHash(h: unknown): h is string {
  return typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)
}
