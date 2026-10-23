/**
 * Signaling relays and WebRTC configuration. One fixed relay list per strategy for the whole app:
 * Trystero initialises a strategy's relays once, so rooms with different lists interfere.
 */
import { DEFAULT_STUN } from '../../config'
import { MAX_BLOB_REPLY_BYTES } from './protocol'
import type { NetworkSettings } from './settings'

/** Public Nostr relays that answered subscriptions reliably when tested. */
export const DEFAULT_NOSTR_RELAYS = [
  'wss://nos.lol',
  'wss://0x-nostr-relay.fly.dev',
  'wss://nostr.chaima.info',
  'wss://nostr.christiansass.de',
  'wss://nostr.stakey.net',
  'wss://nostr.red5d.dev',
  'wss://relay.nostr.dev.br',
  'wss://relay.layer.systems',
]

/** Public WebTorrent trackers. */
export const DEFAULT_TRACKERS = ['wss://tracker.openwebtorrent.com', 'wss://tracker.webtorrent.dev', 'wss://open.ftorrent.com']

const MAX_EXTRA_RELAYS = 16
const MAX_ICE_SERVERS = 8

export interface NetConfig {
  nostrRelays: string[]
  trackers: string[]
  rtcConfig: RTCConfiguration
  maxReceiveBytes: number
}

function isSocketUrl(u: string): boolean {
  try {
    const url = new URL(u)
    if (url.username || url.password) return false
    if (url.protocol === 'wss:') return true
    // Plain ws:// only for a relay on this machine / LAN during development.
    return url.protocol === 'ws:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)
  } catch {
    return false
  }
}

/** Normalises user-entered relay URLs: wss:// only, deduplicated, bounded. */
export function sanitizeRelayUrls(list: unknown, max = MAX_EXTRA_RELAYS): string[] {
  if (!Array.isArray(list)) return []
  const out: string[] = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const u = raw.trim().replace(/\/+$/, '')
    if (!u || u.length > 512 || !isSocketUrl(u) || out.includes(u)) continue
    out.push(u)
    if (out.length >= max) break
  }
  return out
}

const ICE_URL = /^(stun|stuns|turn|turns):[^\s]+$/i

/** Validates user-entered ICE servers (TURN) into a shape RTCPeerConnection accepts. */
export function sanitizeIceServers(list: unknown): RTCIceServer[] {
  if (!Array.isArray(list)) return []
  const out: RTCIceServer[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const s = raw as Record<string, unknown>
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
      (u): u is string => typeof u === 'string' && u.length <= 512 && ICE_URL.test(u.trim()),
    )
    if (!urls.length) continue
    const server: RTCIceServer = { urls: urls.map((u) => u.trim()) }
    if (typeof s.username === 'string' && s.username) server.username = s.username.slice(0, 256)
    if (typeof s.credential === 'string' && s.credential) server.credential = s.credential.slice(0, 512)
    out.push(server)
    if (out.length >= MAX_ICE_SERVERS) break
  }
  return out
}

export function buildNetConfig(s: Pick<NetworkSettings, 'iceServers' | 'nostrRelays' | 'trackers'>): NetConfig {
  const merge = (defaults: string[], extra: unknown) => [...defaults, ...sanitizeRelayUrls(extra).filter((u) => !defaults.includes(u))]
  return {
    nostrRelays: merge(DEFAULT_NOSTR_RELAYS, s.nostrRelays),
    trackers: merge(DEFAULT_TRACKERS, s.trackers),
    rtcConfig: { iceServers: [...DEFAULT_STUN, ...sanitizeIceServers(s.iceServers)] },
    maxReceiveBytes: MAX_BLOB_REPLY_BYTES,
  }
}

/** Stable key: rooms are rejoined only when this changes. */
export function netConfigKey(s: Pick<NetworkSettings, 'iceServers' | 'nostrRelays' | 'trackers'>): string {
  const c = buildNetConfig(s)
  return JSON.stringify([c.nostrRelays, c.trackers, c.rtcConfig.iceServers])
}

/** User-facing problem with a relay/tracker URL typed in Settings, or null when it is usable. */
export function checkRelayUrl(raw: string): string | null {
  const u = raw.trim()
  if (!u) return 'Enter an address.'
  if (!/^wss?:\/\//i.test(u)) return 'Use a secure WebSocket address starting with wss://'
  return isSocketUrl(u) ? null : 'This is not a valid wss:// address.'
}

/** User-facing problem with a TURN/STUN server typed in Settings, or null when it is usable. */
export function checkIceServer(s: { urls: string; username?: string; credential?: string }): string | null {
  const url = s.urls.trim()
  if (!ICE_URL.test(url)) return 'Use an address like turn:turn.example.com:3478 or turns:… for TLS.'
  if (/^turns?:/i.test(url) && (!s.username || !s.credential)) return 'TURN servers need a username and a password.'
  return null
}

/** True when the configuration includes at least one TURN server. */
export const hasTurn = (s: Pick<NetworkSettings, 'iceServers'>) =>
  sanitizeIceServers(s.iceServers).some((x) => (Array.isArray(x.urls) ? x.urls : [x.urls]).some((u) => /^turns?:/i.test(u)))
