/**
 * Crop, rotate and flip editor shown inside the lightbox (lightboxStore mode 'crop'). It edits a
 * draft; nothing is written until Apply, which the lightbox turns into one undoable card update.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Check, FlipHorizontal2, FlipVertical2, RotateCcw, RotateCw, Undo2, X, type LucideIcon } from 'lucide-react'
import {
  clampCrop,
  flipTransform,
  FULL_CROP,
  minCropSize,
  orientedSize,
  rotateTransform,
  transformStyle,
  type Crop,
  type ImageTransform,
  type Rotation,
} from './transform'
import { fitAspect, fractionRatio, HANDLE_LABELS, HANDLES, moveCrop, nudgeFor, resizeCrop, type Handle } from './cropMath'
import { useElementSize } from './useElementSize'

const PRESETS = [
  { id: 'free', label: 'Free', aspect: null },
  { id: 'original', label: 'Original', aspect: 'original' },
  { id: '1:1', label: '1:1', aspect: 1 },
  { id: '4:3', label: '4:3', aspect: 4 / 3 },
  { id: '3:2', label: '3:2', aspect: 3 / 2 },
  { id: '16:9', label: '16:9', aspect: 16 / 9 },
  { id: '9:16', label: '9:16', aspect: 9 / 16 },
] as const
type PresetId = (typeof PRESETS)[number]['id']

/** Room around the picture for the handles. */
const STAGE_PAD = 28
/** Small pictures are shown larger to be croppable, up to this zoom. */
const MAX_UPSCALE = 4
const STEP = 0.01
const BIG_STEP = 0.1

interface Draft {
  crop: Crop
  rotation: Rotation
  flipH: boolean
  flipV: boolean
}

export interface ImageCropperProps {
  src: string | null
  name: string
  /** Natural size of the original; 0 until known. */
  iw: number
  ih: number
  initial: ImageTransform
  onApply: (t: ImageTransform) => void
  onCancel: () => void
  /** Closes the lightbox without applying. */
  onClose: () => void
  /** The lightbox routes its keydowns here while the cropper is shown. */
  keys: MutableRefObject<((e: KeyboardEvent) => void) | null>
  /** The picture loaded: its source and natural size (cards from older clients may lack a size). */
  onNaturalSize?: (src: string, w: number, h: number) => void
  /** Shown in place of the picture while there is no `src` (loading, or not on this device). */
  waiting?: ReactNode
}

/** Icon and text; under 520px only the icon shows (the aria-label keeps the name). */
function ToolButton({ icon: Icon, label, hint, onClick }: { icon: LucideIcon; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" className="lightbox__btn cropper__tool" onClick={onClick} aria-label={label} title={hint ? `${label} (${hint})` : label}>
      <Icon size={16} aria-hidden />
      <span className="cropper__label">{label}</span>
    </button>
  )
}

function fractionAspect(preset: PresetId, t: { rotation: Rotation }, iw: number, ih: number): number | null {
  const p = PRESETS.find((x) => x.id === preset)
  if (!p || p.aspect === null) return null
  if (p.aspect === 'original') return 1
  const o = orientedSize(iw, ih, t.rotation)
  return fractionRatio(p.aspect, o.w, o.h)
}

