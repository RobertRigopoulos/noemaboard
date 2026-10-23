import { customAlphabet } from 'nanoid'

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Short random id for cards, comments, strokes, trash entries. */
export const newId = customAlphabet(alphabet, 14)

/** Board ids are longer: they are also Y.Doc guids and storage keys. */
export const newBoardId = customAlphabet(alphabet, 20)

/** 32 random bytes, base64url. The capability secret that grants access to a board. */
export function newSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return bytesToBase64Url(bytes)
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Validates ids received from peers or links before using them as storage keys. */
export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-zA-Z_-]{6,64}$/.test(id)
}
