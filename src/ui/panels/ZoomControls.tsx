/**
 * Bottom-right zoom pill (out / percentage / in / fit) plus a brief zoom-level readout while zooming.
 * The percentage opens a popover with a zoom slider, preset levels, fit and zoom to selection.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { Focus, Maximize, Minus, Plus, ScanSearch } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { zoomBy, zoomTo, zoomToFit, zoomToSelection } from '../../board/actions'
import { MAX_ZOOM, MIN_ZOOM, usePanels, useSelection, useView } from '../../board/store'
import { modKey, shiftKey } from '../menus/keys'
import { keepControlKeys } from '../keyGuard'
import { isPreset, SLIDER_STEPS, sliderToZoom, snapToPreset, zoomForKey, zoomPercent, ZOOM_PRESETS, zoomToSlider } from './zoomScale'
import './panels.css'

export function ZoomControls({ ctx }: { ctx: BoardContextValue }) {
  const presenting = usePanels((s) => s.presenting)
  const panelOpen = usePanels((s) => s.panel !== null)
  const zoom = useView((s) => s.viewport.zoom)
  if (presenting) return null
  return (
    <>
      <div className={`zoom-pill${panelOpen ? ' zoom-pill--beside-panel' : ''}`} role="group" aria-label="Zoom" onKeyDown={keepControlKeys}>
        <button
          type="button"
          className="zoom-pill__btn"
          aria-label="Zoom out"
          title={`Zoom out (${modKey}−)`}
          disabled={zoom <= MIN_ZOOM + 1e-3}
          onClick={() => zoomBy(0.8)}
        >
          <Minus size={16} strokeWidth={2} />
        </button>
        <ZoomPopover ctx={ctx} zoom={zoom} />
        <button
          type="button"
          className="zoom-pill__btn"
          aria-label="Zoom in"
          title={`Zoom in (${modKey}+)`}
          disabled={zoom >= MAX_ZOOM - 1e-3}
          onClick={() => zoomBy(1.25)}
        >
          <Plus size={16} strokeWidth={2} />
        </button>
        <span className="zoom-pill__sep" aria-hidden />
        <button type="button" className="zoom-pill__btn" aria-label="Zoom to fit" title={`Zoom to fit (${shiftKey}1)`} onClick={() => zoomToFit(ctx.doc)}>
          <Maximize size={15} strokeWidth={2} />
        </button>
      </div>
      <ZoomHud zoom={zoom} />
    </>
  )
}

function ZoomPopover({ ctx, zoom }: { ctx: BoardContextValue; zoom: number }) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top-end',
    strategy: 'fixed',
    middleware: [
      offset(8),
      flip({ padding: 8, fallbackPlacements: ['top-start', 'bottom-end', 'left-end'] }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableWidth, availableHeight, elements }) {
          elements.floating.style.maxWidth = `${Math.max(200, Math.floor(availableWidth))}px`
          elements.floating.style.maxHeight = `${Math.max(160, Math.floor(availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })
  const click = useClick(context)
  // Escape is handled inside the popover so it never reaches the board (which would clear the selection).
  const dismiss = useDismiss(context, { escapeKey: false })
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={`zoom-pill__pct${open ? ' is-open' : ''}`}
        aria-label={`Zoom ${zoomPercent(zoom)}. Zoom options`}
        title="Zoom options"
        aria-expanded={open}
        aria-haspopup="dialog"
        {...getReferenceProps()}
      >
        {zoomPercent(zoom)}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus initialFocus={0}>
            <div
              ref={refs.setFloating}
              className="zoom-pop"
              aria-label="Zoom"
              style={floatingStyles}
              {...getFloatingProps({
                // Keep board shortcuts (arrows nudge cards, Delete...) from acting while the popover has focus.
                onKeyDown: (e: ReactKeyboardEvent) => {
                  e.stopPropagation()
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setOpen(false)
                  }
                },
              })}
            >
              <ZoomPanel ctx={ctx} zoom={zoom} onDone={() => setOpen(false)} />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

function ZoomPanel({ ctx, zoom, onDone }: { ctx: BoardContextValue; zoom: number; onDone: () => void }) {
  const hasSelection = useSelection((s) => s.selected.size > 0)
  const sliderId = useId()
  const sliderRef = useRef<HTMLInputElement | null>(null)
  const pos = Math.round(zoomToSlider(zoom))

  const onSliderKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const next = zoomForKey(e.key, zoom)
    if (next === null) return
    // Native range steps (1/1000 of the track) are far too small to feel; zoom by real steps instead.
    e.preventDefault()
    zoomTo(next)
  }

  return (
    <div className="zoom-pop__body">
      <button type="button" className="zoom-pop__item" onClick={() => zoomTo(1)}>
        <ScanSearch size={16} strokeWidth={1.75} aria-hidden />
        <span>Reset to 100%</span>
        <kbd className="zoom-pop__kbd">{modKey}0</kbd>
      </button>
      <div className="zoom-pop__slider">
        <label htmlFor={sliderId} className="sr-only">
          Zoom level
        </label>
        <Minus size={14} strokeWidth={2} aria-hidden className="zoom-pop__end" />
        <input
          ref={sliderRef}
          id={sliderId}
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={pos}
          aria-valuetext={zoomPercent(zoom)}
          onKeyDown={onSliderKey}
          onChange={(e) => zoomTo(snapToPreset(sliderToZoom(Number(e.currentTarget.value))))}
        />
        <Plus size={14} strokeWidth={2} aria-hidden className="zoom-pop__end" />
        <output className="zoom-pop__value" htmlFor={sliderId}>
          {zoomPercent(zoom)}
        </output>
      </div>
      <div className="zoom-pop__presets" role="group" aria-label="Zoom presets">
        {ZOOM_PRESETS.map((p) => (
          <button key={p} type="button" className="zoom-pop__preset" aria-pressed={isPreset(zoom, p)} onClick={() => zoomTo(p)}>
            {zoomPercent(p)}
          </button>
        ))}
      </div>
      <div className="zoom-pop__sep" role="separator" />
      <button
        type="button"
        className="zoom-pop__item"
        onClick={() => {
          zoomToFit(ctx.doc)
          onDone()
        }}
      >
        <Maximize size={16} strokeWidth={1.75} aria-hidden />
        <span>Zoom to fit</span>
        <kbd className="zoom-pop__kbd">{shiftKey}1</kbd>
      </button>
      <button
        type="button"
        className="zoom-pop__item"
        disabled={!hasSelection}
        title={hasSelection ? undefined : 'Select cards first'}
        onClick={() => {
          zoomToSelection(ctx.doc)
          onDone()
        }}
      >
        <Focus size={16} strokeWidth={1.75} aria-hidden />
        <span>Zoom to selection</span>
        <kbd className="zoom-pop__kbd">{shiftKey}2</kbd>
      </button>
    </div>
  )
}

/** Ignore zoom changes right after mount: restoring or fitting the saved view is not "zooming". */
const SETTLE_MS = 800
const HUD_MS = 1000

function ZoomHud({ zoom }: { zoom: number }) {
  const [visible, setVisible] = useState(false)
  const mountedAt = useRef(performance.now())
  const last = useRef(zoom)
  useEffect(() => {
    if (last.current === zoom) return
    last.current = zoom
    if (performance.now() - mountedAt.current < SETTLE_MS) return
    setVisible(true)
    const t = setTimeout(() => setVisible(false), HUD_MS)
    return () => clearTimeout(t)
  }, [zoom])
  return (
    <div className={`zoom-hud${visible ? ' is-visible' : ''}`} aria-hidden>
      {zoomPercent(zoom)}
    </div>
  )
}
