/**
 * Invite links. The board id + secret travel in the URL *fragment* (after #), which browsers
 * never send to any server, so even the static web host cannot see them.
 *
 *   https://<web-host>/#/join/<payload>      (clickable, works for people without the app)
 *   noema://join/<payload>               (opens the desktop app directly)
 */
import { PROTOCOL, PUBLIC_URL } from '../config'
import { base64UrlToBytes, bytesToBase64Url, isValidId } from '../model/ids'

export interface InvitePayload {
  /** Board id */
  b: string
  /** Board secret */
  k: string
  /** Board title, for display before the board has synced */
  t: string
  /** Optional relay server URL */
  r?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeInvite(p: InvitePayload): string {
  const clean: InvitePayload = { b: p.b, k: p.k, t: p.t.slice(0, 120) }
  if (p.r) clean.r = p.r
  return bytesToBase64Url(enc.encode(JSON.stringify(clean)))
}

export function decodeInvite(s: string): InvitePayload | null {
  try {
    const obj = JSON.parse(dec.decode(base64UrlToBytes(s))) as Partial<InvitePayload>
    if (!isValidId(obj.b) || typeof obj.k !== 'string' || !/^[A-Za-z0-9_-]{32,64}$/.test(obj.k)) return null
    const out: InvitePayload = { b: obj.b, k: obj.k, t: typeof obj.t === 'string' ? obj.t.slice(0, 120) : 'Shared board' }
    if (typeof obj.r === 'string' && /^(wss?|https?):\/\/[^\s]+$/.test(obj.r)) out.r = obj.r
    return out
  } catch {
    return null
  }
}

/** Web link if a public web build is configured, otherwise the desktop deep link. */
export function makeInviteLink(p: InvitePayload): string {
  const payload = encodeInvite(p)
  if (PUBLIC_URL) return `${PUBLIC_URL.replace(/\/?$/, '/')}#/join/${payload}`
  return makeDesktopLink(p)
}

export function makeDesktopLink(p: InvitePayload): string {
  return `${PROTOCOL}://join/${encodeInvite(p)}`
}

/** Accepts any invite format (web link, deep link, or bare payload) pasted by a user. */
export function parseInviteLink(text: string): InvitePayload | null {
  const t = text.trim()
  const m = t.match(/join\/([A-Za-z0-9_-]{20,})/)
  if (m) return decodeInvite(m[1])
  if (/^[A-Za-z0-9_-]{20,}$/.test(t)) return decodeInvite(t)
  return null
}
