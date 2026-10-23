/**
 * Local (non-synced) UI state for the open board: viewport, selection, editing, drag previews, tool.
 * Only one board is shown at a time, so these are global stores reset when the board changes.
 */
import { create } from 'zustand'
import { loadJSON, saveJSON } from '../collab/profile'

export interface Viewport {
  /** Screen offset of board origin, in CSS pixels. */
  x: number
  y: number
  zoom: number
}

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 4

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

interface ViewState {
  boardId: string | null
  viewport: Viewport
  setViewport: (v: Viewport) => void
  /** Called when a board is opened; restores its saved viewport. */
  resetFor: (boardId: string) => void
}

const savedViewports = loadJSON<Record<string, Viewport>>('viewports', {})
let viewportSaveTimer: ReturnType<typeof setTimeout> | null = null

export const useView = create<ViewState>((set, get) => ({
  boardId: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  setViewport: (v) => {
    const viewport = { x: v.x, y: v.y, zoom: clampZoom(v.zoom) }
    set({ viewport })
    const id = get().boardId
    if (id) {
      savedViewports[id] = viewport
      if (viewportSaveTimer) clearTimeout(viewportSaveTimer)
      viewportSaveTimer = setTimeout(() => saveJSON('viewports', savedViewports), 500)
    }
  },
  resetFor: (boardId) => {
    set({ boardId, viewport: savedViewports[boardId] ?? { x: 80, y: 60, zoom: 1 } })
  },
}))

export const hasSavedViewport = (boardId: string) => !!savedViewports[boardId]

export type Tool = 'select' | 'draw' | 'line'

interface SelectionState {
  selected: ReadonlySet<string>
  editing: string | null
  /** Card last reached by keyboard navigation (outlined, announced); cleared on any pointer press. */
  kbFocus: string | null
  tool: Tool
  /** Draw tool settings */
  penColor: string
  penSize: number
  select: (ids: Iterable<string>, mode?: 'replace' | 'add' | 'toggle') => void
  clear: () => void
  setEditing: (id: string | null) => void
  setTool: (t: Tool) => void
  setPen: (p: { color?: string; size?: number }) => void
  setKbFocus: (id: string | null) => void
}

const EMPTY: ReadonlySet<string> = new Set()

export const useSelection = create<SelectionState>((set, get) => ({
  selected: EMPTY,
  editing: null,
  kbFocus: null,
  tool: 'select',
  penColor: '#1f2328',
  penSize: 4,
  select: (ids, mode = 'replace') => {
    const next = mode === 'replace' ? new Set<string>() : new Set(get().selected)
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id)
      else next.add(id)
    }
    const { editing, kbFocus } = get()
    set({
      selected: next,
      editing: editing && next.has(editing) ? editing : null,
      kbFocus: kbFocus && next.has(kbFocus) ? kbFocus : null,
    })
  },
  clear: () => {
    if (get().selected.size === 0 && !get().editing && !get().kbFocus) return
    set({ selected: EMPTY, editing: null, kbFocus: null })
  },
  setEditing: (id) => {
    if (id) set({ editing: id, selected: new Set([id]) })
    else set({ editing: null })
  },
  setTool: (tool) => set({ tool }),
  setPen: (p) => set({ penColor: p.color ?? get().penColor, penSize: p.size ?? get().penSize }),
  setKbFocus: (kbFocus) => {
    if (get().kbFocus !== kbFocus) set({ kbFocus })
  },
}))

/** Local drag/resize preview (not yet committed to the doc). */
export interface LocalDrag {
  ids: string[]
  dx: number
  dy: number
  /** Live size during resize of a single card. */
  w?: number
  h?: number
  /** Drop target under the pointer while dragging. */
  target: DropTarget | null
  /** Pointer position in board coordinates. */
  pointer: { x: number; y: number }
  /** Cards being dragged out of a column follow the pointer as a floating ghost. */
  fromColumn: boolean
  /** Alt/Option held: the drop makes copies and leaves the originals in place. */
  copy?: boolean
}

export type DropTarget =
  | { kind: 'column'; columnId: string; index: number }
  /** cardId is '' when the target is a breadcrumb rather than a board card. */
  | { kind: 'board'; cardId: string; boardId: string }
  | { kind: 'trash' }
  /** A comment resting over another card: the drop pins the comment to that card. */
  | { kind: 'attach'; cardId: string }

interface DragState {
  drag: LocalDrag | null
  setDrag: (d: LocalDrag | null) => void
}

export const useDrag = create<DragState>((set) => ({
  drag: null,
  setDrag: (drag) => set({ drag }),
}))

/** Id sets of drag id lists (a drag reuses one array for all its pointer moves). */
const dragIdSets = new WeakMap<readonly string[], ReadonlySet<string>>()

/** O(1) "is this card part of the drag", for selectors that run on every card per pointer move. */
export function isInDrag(drag: LocalDrag | null | undefined, id: string): boolean {
  if (!drag) return false
  let set = dragIdSets.get(drag.ids)
  if (!set) dragIdSets.set(drag.ids, (set = new Set(drag.ids)))
  return set.has(id)
}

/** Side panels / dialogs. */
export type Panel = 'trash' | 'search' | 'unsorted' | null

interface PanelState {
  panel: Panel
  setPanel: (p: Panel) => void
  /** Card opened in the full-screen document editor or image lightbox. */
  expanded: string | null
  setExpanded: (id: string | null) => void
  presenting: boolean
  setPresenting: (on: boolean) => void
}

export const usePanels = create<PanelState>((set) => ({
  panel: null,
  setPanel: (panel) => set({ panel }),
  expanded: null,
  setExpanded: (expanded) => set({ expanded }),
  presenting: false,
  setPresenting: (presenting) => set({ presenting }),
}))

/** Right-click menu for cards or the empty canvas (rendered by the UI layer). */
export interface ContextMenuState {
  /** Screen position */
  x: number
  y: number
  kind: 'card' | 'canvas'
  /** Cards the menu acts on (the selection). */
  ids: string[]
  /** Board position (for "add card here" on the canvas menu). */
  at: { x: number; y: number }
}

export const useContextMenu = create<{
  menu: ContextMenuState | null
  open: (m: ContextMenuState) => void
  close: () => void
}>((set) => ({
  menu: null,
  open: (menu) => set({ menu }),
  close: () => set({ menu: null }),
}))
