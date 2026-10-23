/**
 * The local "keyring": every board this app instance knows about, with its capability secret.
 * Learned from board cards in loaded docs and from invite links. Persisted in localStorage.
 *
 * Several tabs of one profile share the same storage, so the keyring is never written as a stale
 * snapshot: every save re-reads what other tabs stored and merges entry by entry (removals are
 * remembered as tombstones), and changes stored by other tabs are merged in the same way.
 */
import { create } from 'zustand'
import { loadJSON, saveJSON, storageKey } from './profile'
import { reportLibrarySave } from './storageHealth'

/**
 * Where a board's secret came from:
 *  - 'created': made on this device (new board, backup import, other explicit local actions)
 *  - 'invite':  an invite link the user opened
 *  - 'card':    a board card in some board doc. Cards come from peers, so such a secret is
 *               provisional: it never replaces a secret we know, and it may never be the secret of
 *               another board (that would merge two boards' rooms).
 * Entries saved by older versions have no source and are treated as trusted.
 */
export type SecretSource = 'created' | 'invite' | 'card'

export interface LibraryEntry {
  id: string
  secret: string
  title: string
  icon: string | null
  color: string | null
  /** Board whose card links to this board ('home' for top-level boards). */
  parentId: string | null
  /** Keep this board's peer-to-peer room open (it has been shared with others). */
  shared: boolean
  /** Optional relay server for this board. */
  relay: string | null
  lastOpened: number
  /** Where `secret` came from (missing on entries saved by older versions: trusted). */
  secretFrom?: SecretSource
  /** Last change of this entry (ms epoch), used to merge copies written by several tabs. */
  updatedAt?: number
}

export type LibraryPatch = Partial<LibraryEntry> & { id: string }

interface LibraryState {
  entries: Record<string, LibraryEntry>
  /**
   * Adds or updates an entry. A `secret` without `secretFrom` counts as 'created' (an explicit
   * local action). See SecretSource for when a secret may replace a known one.
   */
  upsert: (e: LibraryPatch) => void
  remove: (id: string) => void
  removeMany: (ids: readonly string[]) => void
  touch: (id: string) => void
}

const STORE_KEY = 'library'
const REMOVED_KEY = 'library-removed'
const SAVE_DELAY_MS = 300
/** Tombstones only need to outlive stale copies in other open tabs. */
const TOMBSTONE_TTL_MS = 90 * 24 * 3600 * 1000

const RANK: Record<SecretSource, number> = { card: 1, invite: 2, created: 3 }

/** Trust of a secret source; legacy entries (no source) count as trusted. */
export const secretRank = (s: SecretSource | undefined): number => (s ? RANK[s] : 3)

/** The entry's secret was only learned from a board card (never confirmed by an invite or creation). */
export const isProvisionalSecret = (e: LibraryEntry | undefined): boolean => !!e?.secret && e.secretFrom === 'card'

// ---------------------------------------------------------------------------
// Pure helpers (unit tested)

/**
 * Which of two entries with the same secret really owns it: the more trusted source, else the
 * parent (a board nested in another can never legitimately carry its parent's secret), else the
 * one the user opened most recently, else the smaller id.
 */
function ownsSecretRatherThan(a: LibraryEntry, b: LibraryEntry): boolean {
  const ra = secretRank(a.secretFrom)
  const rb = secretRank(b.secretFrom)
  if (ra !== rb) return ra > rb
  if (b.parentId === a.id) return true
  if (a.parentId === b.id) return false
  if ((a.lastOpened || 0) !== (b.lastOpened || 0)) return (a.lastOpened || 0) > (b.lastOpened || 0)
  return a.id < b.id
}

const owners = new WeakMap<Record<string, LibraryEntry>, Map<string, LibraryEntry>>()

/** The board that holds `secret` (see ownsSecretRatherThan when several claim it). */
export function secretOwner(entries: Record<string, LibraryEntry>, secret: string): string | undefined {
  if (!secret) return undefined
  let map = owners.get(entries)
  if (!map) {
    const m = new Map<string, LibraryEntry>()
    for (const e of Object.values(entries)) {
      if (!e.secret) continue
      const cur = m.get(e.secret)
      if (!cur || ownsSecretRatherThan(e, cur)) m.set(e.secret, e)
    }
    owners.set(entries, m)
    map = m
  }
  return map.get(secret)?.id
}

/**
 * A secret belongs to exactly one board. Older versions could learn a board card that reused
 * another board's secret under a new id (which then stole that board's room): such copies lose
 * the secret and their shared flag. Returns the same object when nothing had to change.
 */
export function dedupeSecrets(entries: Record<string, LibraryEntry>): Record<string, LibraryEntry> {
  let out = entries
  for (const e of Object.values(entries)) {
    if (!e.secret || secretOwner(entries, e.secret) === e.id) continue
    if (out === entries) out = { ...entries }
    const copy: LibraryEntry = { ...e, secret: '', shared: false }
    delete copy.secretFrom
    out[e.id] = copy
  }
  return out
}

