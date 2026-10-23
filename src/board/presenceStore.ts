/**
 * Teammates' presence as it concerns individual cards: who has a card selected or is editing it
 * (the coloured outline) and live drag/resize previews. One awareness listener per board derives
 * this once per change; each card subscribes to its own entry only, so pointer movement (ours or a
 * teammate's) and changes to other cards never re-render a card.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import { sanitizePresence } from '../collab/presence'

export interface CardOutline {
  name: string
  color: string
  editing: boolean
}

export interface CardDragPreview {
  dx: number
  dy: number
  w?: number
  h?: number
}

export interface CardPresence {
  /** First teammate (in awareness order) who edits or has selected the card. */
  outline: CardOutline | null
  /** A teammate's live drag/resize preview of the card (the last one wins). */
  drag: CardDragPreview | null
}

export const NO_PRESENCE: CardPresence = Object.freeze({ outline: null, drag: null }) as CardPresence

function presenceKey(p: CardPresence): string {
  const o = p.outline
  const d = p.drag
  return `${o ? `${o.color}|${o.name}|${o.editing ? 1 : 0}` : ''}#${d ? `${d.dx},${d.dy},${d.w ?? ''},${d.h ?? ''}` : ''}`
}

/** Pure: per-card presence derived from awareness states (excluding `self`). */
export function computeCardPresence(states: ReadonlyMap<number, unknown>, self: number): Map<string, CardPresence> {
  const out = new Map<string, CardPresence>()
  const entry = (id: string) => {
    let e = out.get(id)
    if (!e) out.set(id, (e = { outline: null, drag: null }))
    return e
  }
  states.forEach((raw, clientId) => {
    if (clientId === self) return
    const s = sanitizePresence(raw)
    if (!s) return
    const outline = (editing: boolean): CardOutline => ({ name: s.user.name, color: s.user.color, editing })
    if (s.editing) {
      const e = entry(s.editing)
      if (!e.outline) e.outline = outline(true)
    }
    for (const id of s.selection) {
      if (id === s.editing) continue
      const e = entry(id)
      if (!e.outline) e.outline = outline(false)
    }
    if (s.drag) {
      const { dx, dy, w, h } = s.drag
      const preview: CardDragPreview = { dx, dy }
      if (w !== undefined) preview.w = w
      if (h !== undefined) preview.h = h
      for (const id of s.drag.ids) entry(id).drag = preview
    }
  })
  return out
}

/** Board-level store: one awareness listener while anyone subscribes, per-card listeners. */
export class CardPresenceStore {
  private entries = new Map<string, { key: string; value: CardPresence }>()
  private listeners = new Map<string, Set<() => void>>()
  private count = 0
  private readonly awareness: Awareness

  constructor(awareness: Awareness) {
    this.awareness = awareness
  }

  private onChange = (_changes: unknown, origin: unknown) => {
    // Our own state (pointer, selection, drag) never changes what teammates show on cards.
    if (origin === 'local') return
    this.recompute()
  }

  /** Recomputes from the awareness states and notifies only the cards whose presence changed. */
  recompute() {
    const next = computeCardPresence(this.awareness.getStates(), this.awareness.clientID)
    const changed: string[] = []
    for (const [id, value] of next) {
      const key = presenceKey(value)
      if (this.entries.get(id)?.key === key) continue
      this.entries.set(id, { key, value })
      changed.push(id)
    }
    for (const id of this.entries.keys()) {
      if (next.has(id)) continue
      this.entries.delete(id)
      changed.push(id)
    }
    for (const id of changed) this.listeners.get(id)?.forEach((l) => l())
  }

  get(id: string): CardPresence {
    return this.entries.get(id)?.value ?? NO_PRESENCE
  }

  subscribe(id: string, cb: () => void): () => void {
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(cb)
    if (this.count++ === 0) {
      this.awareness.on('change', this.onChange)
      // States may have changed while nobody was listening.
      this.recompute()
    }
    return () => {
      const s = this.listeners.get(id)
      s?.delete(cb)
      if (s && !s.size) this.listeners.delete(id)
      if (--this.count === 0) this.awareness.off('change', this.onChange)
    }
  }
}

const stores = new WeakMap<Awareness, CardPresenceStore>()

export function cardPresenceStore(awareness: Awareness): CardPresenceStore {
  let s = stores.get(awareness)
  if (!s) stores.set(awareness, (s = new CardPresenceStore(awareness)))
  return s
}

/** Teammates' outline and drag preview for one card; re-renders only when that changes. */
export function useCardPresence(awareness: Awareness, id: string): CardPresence {
  const store = cardPresenceStore(awareness)
  const sub = useMemo(() => (cb: () => void) => store.subscribe(id, cb), [store, id])
  const get = useMemo(() => () => store.get(id), [store, id])
  return useSyncExternalStore(sub, get)
}
