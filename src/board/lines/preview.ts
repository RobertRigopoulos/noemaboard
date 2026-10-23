/**
 * Transient (uncommitted) line edits shown while the pointer is down: dragging an endpoint,
 * bending, or drawing a new line. Committed to the doc once, on release.
 */
import { create } from 'zustand'
import type { LineEnd } from '../../model/types'

export type EndName = 'from' | 'to'

export interface EndpointPreview {
  lineId: string
  end: EndName
  /** Where the end will land: attached to a card or a free point. */
  value: LineEnd
}

export interface BendPreview {
  lineId: string
  bend: number
}

/** A line being drawn with the connector handle or the line tool. */
export interface DraftLine {
  from: LineEnd
  to: LineEnd
}

interface PreviewState {
  endpoint: EndpointPreview | null
  bend: BendPreview | null
  draft: DraftLine | null
  /** Card highlighted as the attach target under the pointer. */
  target: string | null
  set: (patch: Partial<Omit<PreviewState, 'set' | 'reset'>>) => void
  reset: () => void
}

export const useLinePreview = create<PreviewState>((set) => ({
  endpoint: null,
  bend: null,
  draft: null,
  target: null,
  set: (patch) => set(patch),
  reset: () => set({ endpoint: null, bend: null, draft: null, target: null }),
}))
