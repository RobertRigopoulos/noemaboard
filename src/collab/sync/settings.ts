/**
 * Network settings for peer-to-peer sync (owned by the sync engine). Stored locally, shared by
 * every tab and window of the profile: a change in one applies to all of them at once.
 */
import { create } from 'zustand'
import { loadJSON, saveJSON, storageKey } from '../profile'
import { sanitizeIceServers, sanitizeRelayUrls } from './network'

export interface NetworkSettings {
  /** Extra ICE servers (TURN) for networks where direct connections fail. */
  iceServers: RTCIceServer[]
  /** Extra Nostr relay URLs (wss://) used for finding peers. */
  nostrRelays: string[]
  /** Extra WebTorrent tracker URLs (wss://) used for finding peers. */
  trackers: string[]
  /** Turn peer-to-peer sync off entirely (local only / relay only). */
  p2pEnabled: boolean
}

const DEFAULTS: NetworkSettings = { iceServers: [], nostrRelays: [], trackers: [], p2pEnabled: true }

/** Stored settings, checked field by field (storage is shared with other tabs and versions). */
export function parseNetworkSettings(raw: unknown): NetworkSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    iceServers: sanitizeIceServers(o.iceServers),
    nostrRelays: sanitizeRelayUrls(o.nostrRelays),
    trackers: sanitizeRelayUrls(o.trackers),
    p2pEnabled: o.p2pEnabled !== false,
  }
}

export const useNetworkSettings = create<NetworkSettings & { update: (p: Partial<NetworkSettings>) => void }>((set, get) => ({
  ...DEFAULTS,
  ...parseNetworkSettings(loadJSON<unknown>('network', {})),
  update: (p) => {
    set(p)
    const { update: _u, ...rest } = { ...get() }
    saveJSON('network', rest)
  },
}))

export const getNetworkSettings = (): NetworkSettings => {
  const { update: _u, ...rest } = useNetworkSettings.getState()
  return rest
}

function sameSettings(a: NetworkSettings, b: NetworkSettings): boolean {
  return a.p2pEnabled === b.p2pEnabled && JSON.stringify([a.iceServers, a.nostrRelays, a.trackers]) === JSON.stringify([b.iceServers, b.nostrRelays, b.trackers])
}

// Peer-to-peer turned off (or relays / TURN changed) in another tab or window: apply it here too.
// The sync engine follows this store (sync/index.ts), so this tab leaves the public relays as well.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== storageKey('network') && e.key !== null) return
    try {
      const next = e.newValue === null ? { ...DEFAULTS } : parseNetworkSettings(JSON.parse(e.newValue))
      if (!sameSettings(getNetworkSettings(), next)) useNetworkSettings.setState(next)
    } catch {
      // ignore malformed data
    }
  })
}