function pickSecret(
  entries: Record<string, LibraryEntry>,
  prev: LibraryEntry | undefined,
  e: LibraryPatch,
): { secret: string; from: SecretSource | undefined } {
  const keep = { secret: prev?.secret ?? '', from: prev?.secret ? prev.secretFrom : undefined }
  const incoming = typeof e.secret === 'string' ? e.secret : ''
  // A secret, once known, is never replaced by an empty one.
  if (!incoming) return keep
  const from: SecretSource = e.secretFrom ?? 'created'
  if (prev?.secret === incoming) return { secret: incoming, from: secretRank(from) > secretRank(prev.secretFrom) ? from : prev.secretFrom }
  // Cards and invites from other people may not reuse another board's secret.
  if (from !== 'created') {
    const owner = secretOwner(entries, incoming)
    if (owner !== undefined && owner !== e.id) return keep
  }
  if (!prev?.secret) return { secret: incoming, from }
  // A different secret for a board we know: only an explicit local action, or an invite replacing
  // a secret that was merely learned from a card, may change it. A card never does.
  if (from === 'created' || (from === 'invite' && prev.secretFrom === 'card')) return { secret: incoming, from }
  return keep
}

const FIELDS = ['id', 'secret', 'title', 'icon', 'color', 'parentId', 'shared', 'relay', 'lastOpened', 'secretFrom'] as const

/** Same content, ignoring the change time. */
export function sameEntry(a: LibraryEntry, b: LibraryEntry): boolean {
  for (const k of FIELDS) if ((a[k] ?? null) !== (b[k] ?? null)) return false
  return true
}

/** Merges two copies of one entry (written by two tabs). */
export function mergeEntry(a: LibraryEntry, b: LibraryEntry): LibraryEntry {
  if (sameEntry(a, b)) return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
  const newer = (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
  const out: LibraryEntry = { ...newer }
  if (a.secret === b.secret) {
    out.secretFrom = secretRank(b.secretFrom) > secretRank(a.secretFrom) ? b.secretFrom : a.secretFrom
  } else if (!a.secret || !b.secret) {
    const s = a.secret ? a : b
    out.secret = s.secret
    out.secretFrom = s.secretFrom
  } else {
    const ra = secretRank(a.secretFrom)
    const rb = secretRank(b.secretFrom)
    const w = ra !== rb ? (ra > rb ? a : b) : newer
    out.secret = w.secret
    out.secretFrom = w.secretFrom
  }
  if (!out.secretFrom) delete out.secretFrom
  // Sharing is only ever switched on (leaving removes the whole entry).
  out.shared = !!(a.shared || b.shared)
  out.lastOpened = Math.max(a.lastOpened || 0, b.lastOpened || 0)
  out.updatedAt = Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0)
  return out
}

export interface LibrarySnapshot {
  entries: Record<string, LibraryEntry>
  /** Board id -> time it was removed. */
  removed: Record<string, number>
}

/**
 * Merges this tab's keyring with the one in storage: entry by entry, and an entry removed after
 * its last change stays removed (a stale copy in another tab cannot bring it back).
 */
export function mergeLibraries(mine: LibrarySnapshot, theirs: LibrarySnapshot, now = Date.now()): LibrarySnapshot {
  const removed: Record<string, number> = {}
  for (const src of [mine.removed, theirs.removed]) {
    for (const [id, t] of Object.entries(src)) {
      if (typeof t !== 'number' || !Number.isFinite(t) || now - t > TOMBSTONE_TTL_MS) continue
      if (!(removed[id] >= t)) removed[id] = t
    }
  }
  const entries: Record<string, LibraryEntry> = {}
  const ids = new Set([...Object.keys(mine.entries), ...Object.keys(theirs.entries)])
  for (const id of ids) {
    const a = mine.entries[id]
    const b = theirs.entries[id]
    const e = a && b ? mergeEntry(a, b) : (a ?? b)
    const r = removed[id]
    if (r !== undefined && (e.updatedAt ?? 0) <= r) continue
    entries[id] = e
  }
  // A tombstone older than a surviving entry is obsolete.
  for (const id of Object.keys(removed)) if (entries[id]) delete removed[id]
  return { entries: dedupeSecrets(entries), removed }
}

const str = (v: unknown, d: string) => (typeof v === 'string' ? v : d)
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null)
const SOURCES = new Set<unknown>(['created', 'invite', 'card'])

