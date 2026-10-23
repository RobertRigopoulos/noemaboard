/**
 * Local canvas preferences (grid dots, snapping, the Unsorted drawer). Stored per device, synced
 * across windows of the app through the 'storage' event; never written to a board doc.
 */
import { create } from 'zustand'
import { loadJSON, saveJSON, storageKey } from '../collab/profile'

export type GridSize = 10 | 20

export interface CanvasPrefs {
  /** Dot grid on the canvas background. */
  showGrid: boolean
  /** Card positions and sizes snap to gridSize when dropped. */
  snapToGrid: boolean
  gridSize: GridSize
  /** Cards moved into another board land in its Unsorted drawer instead of on its canvas. */
  unsortedOnMove: boolean
}

interface CanvasPrefsState extends CanvasPrefs {
  set: (patch: Partial<CanvasPrefs>) => void
}

const KEY = 'canvasPrefs'

export const DEFAULT_CANVAS_PREFS: Readonly<CanvasPrefs> = {
  showGrid: true,
  snapToGrid: true,
  gridSize: 20,
  unsortedOnMove: true,
}

/** Keeps only valid values from stored (or another window's) data; anything else comes from `base` (the defaults). */
export function cleanPrefs(raw: unknown, base: Readonly<CanvasPrefs> = DEFAULT_CANVAS_PREFS): CanvasPrefs {
  const out: CanvasPrefs = { ...base }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  const r = raw as Record<string, unknown>
  if (typeof r.showGrid === 'boolean') out.showGrid = r.showGrid
  if (typeof r.snapToGrid === 'boolean') out.snapToGrid = r.snapToGrid
  if (r.gridSize === 10 || r.gridSize === 20) out.gridSize = r.gridSize
  if (typeof r.unsortedOnMove === 'boolean') out.unsortedOnMove = r.unsortedOnMove
  return out
}

const pick = (s: CanvasPrefs): CanvasPrefs => ({
  showGrid: s.showGrid,
  snapToGrid: s.snapToGrid,
  gridSize: s.gridSize,
  unsortedOnMove: s.unsortedOnMove,
})

export const useCanvasPrefs = create<CanvasPrefsState>((set, get) => ({
  ...cleanPrefs(loadJSON<unknown>(KEY, null)),
  set: (patch) => {
    // An invalid value in the patch keeps the current one.
    const next = cleanPrefs(patch, pick(get()))
    set(next)
    saveJSON(KEY, next)
  },
}))

if (typeof window !== 'undefined') {
  // Another window of the app changed a preference.
  window.addEventListener('storage', (e) => {
    if (e.key !== storageKey(KEY)) return
    useCanvasPrefs.setState(cleanPrefs(loadJSON<unknown>(KEY, null)))
  })
}

/** Rounds a board coordinate to the snap grid (or to whole pixels when snapping is off or bypassed). */
export function snapValue(v: number, prefs: Pick<CanvasPrefs, 'snapToGrid' | 'gridSize'>, bypass = false): number {
  // "+ 0" turns -0 into 0, so snapped positions compare and serialise cleanly.
  if (bypass || !prefs.snapToGrid) return Math.round(v) + 0
  return Math.round(v / prefs.gridSize) * prefs.gridSize + 0
}

/** The one snap rule for cards, lines and resizes, using the current preferences. */
export function snap(v: number, bypass = false): number {
  return snapValue(v, useCanvasPrefs.getState(), bypass)
}
