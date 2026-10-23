/**
 * Wires the sync engine to the app's singletons: doc registry, library, presence, blob store,
 * network settings and the status store. The WebRTC transport is loaded lazily.
 */
import { docs } from '../docs'
import { isProvisionalSecret, secretOwner, useLibrary } from '../library'
import { onAwarenessCreated, onAwarenessDestroyed } from '../presence'
import { getLocalBlob, registerBlobFetcher } from '../blobs'
import { STORAGE_PREFIX } from '../profile'
import { BroadcastChannelTransport } from './broadcast'
import { SyncEngine, type LibrarySource } from './engine'
import { buildNetConfig, netConfigKey } from './network'
import { getNetworkSettings, useNetworkSettings } from './settings'
import { statusSink, useSyncStatus } from './status'
import { TransportUnavailableError, type TransportFactory } from './transport'

export { useSyncStatus, useBoardSyncStatus, SYNC_PROBLEMS } from './status'
export type { BoardSyncStatus, SyncStatusState } from './status'
export { useNetworkSettings, getNetworkSettings } from './settings'
export type { NetworkSettings } from './settings'
export { DEFAULT_NOSTR_RELAYS, DEFAULT_TRACKERS, checkIceServer, checkRelayUrl, hasTurn, sanitizeIceServers, sanitizeRelayUrls } from './network'

/** Signaling may take a while on first start; complain only after this long without any relay. */
const SIGNALING_GRACE_MS = 25_000
const WATCHDOG_MS = 5_000

let engine: SyncEngine | null = null
let teardown: (() => void) | null = null
let trystero: typeof import('./trystero') | null = null

const library: LibrarySource = {
  sharedBoards: () =>
    Object.values(useLibrary.getState().entries)
      .filter((e) => e.shared && !!e.secret)
      .map((e) => ({ id: e.id, secret: e.secret, trusted: !isProvisionalSecret(e) })),
  secretOf: (id) => useLibrary.getState().entries[id]?.secret || undefined,
  secretOwner: (secret) => secretOwner(useLibrary.getState().entries, secret),
  subscribe: (cb) => {
    let prev = useLibrary.getState().entries
    return useLibrary.subscribe((s) => {
      if (s.entries === prev) return
      prev = s.entries
      cb()
    })
  },
  markShared: (id, secret) => {
    const entries = useLibrary.getState().entries
    const prev = entries[id]
    if (prev?.shared) return
    if (prev?.secret) {
      useLibrary.getState().upsert({ id, shared: true })
      return
    }
    // Without a secret there is no room to join; the secret came from a board card, and one that
    // belongs to another board never opens a room for this id.
    if (!secret) return
    const owner = secretOwner(entries, secret)
    if (owner !== undefined && owner !== id) return
    useLibrary.getState().upsert({ id, shared: true, secret, secretFrom: 'card' })
  },
}

const createTransport: TransportFactory = async (opts) => {
  if (typeof RTCPeerConnection === 'undefined') throw new TransportUnavailableError()
  trystero ??= await import('./trystero')
  return trystero.createTrysteroTransport(opts, buildNetConfig(getNetworkSettings()))
}

/** Starts peer-to-peer (and optional relay) sync for all shared boards. Idempotent. */
export function startSync(): void {
  if (engine || typeof window === 'undefined') return
  const settings = getNetworkSettings()
  const local = BroadcastChannelTransport.isSupported() ? new BroadcastChannelTransport(`${STORAGE_PREFIX}sync`) : null
  const e = new SyncEngine({
    docs,
    library,
    presence: { onAwarenessCreated, onAwarenessDestroyed },
    blobs: { get: getLocalBlob, registerFetcher: registerBlobFetcher },
    status: statusSink,
    createTransport,
    localTransport: local,
    p2pEnabled: settings.p2pEnabled !== false,
  })
  engine = e
  e.start()

  const offs: (() => void)[] = []

  let netKey = netConfigKey(settings)
  offs.push(
    useNetworkSettings.subscribe((s) => {
      e.setP2PEnabled(s.p2pEnabled !== false)
      const key = netConfigKey(s)
      if (key === netKey) return
      netKey = key
      // Trystero reads relay lists once per strategy: every room must leave before rejoining.
      if (s.p2pEnabled !== false) void e.reconnectAll()
    }),
  )

  let backTimer: ReturnType<typeof setTimeout> | null = null
  const onOnline = () => {
    useSyncStatus.setState({ online: true })
    // Give the OS a moment to bring routes up before we resync and rejoin empty rooms.
    if (backTimer) clearTimeout(backTimer)
    backTimer = setTimeout(() => e.networkBack(), 1500)
  }
  const onOffline = () => useSyncStatus.setState({ online: false })
  const onVisible = () => {
    if (document.visibilityState === 'visible') e.antiEntropy()
  }
  // A lazily loaded part of the app (such as the WebRTC code, loaded with the first shared board)
  // is gone from the server: a new version was published while this window was open. It cannot
  // load until the app is reloaded, so say so instead of silently staying offline.
  const onPreloadError = () => statusSink.setProblem('reload', true)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('vite:preloadError', onPreloadError)
  document.addEventListener('visibilitychange', onVisible)
  offs.push(() => {
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('vite:preloadError', onPreloadError)
    document.removeEventListener('visibilitychange', onVisible)
    if (backTimer) clearTimeout(backTimer)
  })

  // Signaling watchdog: no relay socket open for a while (and we are online) -> tell the user.
  let downSince = 0
  const watchdog = setInterval(() => {
    const wanted = getNetworkSettings().p2pEnabled !== false && e.hasP2PTransports() && navigator.onLine
    const ok = wanted && trystero ? trystero.signalingConnected() : true
    if (!wanted || ok) {
      downSince = 0
      statusSink.setProblem('signaling', false)
      return
    }
    downSince ||= Date.now()
    if (Date.now() - downSince >= SIGNALING_GRACE_MS) statusSink.setProblem('signaling', true)
  }, WATCHDOG_MS)
  offs.push(() => clearInterval(watchdog))

  teardown = () => offs.forEach((f) => f())
}

/** Stops all sync (used by tests and hot reload). */
export async function stopSync(): Promise<void> {
  const e = engine
  engine = null
  teardown?.()
  teardown = null
  await e?.stop()
}

/** The running engine, for diagnostics. */
export const getSyncEngine = (): SyncEngine | null => engine

// A hot reload re-runs startSync(); the old engine must not keep its rooms and listeners.
import.meta.hot?.dispose(() => {
  void stopSync()
})