/** Entries read from storage are checked field by field (storage can be stale or damaged). */
export function sanitizeEntries(raw: unknown): Record<string, LibraryEntry> {
  const out: Record<string, LibraryEntry> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || !id) continue
    const o = v as Record<string, unknown>
    const e: LibraryEntry = {
      id,
      secret: str(o.secret, ''),
      title: str(o.title, 'Untitled board'),
      icon: strOrNull(o.icon),
      color: strOrNull(o.color),
      parentId: strOrNull(o.parentId),
      shared: o.shared === true,
      relay: strOrNull(o.relay),
      lastOpened: typeof o.lastOpened === 'number' && Number.isFinite(o.lastOpened) ? o.lastOpened : 0,
    }
    if (SOURCES.has(o.secretFrom)) e.secretFrom = o.secretFrom as SecretSource
    if (typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt)) e.updatedAt = o.updatedAt
    out[id] = e
  }
  return out
}

function sanitizeRemoved(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [id, t] of Object.entries(raw as Record<string, unknown>)) if (typeof t === 'number' && Number.isFinite(t)) out[id] = t
  return out
}

function sameLibrary(a: Record<string, LibraryEntry>, b: Record<string, LibraryEntry>): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!b[k] || !sameEntry(a[k], b[k])) return false
  return true
}

// ---------------------------------------------------------------------------
// Store

const readDisk = (): LibrarySnapshot => ({
  entries: dedupeSecrets(sanitizeEntries(loadJSON<unknown>(STORE_KEY, {}))),
  removed: sanitizeRemoved(loadJSON<unknown>(REMOVED_KEY, {})),
})

let removed: Record<string, number> = readDisk().removed
let saveTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSave() {
  // Not restarted on every change: a steady stream of changes must not postpone saving forever.
  if (saveTimer) return
  saveTimer = setTimeout(flushLibrary, SAVE_DELAY_MS)
}

/** Adopts merged entries when they differ from the current state. */
function adopt(entries: Record<string, LibraryEntry>) {
  const cur = useLibrary.getState().entries
  if (!sameLibrary(cur, entries)) useLibrary.setState({ entries })
}

/** Writes the keyring now, merged with what other tabs stored. */
export function flushLibrary() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const merged = mergeLibraries({ entries: useLibrary.getState().entries, removed }, readDisk())
  removed = merged.removed
  adopt(merged.entries)
  const ok = saveJSON(REMOVED_KEY, merged.removed) && saveJSON(STORE_KEY, merged.entries)
  // Only a browser has storage to fail (tests and workers have none).
  if (typeof window !== 'undefined') reportLibrarySave(ok)
}

export const useLibrary = create<LibraryState>((set, get) => ({
  entries: readDisk().entries,
  upsert: (e) => {
    const entries = get().entries
    const prev = entries[e.id]
    const { secret, from } = pickSecret(entries, prev, e)
    const next: LibraryEntry = {
      id: e.id,
      secret,
      title: e.title ?? prev?.title ?? 'Untitled board',
      icon: e.icon !== undefined ? e.icon : (prev?.icon ?? null),
      color: e.color !== undefined ? e.color : (prev?.color ?? null),
      parentId: e.parentId !== undefined ? e.parentId : (prev?.parentId ?? null),
      shared: e.shared ?? prev?.shared ?? false,
      relay: e.relay !== undefined ? e.relay : (prev?.relay ?? null),
      lastOpened: e.lastOpened ?? prev?.lastOpened ?? 0,
    }
    if (secret && from) next.secretFrom = from
    if (prev && sameEntry(prev, next)) return
    // Strictly after a removal of the same id, so a re-added board survives the merge.
    next.updatedAt = Math.max(Date.now(), (prev?.updatedAt ?? 0) + 1, (removed[e.id] ?? 0) + 1)
    if (removed[e.id] !== undefined) {
      removed = { ...removed }
      delete removed[e.id]
    }
    set({ entries: { ...entries, [e.id]: next } })
    scheduleSave()
  },
  remove: (id) => get().removeMany([id]),
  removeMany: (ids) => {
    const cur = get().entries
    const entries = { ...cur }
    const now = Date.now()
    removed = { ...removed }
    for (const id of ids) {
      removed[id] = Math.max(now, (cur[id]?.updatedAt ?? 0) + 1)
      delete entries[id]
    }
    set({ entries })
    scheduleSave()
  },
  touch: (id) => {
    const prev = get().entries[id]
    if (!prev) return
    // lastOpened merges as a maximum, so it does not count as a change of the other fields.
    set({ entries: { ...get().entries, [id]: { ...prev, lastOpened: Date.now() } } })
    scheduleSave()
  },
}))

// Another tab of the same profile joined/shared/left a board: merge it in without a reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== null && e.key !== storageKey(STORE_KEY) && e.key !== storageKey(REMOVED_KEY)) return
    try {
      const disk = readDisk()
      const merged = mergeLibraries({ entries: useLibrary.getState().entries, removed }, disk)
      removed = merged.removed
      adopt(merged.entries)
      // We hold changes the other tab has not seen: write them (re-merging at that time).
      if (!sameLibrary(merged.entries, disk.entries)) scheduleSave()
    } catch {
      // ignore malformed data
    }
  })
}

export const getLibraryEntry = (id: string): LibraryEntry | undefined => useLibrary.getState().entries[id]
