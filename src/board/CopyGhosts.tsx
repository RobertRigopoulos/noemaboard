/**
 * Alt/Option-drag feedback: dashed outlines where the dragged cards are now (the originals stay
 * there) while the dragged shells show where the copies will land. Rendered inside `.world`.
 */
import { create } from 'zustand'
import { useDrag, useView } from './store'
import type { Rect } from './geometry'

/** Original board rects of the cards in an Alt-drag, captured once when the drag starts. */
export const useCopyGhosts = create<{ rects: readonly Rect[]; set: (rects: readonly Rect[]) => void }>((set) => ({
  rects: [],
  set: (rects) => set({ rects }),
}))

export function CopyGhosts() {
  const copying = useDrag((s) => !!s.drag?.copy)
  const rects = useCopyGhosts((s) => s.rects)
  const zoom = useView((s) => s.viewport.zoom)
  if (!copying || !rects.length) return null
  const line = `${1 / zoom}px`
  return (
    <div className="copy-ghosts" aria-hidden>
      {rects.map((r, i) => (
        <div key={i} className="copy-ghost" style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderWidth: line }} />
      ))}
    </div>
  )
}
