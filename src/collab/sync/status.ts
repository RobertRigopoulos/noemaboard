/**
 * Live connection status for the UI (owned by the sync engine).
 */
import { create } from 'zustand'

export interface BoardSyncStatus {
  /** Number of other devices currently connected for this board (P2P + relay). */
  peers: number
  /** True while we are actively looking for / connected to peers for this board. */
  active: boolean
  /** Last time we exchanged data with someone about this board (ms epoch), 0 if never. */
  lastSyncAt: number
}

export interface SyncStatusState {
  /** Browser/OS reports a network connection. */
  online: boolean
  /** Status per board id. Boards that are not shared have no entry. */
  boards: Record<string, BoardSyncStatus>
  /** Human-readable problem to show in the UI (e.g. teammates cannot connect directly). */
  problem: string | null
}

export const useSyncStatus = create<SyncStatusState>(() => ({
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  boards: {},
  problem: null,
}))

export function useBoardSyncStatus(boardId: string): BoardSyncStatus | undefined {
  return useSyncStatus((s) => s.boards[boardId])
}

// ---------------------------------------------------------------------------
// Problems. Several can be active at once; the UI shows the most important one.

export type SyncProblemKey = 'version' | 'tab-version' | 'reload' | 'start' | 'webrtc' | 'signaling' | 'turn' | 'full'

/** Ordered by importance. */
export const SYNC_PROBLEMS: Record<SyncProblemKey, string> = {
  version: 'A teammate is using a different version of the app. Both of you should update.',
  'tab-version': 'The app was updated in another tab or window. Reload this one to keep them in sync.',
  reload: 'A new version of the app was published while this window was open. Reload the app to keep syncing.',
  start: "Live sync couldn't start. Your changes are saved on this device; reload the app to connect again.",
  webrtc: "This browser can't connect directly to teammates. Boards that use a sync service still sync through it; other shared boards don't sync here.",
  signaling: "Can't reach the servers that connect teammates directly. Check your internet connection. Boards that use a sync service still sync through it.",
  turn: "Some teammates can't connect directly. Add a TURN server in Settings → Network.",
  full: 'Too many people are connected to a shared board at once (limit 30). Some changes will arrive late.',
}

const PROBLEM_ORDER = Object.keys(SYNC_PROBLEMS) as SyncProblemKey[]

/** Receives status from the engine. Separate instances in tests; the store below in the app. */
export interface StatusSink {
  setBoards(boards: Record<string, BoardSyncStatus>): void
  setProblem(key: SyncProblemKey, active: boolean): void
}

function sameBoards(a: Record<string, BoardSyncStatus>, b: Record<string, BoardSyncStatus>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    const x = a[k]
    const y = b[k]
    if (!y || x.peers !== y.peers || x.active !== y.active || x.lastSyncAt !== y.lastSyncAt) return false
  }
  return true
}

/** Writes engine status into a zustand store shaped like useSyncStatus. */
export function createStoreSink(store: typeof useSyncStatus = useSyncStatus): StatusSink & {
  active: () => SyncProblemKey[]
} {
  const active = new Set<SyncProblemKey>()
  const publishProblem = () => {
    const key = PROBLEM_ORDER.find((k) => active.has(k))
    const problem = key ? SYNC_PROBLEMS[key] : null
    if (store.getState().problem !== problem) store.setState({ problem })
  }
  return {
    setBoards(boards) {
      if (!sameBoards(store.getState().boards, boards)) store.setState({ boards })
    },
    setProblem(key, on) {
      if (on === active.has(key)) return
      if (on) active.add(key)
      else active.delete(key)
      publishProblem()
    },
    active: () => PROBLEM_ORDER.filter((k) => active.has(k)),
  }
}

/** The app-wide sink (engine + network watchdogs in index.ts share it). */
export const statusSink = createStoreSink()
