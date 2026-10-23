/**
 * Live relay connection status per board, for the UI (share dialog, sync indicator).
 * Boards without a relay have no entry.
 */
import { create } from 'zustand'

export type RelayConnectionState = 'connecting' | 'connected' | 'offline' | 'error'

export interface BoardRelayStatus {
  /** Relay address as shown to people (without the access key). */
  url: string
  state: RelayConnectionState
  /** Human-readable detail, e.g. why the relay rejected us. */
  message?: string
  /** Other devices currently connected to this board through the relay. */
  peers?: number
  /** Last time data was exchanged with the relay (ms epoch). */
  lastSyncAt?: number
  /** Local changes not yet confirmed by the relay. */
  pending?: number
}

export interface RelayStatusState {
  boards: Record<string, BoardRelayStatus>
}

export const useRelayStatus = create<RelayStatusState>(() => ({ boards: {} }))

export function setRelayStatus(boardId: string, status: BoardRelayStatus | null) {
  const prev = useRelayStatus.getState().boards[boardId]
  if (status === null) {
    if (!prev) return
    const boards = { ...useRelayStatus.getState().boards }
    delete boards[boardId]
    useRelayStatus.setState({ boards })
    return
  }
  if (
    prev &&
    prev.url === status.url &&
    prev.state === status.state &&
    prev.message === status.message &&
    prev.peers === status.peers &&
    prev.lastSyncAt === status.lastSyncAt &&
    prev.pending === status.pending
  ) {
    return
  }
  useRelayStatus.setState({ boards: { ...useRelayStatus.getState().boards, [boardId]: status } })
}

export function useBoardRelayStatus(boardId: string): BoardRelayStatus | undefined {
  return useRelayStatus((s) => s.boards[boardId])
}
