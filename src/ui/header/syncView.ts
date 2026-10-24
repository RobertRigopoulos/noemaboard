/** What the connection pill says, derived from sync + relay status (pure, unit-tested). */
import { HOME_BOARD_ID } from '../../config'
import type { LibraryEntry } from '../../collab/library'
import { SYNC_PROBLEMS, type BoardSyncStatus } from '../../collab/sync/status'
import type { BoardRelayStatus } from '../../collab/relay/status'

/**
 * The board whose peer-to-peer room carries this board: the board itself when shared,
 * otherwise the nearest shared ancestor (nested boards are synced through their parent's room).
 */
export function syncScope(boardId: string, entries: Record<string, LibraryEntry>): string | null {
  let cur: string | null = boardId
  const seen = new Set<string>()
  while (cur && cur !== HOME_BOARD_ID && !seen.has(cur) && seen.size < 64) {
    seen.add(cur)
    const e: LibraryEntry | undefined = entries[cur]
    if (!e) return null
    if (e.shared) return cur
    cur = e.parentId
  }
  return null
}

export function timeAgo(ts: number, now = Date.now()): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ts).toLocaleDateString()
}

export type SyncKind = 'offline' | 'problem' | 'private' | 'alone' | 'live' | 'relay' | 'off'

export interface SyncView {
  kind: SyncKind
  label: string
  detail: string
  /** What clicking the pill should open. */
  action: 'share' | 'network'
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 60)
  }
}

export function relayText(r: BoardRelayStatus): string {
  const host = hostOf(r.url)
  if (r.state === 'connected')
    return `Connected to the sync server at ${host}${r.pending ? ` (${r.pending} change${r.pending === 1 ? '' : 's'} uploading)` : ''}.`
  if (r.state === 'connecting') return `Connecting to the sync server at ${host}…`
  if (r.state === 'offline') return `The sync server at ${host} is not reachable right now.`
  return r.message ? `Sync server: ${r.message.slice(0, 200)}` : `The sync server at ${host} is not working.`
}

const P2P_OFF = 'Peer-to-peer sync is turned off in Settings → Network.'

/**
 * Problems that only affect direct (peer-to-peer) connections. A connected sync server carries the
 * board's changes and presence anyway, so they are not worth a warning then. They rank below every
 * other problem, so hiding one never hides a more important one.
 */
const DIRECT_ONLY = new Set<string>([SYNC_PROBLEMS.webrtc, SYNC_PROBLEMS.signaling, SYNC_PROBLEMS.turn, SYNC_PROBLEMS.full])

/**
 * @param p2pEnabled the "Peer-to-peer sync" network setting. When it is off, only a sync server
 *   (relay) can carry changes, so without one a shared board does not sync at all.
 */
export function describeSync(
  online: boolean,
  problem: string | null,
  scope: string | null,
  st: BoardSyncStatus | undefined,
  relay?: BoardRelayStatus,
  p2pEnabled = true,
): SyncView {
  if (!online)
    return {
      kind: 'offline',
      label: 'Offline',
      detail: "You're offline. Changes are saved on this device and sync when you reconnect.",
      action: 'share',
    }
  if (!scope && !relay)
    return { kind: 'private', label: 'Private', detail: 'Only you can see this board. Share it to work on it together in real time.', action: 'share' }
  if (!p2pEnabled && !relay)
    return {
      kind: 'off',
      label: 'Sync off',
      detail: `${P2P_OFF} Your changes are saved on this device only and won't reach your teammates until you turn it back on.`,
      action: 'network',
    }
  const peers = Math.max(st?.peers ?? 0, relay?.peers ?? 0)
  const relayNote = relay ? ` ${relayText(relay)}` : ''
  const shown = problem && relay?.state === 'connected' && DIRECT_ONLY.has(problem) ? null : problem
  if (peers > 0)
    return {
      kind: 'live',
      label: `${peers + 1} online`,
      detail: `Connected to ${peers} other device${peers === 1 ? '' : 's'}. Changes sync instantly.${relayNote}${shown ? ` ${shown}` : ''}`,
      action: 'share',
    }
  if (relay?.state === 'error') return { kind: 'problem', label: 'Sync server issue', detail: relayText(relay), action: 'share' }
  if (shown) return { kind: 'problem', label: 'Connection issue', detail: shown, action: 'network' }
  const lastAt = Math.max(st?.lastSyncAt ?? 0, relay?.lastSyncAt ?? 0)
  const last = lastAt ? ` Last synced ${timeAgo(lastAt)}.` : ''
  if (relay?.state === 'connected')
    return {
      kind: 'relay',
      label: 'Synced',
      detail: `${relayText(relay)} Teammates get your changes even when you're not online at the same time.${last}`,
      action: 'share',
    }
  // Only the sync server can carry changes, and it is not connected (yet).
  if (!p2pEnabled && relay)
    return {
      kind: relay.state === 'offline' ? 'problem' : 'alone',
      label: relay.state === 'offline' ? 'Not syncing' : 'Connecting…',
      detail: `${relayText(relay)} ${P2P_OFF} Your changes are saved on this device and sync once the server is reachable.${last}`,
      action: 'network',
    }
  return {
    kind: 'alone',
    label: 'Only you',
    detail: `No teammates are connected right now. Your changes are saved on this device and sync when someone opens this board.${last}${relayNote}`,
    action: 'share',
  }
}
