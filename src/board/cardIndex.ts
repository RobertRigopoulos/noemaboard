/**
 * Reactive, shallow index of all cards on a board (position, size, type, parent, z).
 * Rich-text edits inside cards do not invalidate it, so typing never re-renders the canvas.
 */
import * as Y from 'yjs'
import { getCards, isTrashed, readCard } from '../model/board'
import type { Card, CardMap } from '../model/types'

export interface IndexedCard {
  id: string
  type: Card['type']
  x: number
  y: number
  w: number
  h: number | undefined
  z: number
  parent: string | null
  order: string
  /** Parked in the board's Unsorted drawer: not on the canvas (card.unsorted === true). */
  unsorted: boolean
  card: Card
}

export class CardIndex {
  private map = new Map<string, IndexedCard>()
  private listeners = new Set<() => void>()
  private snapshot: IndexedCard[] = []
  private dirty = true
  private cards: Y.Map<CardMap>
  private readonly doc: Y.Doc

  constructor(doc: Y.Doc) {
    this.doc = doc
    this.cards = getCards(doc)
    this.cards.forEach((m, id) => {
      if (m instanceof Y.Map && !isTrashed(m)) this.map.set(id, toIndexed(id, m))
    })
    this.cards.observeDeep(this.onChange)
  }

  private onChange = (events: Y.YEvent<any>[]) => {
    let changed = false
    for (const ev of events) {
      if (ev.target === this.cards) {
        for (const [key, change] of (ev as Y.YMapEvent<CardMap>).changes.keys) {
          const m = change.action === 'delete' ? undefined : this.cards.get(key)
          if (m instanceof Y.Map && !isTrashed(m)) this.map.set(key, toIndexed(key, m))
          else this.map.delete(key)
          changed = true
        }
      } else if (ev.target instanceof Y.Map && ev.target.parent === this.cards) {
        // Direct field change on a card (not inside its rich text).
        const m = ev.target as CardMap
        const id = m.get('id')
        if (typeof id === 'string' && this.cards.get(id) === m) {
          if (isTrashed(m)) this.map.delete(id)
          else this.map.set(id, toIndexed(id, m))
          changed = true
        }
      }
    }
    if (changed) {
      this.dirty = true
      this.listeners.forEach((l) => l())
    }
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => {
      this.listeners.delete(l)
    }
  }

  getSnapshot = (): IndexedCard[] => {
    if (this.dirty) {
      this.snapshot = Array.from(this.map.values()).sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
      this.dirty = false
    }
    return this.snapshot
  }

  get(id: string): IndexedCard | undefined {
    return this.map.get(id)
  }

  destroy() {
    this.cards.unobserveDeep(this.onChange)
    this.listeners.clear()
  }

  get ydoc() {
    return this.doc
  }
}

function toIndexed(id: string, m: CardMap): IndexedCard {
  const card = readCard(m)
  return {
    id,
    type: card.type,
    x: card.x,
    y: card.y,
    w: card.w,
    h: card.h,
    z: card.z,
    parent: card.parent,
    order: card.order,
    unsorted: card.unsorted === true,
    card,
  }
}
