/**
 * Small per-board relay bookkeeping persisted in localStorage (via profile.ts):
 *  - lastSeq / snapSeq: where we are in the relay's log, so reconnects only fetch the tail,
 *  - sv: state vector the relay is known to cover, for the reconnect "reconcile" push,
 *  - dirty: local changes may not have reached the relay yet (survives crashes and reloads),
 *  - uploaded: files already confirmed on the relay.
 * Keyed by board id and tied to the relay address; a different address starts from scratch.
 */
import { loadJSON, saveJSON, storageKey } from '../profile'

export interface RelayBoardState {
  /** Relay identity (ws base URL); state for another relay is discarded. */
  relay: string
  lastSeq: number
  snapSeq: number
  /** base64 Yjs state vector covered by the relay at the last clean point ('' = unknown). */
  sv: string
  dirty: boolean
}

export interface RelayStateStore {
  load(boardId: string, relay: string): RelayBoardState
  save(boardId: string, state: RelayBoardState): void
  clear(boardId: string): void
  loadUploaded(boardId: string, relay: string): Set<string>
  saveUploaded(boardId: string, relay: string, hashes: Set<string>): void
}

const MAX_UPLOADED = 5000

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export function freshState(relay: string): RelayBoardState {
  return { relay, lastSeq: 0, snapSeq: 0, sv: '', dirty: false }
}

/** Validates whatever was stored (older versions, manual edits, other profiles). */
export function sanitizeState(raw: unknown, relay: string): RelayBoardState {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (o.relay !== relay) return freshState(relay)
  const lastSeq = isCount(o.lastSeq) ? o.lastSeq : 0
  return {
    relay,
    lastSeq,
    snapSeq: isCount(o.snapSeq) && o.snapSeq <= lastSeq ? o.snapSeq : 0,
    sv: typeof o.sv === 'string' && o.sv.length < 1_000_000 && /^[A-Za-z0-9+/=]*$/.test(o.sv) ? o.sv : '',
    dirty: o.dirty === true,
  }
}

export const localStateStore: RelayStateStore = {
  load: (boardId, relay) => sanitizeState(loadJSON<unknown>(`relay:${boardId}`, null), relay),
  save: (boardId, state) => saveJSON(`relay:${boardId}`, state),
  clear: (boardId) => {
    try {
      localStorage.removeItem(storageKey(`relay:${boardId}`))
      localStorage.removeItem(storageKey(`relay-blobs:${boardId}`))
    } catch {
      // storage unavailable
    }
  },
  loadUploaded: (boardId, relay) => {
    const raw = loadJSON<{ relay?: unknown; hashes?: unknown } | null>(`relay-blobs:${boardId}`, null)
    if (!raw || raw.relay !== relay || !Array.isArray(raw.hashes)) return new Set()
    return new Set(raw.hashes.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))
  },
  saveUploaded: (boardId, relay, hashes) => {
    const list = Array.from(hashes).slice(-MAX_UPLOADED)
    saveJSON(`relay-blobs:${boardId}`, { relay, hashes: list })
  },
}

/** In-memory store for tests and environments without localStorage. */
export function memoryStateStore(): RelayStateStore {
  const states = new Map<string, RelayBoardState>()
  const uploaded = new Map<string, { relay: string; hashes: Set<string> }>()
  return {
    load: (boardId, relay) => sanitizeState(states.get(boardId), relay),
    save: (boardId, state) => void states.set(boardId, { ...state }),
    clear: (boardId) => {
      states.delete(boardId)
      uploaded.delete(boardId)
    },
    loadUploaded: (boardId, relay) => {
      const u = uploaded.get(boardId)
      return u && u.relay === relay ? new Set(u.hashes) : new Set()
    },
    saveUploaded: (boardId, relay, hashes) => void uploaded.set(boardId, { relay, hashes: new Set(hashes) }),
  }
}

// base64 (standard) for state vectors; they are binary and only stored locally.
export function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
