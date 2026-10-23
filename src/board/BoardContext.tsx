import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'
import * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import { getCards, readCard } from '../model/board'
import type { Card, CardMap } from '../model/types'
import type { CardIndex, IndexedCard } from './cardIndex'
import { sanitizePresence, type FullPresence } from '../collab/presence'

export interface BoardContextValue {
  boardId: string
  doc: Y.Doc
  cards: Y.Map<CardMap>
  index: CardIndex
  awareness: Awareness
  undo: Y.UndoManager
  readOnly: boolean
  isHome: boolean
}

export const BoardContext = createContext<BoardContextValue | null>(null)

export function useBoard(): BoardContextValue {
  const ctx = useContext(BoardContext)
  if (!ctx) throw new Error('useBoard outside BoardContext')
  return ctx
}

/** All cards (shallow), sorted by z. Re-renders when any card's primitive fields change. */
export function useCardIndex(): IndexedCard[] {
  const { index } = useBoard()
  return useSyncExternalStore(index.subscribe, index.getSnapshot)
}

export function useCardMap(id: string): CardMap | undefined {
  const { cards } = useBoard()
  const sub = useMemo(
    () => (cb: () => void) => {
      cards.observe(cb)
      return () => cards.unobserve(cb)
    },
    [cards],
  )
  // Peers can write anything under a card id: only real maps are cards.
  return useSyncExternalStore(sub, () => {
    const m: unknown = cards.get(id)
    return m instanceof Y.Map ? (m as CardMap) : undefined
  })
}

/** Same primitive fields with the same values (nested objects such as line ends compared by value). */
export function sameCardSnapshot(a: Card, b: Card): boolean {
  const ra = a as unknown as Record<string, unknown>
  const rb = b as unknown as Record<string, unknown>
  const ka = Object.keys(ra)
  if (ka.length !== Object.keys(rb).length) return false
  for (const k of ka) {
    const va = ra[k]
    const vb = rb[k]
    if (va === vb) continue
    if (typeof va !== 'object' || typeof vb !== 'object' || va === null || vb === null) return false
    if (JSON.stringify(va) !== JSON.stringify(vb)) return false
  }
  return true
}

/** Plain snapshot of one card's primitive fields; re-renders only when that card changes. */
export function useCard(id: string): Card | undefined {
  const map = useCardMap(id)
  const store = useMemo(() => {
    let snap: Card | undefined = map ? readCard(map) : undefined
    return {
      subscribe: (cb: () => void) => {
        if (!map) return () => {}
        const h = () => {
          snap = readCard(map)
          cb()
        }
        map.observe(h)
        // The card may have changed between render and subscribing (e.g. a peer's update arrived).
        const fresh = readCard(map)
        if (!snap || !sameCardSnapshot(snap, fresh)) {
          snap = fresh
          cb()
        }
        return () => map.unobserve(h)
      },
      get: () => snap,
    }
  }, [map])
  return useSyncExternalStore(store.subscribe, store.get)
}

/** Subscribes to a nested Y type (Y.Array / Y.XmlFragment) and returns a version number that bumps on change. */
export function useYVersion(type: Y.AbstractType<any> | null | undefined): number {
  const store = useMemo(() => {
    let v = 0
    return {
      subscribe: (cb: () => void) => {
        if (!type) return () => {}
        const h = () => {
          v++
          cb()
        }
        type.observeDeep(h)
        return () => type.unobserveDeep(h)
      },
      get: () => v,
    }
  }, [type])
  return useSyncExternalStore(store.subscribe, store.get)
}

/**
 * Remote presence states on this board (excluding ourselves). Re-renders on every remote presence
 * change (including pointer moves): cards use the per-card store in presenceStore.ts instead.
 */
export function usePeers(): { clientId: number; state: FullPresence }[] {
  const { awareness } = useBoard()
  const store = useMemo(() => {
    const compute = () => {
      const out: { clientId: number; state: FullPresence }[] = []
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return
        const clean = sanitizePresence(state)
        if (clean) out.push({ clientId, state: clean })
      })
      return out
    }
    let snap = compute()
    return {
      subscribe: (cb: () => void) => {
        const h = (_changes: unknown, origin: unknown) => {
          // Our own state is excluded from the result: local updates (pointer moves...) change nothing.
          if (origin === 'local') return
          snap = compute()
          cb()
        }
        awareness.on('change', h)
        // States may have changed between render and subscribing.
        const fresh = compute()
        if (!samePeers(fresh, snap)) {
          snap = fresh
          cb()
        }
        return () => awareness.off('change', h)
      },
      get: () => snap,
    }
  }, [awareness])
  return useSyncExternalStore(store.subscribe, store.get)
}

function samePeers(a: { clientId: number; state: FullPresence }[], b: { clientId: number; state: FullPresence }[]): boolean {
  if (a.length !== b.length) return false
  return a.every((p, i) => p.clientId === b[i].clientId && p.state.cursor === b[i].state.cursor && JSON.stringify({ ...p.state, cursor: null }) === JSON.stringify({ ...b[i].state, cursor: null }))
}

export { getCards }
