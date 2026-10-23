/** Connection pill: Private / Only you / N online / Synced (relay) / Offline / Sync off / connection problem. */
import { useMemo } from 'react'
import { Cloud, CloudOff, Lock, TriangleAlert, WifiOff } from 'lucide-react'
import { HOME_BOARD_ID } from '../../config'
import { useLibrary } from '../../collab/library'
import { useSyncStatus } from '../../collab/sync/status'
import { useRelayStatus } from '../../collab/relay/status'
import { useNetworkSettings } from '../../collab/sync/settings'
import { describeSync, syncScope, type SyncView } from './syncView'

export { syncScope }

export function SyncStatus({ boardId, onClick }: { boardId: string; onClick: (action: SyncView['action']) => void }) {
  const online = useSyncStatus((s) => s.online)
  const problem = useSyncStatus((s) => s.problem)
  const entries = useLibrary((s) => s.entries)
  const scope = useMemo(() => syncScope(boardId, entries), [boardId, entries])
  const own = useSyncStatus((s) => s.boards[boardId])
  const scoped = useSyncStatus((s) => (scope ? s.boards[scope] : undefined))
  const relayOwn = useRelayStatus((s) => s.boards[boardId])
  const relayScoped = useRelayStatus((s) => (scope ? s.boards[scope] : undefined))
  const p2pEnabled = useNetworkSettings((s) => s.p2pEnabled !== false)
  if (boardId === HOME_BOARD_ID) return null
  // The sync engine may know a board is shared (meta.shared from a peer) before the library does.
  const view = describeSync(online, problem, own ? boardId : scope, own ?? scoped, relayOwn ?? relayScoped, p2pEnabled)
  const Icon =
    view.kind === 'offline' ? WifiOff : view.kind === 'problem' ? TriangleAlert : view.kind === 'private' ? Lock : view.kind === 'relay' ? Cloud : view.kind === 'off' ? CloudOff : null
  return (
    <button
      type="button"
      className={`sync-pill sync-pill--${view.kind}`}
      title={view.detail}
      aria-label={`${view.label}. ${view.detail}`}
      onClick={() => onClick(view.action)}
    >
      {Icon ? <Icon size={13} aria-hidden /> : <span className="sync-pill__dot" aria-hidden />}
      <span className="sync-pill__label">{view.label}</span>
    </button>
  )
}