export function ImageCropper({ src, name, iw, ih, initial, onApply, onCancel, onClose, keys, onNaturalSize, waiting }: ImageCropperProps) {
  const [draft, setDraft] = useState<Draft>(() => ({ ...initial, crop: initial.crop ?? FULL_CROP }))
  const [preset, setPreset] = useState<PresetId>('free')
  const { ref: stageRef, size: stage } = useElementSize<HTMLDivElement>()
  const helpId = useId()
  // Keyboard changes are announced (pointer users see them); bumped on each one so a repeat is re-read.
  const [announce, setAnnounce] = useState(0)
  const ready = stage.w > 0 && !!src
  // The crop box takes focus once the stage is measured and the picture is there.
  const boxRef = useRef<HTMLButtonElement>(null)
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (focusedOnce.current || !boxRef.current) return
    focusedOnce.current = true
    boxRef.current.focus({ preventScroll: true })
  }, [ready])
  const known = iw > 0 && ih > 0
  const o = known ? orientedSize(iw, ih, draft.rotation) : draft.rotation % 180 ? { w: 3, h: 4 } : { w: 4, h: 3 }

  // The picture fitted in the stage, in screen pixels.
  const box = useMemo(() => {
    const aw = Math.max(1, stage.w - STAGE_PAD * 2)
    const ah = Math.max(1, stage.h - STAGE_PAD * 2)
    const cap = known ? MAX_UPSCALE : Infinity
    const s = Math.min(aw / o.w, ah / o.h, cap)
    const w = Math.max(1, o.w * s)
    const h = Math.max(1, o.h * s)
    return { w, h, left: (stage.w - w) / 2, top: (stage.h - h) / 2, scale: s }
  }, [stage.w, stage.h, o.w, o.h, known])

  const ratio = fractionAspect(preset, draft, iw, ih)
  const min = minCropSize(iw, ih, draft.rotation)
  const limits = { ratio, minW: min.w, minH: min.h }

  const drag = useRef<{ handle: Handle | 'box'; start: Crop; x: number; y: number; id: number } | null>(null)
  const startDrag = (handle: Handle | 'box') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.focus({ preventScroll: true })
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { handle, start: draft.crop, x: e.clientX, y: e.clientY, id: e.pointerId }
  }
  const onDragMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const du = (e.clientX - d.x) / box.w
    const dv = (e.clientY - d.y) / box.h
    const crop = d.handle === 'box' ? moveCrop(d.start, du, dv) : resizeCrop(d.start, d.handle, du, dv, limits)
    setDraft((t) => ({ ...t, crop }))
  }
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }

  const nudge = (handle: Handle | 'box', key: string, big: boolean): boolean => {
    const n = nudgeFor(handle, key, big ? BIG_STEP : STEP)
    if (!n) return false
    setDraft((t) => ({ ...t, crop: handle === 'box' ? moveCrop(t.crop, n.du, n.dv) : resizeCrop(t.crop, handle, n.du, n.dv, limits) }))
    setAnnounce((k) => k + 1)
    return true
  }

  const refit = (t: Draft, p: PresetId): Draft => {
    const r = fractionAspect(p, t, iw, ih)
    return r ? { ...t, crop: fitAspect(t.crop, r) } : t
  }
  const rotate = (dir: 'cw' | 'ccw') => {
    setDraft((t) => {
      const next = rotateTransform(t, dir)
      return refit({ ...next, crop: next.crop ?? FULL_CROP }, preset)
    })
    setAnnounce((k) => k + 1)
  }
  const flip = (axis: 'h' | 'v') =>
    setDraft((t) => {
      const next = flipTransform(t, axis)
      return { ...next, crop: next.crop ?? FULL_CROP }
    })
  const reset = () => {
    setPreset('free')
    setDraft({ crop: FULL_CROP, rotation: 0, flipH: false, flipV: false })
  }
  const choosePreset = (p: PresetId) => {
    setPreset(p)
    setDraft((t) => refit(t, p))
  }
  const apply = () => onApply({ crop: clampCrop(draft.crop, iw, ih, draft.rotation), rotation: draft.rotation, flipH: draft.flipH, flipV: draft.flipV })

  // Keys arrive from the lightbox's capture listener (board shortcuts never see them).
  const latest = useRef({ apply, onCancel, rotate, nudge })
  useEffect(() => {
    latest.current = { apply, onCancel, rotate, nudge }
  })
  useEffect(() => {
    keys.current = (e: KeyboardEvent) => {
      const active = document.activeElement as HTMLElement | null
      const handle = (active?.closest?.('[data-handle]') as HTMLElement | null)?.dataset.handle as Handle | 'box' | undefined
      if (e.key === 'Escape') {
        e.preventDefault()
        latest.current.onCancel()
        return
      }
      if (e.key === 'Enter') {
        // A focused tool button is activated as usual; anywhere else Enter applies.
        if (active?.tagName === 'BUTTON' && !handle) return
        e.preventDefault()
        latest.current.apply()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key.toLowerCase() === 'r') {
        e.preventDefault()
        latest.current.rotate(e.shiftKey ? 'ccw' : 'cw')
        return
      }
      if (handle && e.key.startsWith('Arrow') && latest.current.nudge(handle, e.key, e.shiftKey)) e.preventDefault()
    }
    return () => {
      keys.current = null
    }
  }, [keys])

  const view = transformStyle({ crop: null, rotation: draft.rotation, flipH: draft.flipH, flipV: draft.flipV }, iw, ih)
  const c = draft.crop
  const pct = (v: number) => `${v * 100}%`
  const outW = known ? Math.max(1, Math.round(c.w * orientedSize(iw, ih, draft.rotation).w)) : 0
  const outH = known ? Math.max(1, Math.round(c.h * orientedSize(iw, ih, draft.rotation).h)) : 0
  const where = `${Math.round(c.x * 100)}% from the left, ${Math.round(c.y * 100)}% from the top`
  const status = known
    ? `Crop ${outW} by ${outH} pixels, ${where}`
    : `Crop ${Math.round(c.w * 100)}% by ${Math.round(c.h * 100)}% of the picture, ${where}`

  return (
    <>
      <div className="lightbox__bar">
        <div className="lightbox__title">
          <span className="lightbox__name" title={name}>
            Crop and rotate
          </span>
          {known && (
            <span className="lightbox__dims" aria-label={`Result ${outW} by ${outH} pixels`}>
              {outW} × {outH}
            </span>
          )}
        </div>
        <button type="button" className="lightbox__btn lightbox__btn--icon" onClick={onClose} aria-label="Close without cropping" title="Close">
          <X size={18} aria-hidden />
        </button>
      </div>
      <div ref={stageRef} className="cropper__stage">
        <p id={helpId} className="media-visually-hidden">
          Drag the crop area or its handles, or focus them and use the arrow keys (Shift for larger steps). R rotates right,
          Shift+R rotates left. Enter applies, Escape cancels.
        </p>
        <p className="media-visually-hidden" role="status" aria-live="polite">
          {/* A no-break space on every other change makes a repeated text count as new. */}
          {announce ? status + (announce % 2 ? '' : String.fromCharCode(0xa0)) : ''}
        </p>
        {stage.w > 0 && !src && waiting}
        {ready && (
          <div className="cropper__image" style={{ left: box.left, top: box.top, width: box.w, height: box.h }}>
            <div className="cropper__picture" style={view.inner}>
              <img
                src={src ?? undefined}
                alt=""
                draggable={false}
                style={view.img}
                onLoad={(e) => onNaturalSize?.(e.currentTarget.src, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
              />
            </div>
            <div className="cropper__dim" style={{ left: 0, top: 0, width: '100%', height: pct(c.y) }} />
            <div className="cropper__dim" style={{ left: 0, top: pct(c.y + c.h), width: '100%', bottom: 0 }} />
            <div className="cropper__dim" style={{ left: 0, top: pct(c.y), width: pct(c.x), height: pct(c.h) }} />
            <div className="cropper__dim" style={{ left: pct(c.x + c.w), top: pct(c.y), right: 0, height: pct(c.h) }} />
            <div className="cropper__frame" style={{ left: pct(c.x), top: pct(c.y), width: pct(c.w), height: pct(c.h) }}>
              <button
                ref={boxRef}
                type="button"
                className="cropper__box"
                data-handle="box"
                aria-label="Crop area"
                aria-describedby={helpId}
                onPointerDown={startDrag('box')}
                onPointerMove={onDragMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onKeyDown={(e: ReactKeyboardEvent) => e.key === ' ' && e.preventDefault()}
              >
                <span className="cropper__third cropper__third--v1" />
                <span className="cropper__third cropper__third--v2" />
                <span className="cropper__third cropper__third--h1" />
                <span className="cropper__third cropper__third--h2" />
              </button>
              {HANDLES.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`cropper__handle cropper__handle--${h}`}
                  data-handle={h}
                  aria-label={HANDLE_LABELS[h]}
                  aria-describedby={helpId}
                  onPointerDown={startDrag(h)}
                  onPointerMove={onDragMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="cropper__bar">
        <div className="cropper__presets" role="group" aria-label="Aspect ratio">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="cropper__preset"
              aria-pressed={preset === p.id}
              onClick={() => choosePreset(p.id)}
              title={p.id === 'original' ? 'Original proportions' : p.id === 'free' ? 'Any proportions' : `${p.label} proportions`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="cropper__tools">
          <ToolButton icon={RotateCcw} label="Rotate left" hint="Shift+R" onClick={() => rotate('ccw')} />
          <ToolButton icon={RotateCw} label="Rotate right" hint="R" onClick={() => rotate('cw')} />
          <ToolButton icon={FlipHorizontal2} label="Flip horizontal" onClick={() => flip('h')} />
          <ToolButton icon={FlipVertical2} label="Flip vertical" onClick={() => flip('v')} />
          <ToolButton icon={Undo2} label="Reset" onClick={reset} />
        </div>
        <div className="cropper__end">
          <button type="button" className="lightbox__btn cropper__tool" onClick={onCancel} aria-label="Cancel" title="Cancel (Esc)">
            <X size={16} aria-hidden />
            <span className="cropper__label">Cancel</span>
          </button>
          <button type="button" className="lightbox__btn lightbox__btn--primary cropper__tool" onClick={apply} aria-label="Apply" title="Apply (Enter)">
            <Check size={16} aria-hidden />
            <span className="cropper__label">Apply</span>
          </button>
        </div>
      </div>
    </>
  )
}
