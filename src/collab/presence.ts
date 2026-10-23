/**
 * One y-protocols Awareness per open board. Sync providers forward awareness updates;
 * the UI publishes pointer, selection, editing card and drag previews through it.
 */
import type * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import type { PresenceState } from '../model/types'

interface Entry {
  awareness: Awareness
  refs: number
}

const entries = new Map<string, Entry>()
const createdListeners = new Set<(boardId: string, a: Awareness) => void>()
const destroyedListeners = new Set<(boardId: string, a: Awareness) => void>()

export function acquireAwareness(boardId: string, doc: Y.Doc): { awareness: Awareness; release: () => void } {
  let e = entries.get(boardId)
  if (!e || e.awareness.doc !== doc) {
    if (e) destroy(boardId, e)
    e = { awareness: new Awareness(doc), refs: 0 }
    entries.set(boardId, e)
    const a = e.awareness
    createdListeners.forEach((l) => l(boardId, a))
  }
  e.refs++
  const entry = e
  let released = false
  return {
    awareness: e.awareness,
    release: () => {
      if (released) return
      released = true
      entry.refs--
      if (entry.refs <= 0 && entries.get(boardId) === entry) destroy(boardId, entry)
    },
  }
}

function destroy(boardId: string, e: Entry) {
  entries.delete(boardId)
  destroyedListeners.forEach((l) => l(boardId, e.awareness))
  e.awareness.setLocalState(null)
  e.awareness.destroy()
}

export function peekAwareness(boardId: string): Awareness | undefined {
  return entries.get(boardId)?.awareness
}

export function onAwarenessCreated(l: (boardId: string, a: Awareness) => void): () => void {
  createdListeners.add(l)
  for (const [id, e] of entries) l(id, e.awareness)
  return () => createdListeners.delete(l)
}

export function onAwarenessDestroyed(l: (boardId: string, a: Awareness) => void): () => void {
  destroyedListeners.add(l)
  return () => destroyedListeners.delete(l)
}

/** Remote drag/resize preview broadcast while a peer is dragging (committed to the doc on drop). */
export interface DragPreview {
  ids: string[]
  dx: number
  dy: number
  /** Optional width/height override during resize of a single card. */
  w?: number
  h?: number
}

export type FullPresence = PresenceState & { drag?: DragPreview | null }

export function setLocalPresence(a: Awareness, patch: Partial<FullPresence>) {
  const cur = (a.getLocalState() ?? {}) as Partial<FullPresence>
  a.setLocalState({ ...cur, ...patch })
}

const HEX = /^#[0-9a-f]{6}$/i
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const idList = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 64).slice(0, max) : []

/**
 * Validates a remote awareness state. Peers can send anything; the UI only ever sees well-formed
 * presence (bounded strings, finite numbers, known shapes).
 */
export function sanitizePresence(raw: unknown): FullPresence | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  const u = s.user as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object' || typeof u.name !== 'string') return null
  const user = {
    id: typeof u.id === 'string' ? u.id.slice(0, 64) : '',
    name: u.name.trim().slice(0, 40),
    color: typeof u.color === 'string' && HEX.test(u.color) ? u.color : '#8b8d98',
  }
  const p = s.pointer as Record<string, unknown> | null | undefined
  const pointer = p && finite(p.x) && finite(p.y) && Math.abs(p.x) < 1e7 && Math.abs(p.y) < 1e7 ? { x: p.x, y: p.y } : null
  const d = s.drag as Record<string, unknown> | null | undefined
  let drag: DragPreview | null = null
  if (d && typeof d === 'object' && finite(d.dx) && finite(d.dy) && Math.abs(d.dx) < 1e6 && Math.abs(d.dy) < 1e6) {
    drag = { ids: idList(d.ids, 500), dx: d.dx, dy: d.dy }
    if (finite(d.w) && d.w > 0 && d.w < 1e5) drag.w = d.w
    if (finite(d.h) && d.h > 0 && d.h < 1e5) drag.h = d.h
  }
  return {
    user,
    pointer,
    selection: idList(s.selection, 500),
    editing: typeof s.editing === 'string' && s.editing.length <= 64 ? s.editing : null,
    drag,
    cursor: s.cursor,
  }
}
