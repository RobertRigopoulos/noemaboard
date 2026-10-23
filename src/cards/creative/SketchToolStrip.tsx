import { useState, type CSSProperties } from 'react'
import { autoUpdate, flip, FloatingPortal, hide, offset, shift, useFloating } from '@floating-ui/react'
import { Check, Eraser, PenLine, Trash2, Undo2 } from 'lucide-react'
import { getCanvasElement } from '../../board/geometry'
import { INK, PEN_COLORS, PEN_SIZES } from './sketchMath'

export type SketchMode = 'pen' | 'eraser'

interface Props {
  /** The sketch card element the strip floats above. */
  anchor: HTMLElement
  mode: SketchMode
  onMode: (m: SketchMode) => void
  color: string
  size: number
  onPen: (p: { color?: string; size?: number }) => void
  canUndo: boolean
  onUndo: () => void
  canClear: boolean
  onClear: () => void
  onDone: () => void
}

/**
 * Floating drawing tools shown above a sketch while it is being edited. Rendered in a portal in
 * screen space so it keeps the same size at any canvas zoom.
 */
export function SketchToolStrip(p: Props) {
  const [confirming, setConfirming] = useState(false)
  const boundary = getCanvasElement() ?? 'clippingAncestors'
  const { refs, floatingStyles, middlewareData } = useFloating({
    elements: { reference: p.anchor },
    placement: 'top',
    strategy: 'fixed',
    middleware: [
      offset(12),
      flip({ padding: 8, boundary }),
      // crossAxis: when the card fills the screen, slide the strip over the card instead of off-screen.
      shift({ padding: 8, crossAxis: true, boundary }),
      hide({ boundary }),
    ],
    // The canvas pans/zooms with CSS transforms, which fire no scroll events: track every frame.
    whileElementsMounted: (r, f, u) => autoUpdate(r, f, u, { animationFrame: true }),
  })
  const hidden = !!middlewareData.hide?.referenceHidden

  const pickColor = (color: string) => {
    p.onPen({ color })
    p.onMode('pen')
  }
  const pickSize = (size: number) => {
    p.onPen({ size })
    p.onMode('pen')
  }

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        className="sketch-strip"
        role="toolbar"
        aria-label="Sketch tools"
        style={{ ...floatingStyles, visibility: hidden ? 'hidden' : undefined }}
        // React events bubble through portals to the card shell; keep them here.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {confirming ? (
          <div className="sketch-strip__confirm" role="alertdialog" aria-label="Clear sketch">
            <span>Clear the whole sketch?</span>
            <button type="button" className="btn btn--ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn sketch-strip__danger"
              autoFocus
              onClick={() => {
                p.onClear()
                setConfirming(false)
              }}
            >
              Clear
            </button>
          </div>
        ) : (
          <>
            <div className="sketch-strip__group">
              <button
                type="button"
                className="icon-btn"
                aria-pressed={p.mode === 'pen'}
                aria-label="Pen"
                title="Pen (P)"
                onClick={() => p.onMode('pen')}
              >
                <PenLine size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-pressed={p.mode === 'eraser'}
                aria-label="Eraser"
                title="Eraser (E) – click or drag over strokes"
                onClick={() => p.onMode('eraser')}
              >
                <Eraser size={16} />
              </button>
            </div>
            <span className="sketch-strip__sep" aria-hidden="true" />
            <div className="sketch-strip__group" role="radiogroup" aria-label="Pen color">
              {PEN_COLORS.map((c) => {
                const active = p.color === c.color && p.mode === 'pen'
                return (
                  <button
                    key={c.color}
                    type="button"
                    role="radio"
                    aria-checked={p.color === c.color}
                    aria-label={c.label}
                    title={c.label}
                    className={`sketch-strip__color${active ? ' is-active' : ''}`}
                    data-ink={c.color === INK || undefined}
                    data-light={c.color === '#ffffff' || undefined}
                    style={{ '--dot': c.color } as CSSProperties}
                    onClick={() => pickColor(c.color)}
                  />
                )
              })}
            </div>
            <span className="sketch-strip__sep" aria-hidden="true" />
            <div className="sketch-strip__group" role="radiogroup" aria-label="Pen size">
              {PEN_SIZES.map((s, i) => (
                <button
                  key={s.size}
                  type="button"
                  role="radio"
                  aria-checked={p.size === s.size}
                  aria-label={`${s.label} pen`}
                  title={`${s.label} ([ / ])`}
                  className={`sketch-strip__size${p.size === s.size ? ' is-active' : ''}`}
                  onClick={() => pickSize(s.size)}
                >
                  <span style={{ width: 4 + i * 4, height: 4 + i * 4 }} />
                </button>
              ))}
            </div>
            <span className="sketch-strip__sep" aria-hidden="true" />
            <div className="sketch-strip__group">
              <button
                type="button"
                className="icon-btn"
                aria-label="Undo my last stroke"
                title="Undo my last stroke"
                disabled={!p.canUndo}
                onClick={p.onUndo}
              >
                <Undo2 size={16} />
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label="Clear sketch"
                title="Clear sketch"
                disabled={!p.canClear}
                onClick={() => setConfirming(true)}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <button type="button" className="btn btn--primary sketch-strip__done" onClick={p.onDone} title="Done (Esc)">
              <Check size={14} aria-hidden="true" />
              Done
            </button>
          </>
        )}
      </div>
    </FloatingPortal>
  )
}
