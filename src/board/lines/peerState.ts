/**
 * The parts of teammates' presence that lines care about: live drag/resize previews (so lines follow
 * cards while someone drags them) and which lines they have selected. Only notifies React when these
 * change, so pointer movement of peers never re-renders the lines layer.
 */
import { useMemo, useSyncExternalStore } from 'react'
import type { Awareness } from 'y-protocols/awareness'
import type { CardIndex } from '../cardIndex'
import type { CardOffset, OffsetMap } from './resolve'

export interface PeerLineState {
  drags: OffsetMap
  /** Line id -> color of a teammate who has it selected. */
  selectedBy: ReadonlyMap<string, string>
}

const MAX_IDS = 5000
const LIMIT = 1e6
const EMPTY: PeerLineState = { drags: new Map(), selectedBy: new Map() }

const num = (v: unknown, lim = LIMIT): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= lim ? v : undefined

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

export function safeColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v) ? v : null
}

/** Sanitised drag preview from untrusted presence data, or null. */
export function parseDragPreview(v: unknown): { ids: string[]; offset: CardOffset } | null {
  if (!v || typeof v !== 'object') return null
  const d = v as Record<string, unknown>
  if (!Array.isArray(d.ids)) return null
  const dx = num(d.dx) ?? 0
  const dy = num(d.dy) ?? 0
  const w = num(d.w, 1e5)
  const h = num(d.h, 1e5)
  const offset: CardOffset = { dx, dy }
  if (w !== undefined && w > 0) offset.w = w
  if (h !== undefined && h > 0) offset.h = h
  const ids = d.ids.slice(0, MAX_IDS).filter(isId)
  return ids.length ? { ids, offset } : null
}

/** Pure: extracts drags and line selections from awareness states (excluding `self`). */
export function computePeerLineState(
  states: Map<number, unknown>,
  self: number,
  isLine: (id: string) => boolean,
): { state: PeerLineState; key: string } {
  const drags = new Map<string, CardOffset>()
  const selectedBy = new Map<string, string>()
  const parts: string[] = []
  states.forEach((raw, clientId) => {
    if (clientId === self || !raw || typeof raw !== 'object') return
    const s = raw as Record<string, unknown>
    const drag = parseDragPreview(s.drag)
    if (drag) {
      for (const id of drag.ids) drags.set(id, drag.offset)
      const o = drag.offset
      parts.push(`d${clientId}:${drag.ids.join(',')}:${o.dx},${o.dy},${o.w ?? ''},${o.h ?? ''}`)
    }
    const user = s.user as Record<string, unknown> | undefined
    const color = safeColor(user?.color) ?? 'var(--select)'
    if (Array.isArray(s.selection)) {
      const lines = s.selection.slice(0, MAX_IDS).filter((id): id is string => isId(id) && isLine(id))
      for (const id of lines) if (!selectedBy.has(id)) selectedBy.set(id, color)
      if (lines.length) parts.push(`s${clientId}:${color}:${lines.join(',')}`)
    }
  })
  if (!parts.length) return { state: EMPTY, key: '' }
  return { state: { drags, selectedBy }, key: parts.join('|') }
}

export function usePeerLineState(awareness: Awareness, index: CardIndex): PeerLineState {
  const store = useMemo(() => {
    const isLine = (id: string) => index.get(id)?.type === 'line'
    let current = computePeerLineState(awareness.getStates(), awareness.clientID, isLine)
    return {
      subscribe: (cb: () => void) => {
        const h = () => {
          const next = computePeerLineState(awareness.getStates(), awareness.clientID, isLine)
          if (next.key === current.key) return
          current = next
          cb()
        }
        awareness.on('change', h)
        return () => awareness.off('change', h)
      },
      get: () => current.state,
    }
  }, [awareness, index])
  return useSyncExternalStore(store.subscribe, store.get)
}
