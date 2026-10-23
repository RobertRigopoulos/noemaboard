/**
 * Full-screen image viewer with previous/next through the board's images, zoom and pan, the caption,
 * and the cropper. Mounted by the media board overlay (actions.tsx) while usePanels.expanded is the id
 * of an active image card. Viewing writes nothing; Apply in the cropper is one undoable update.
 */
import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import * as Y from 'yjs'
import { ChevronDown, ChevronLeft, ChevronRight, Crop, Download, ExternalLink, LoaderCircle, X } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { useYVersion } from '../../board/BoardContext'
import { usePanels, useSelection } from '../../board/store'
import { getCardMap, readCard, updateCard, xmlToText } from '../../model/board'
import type { Card } from '../../model/types'
import { useBlobUrl } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { getUser } from '../../collab/identity'
import { desktop } from '../../lib/desktop'
import { RichText } from '../../editor/RichText'
import { BlobWaiting } from './common'
import { downloadBlob, downloadEdited, openImageInTab } from './download'
import { refuseStrayDrop } from './dropGuard'
import { asText } from './format'
import { positive } from './numbers'
import { imageLabel, readAlt } from './altText'
import { readCaptionHidden } from './captionState'
import { reportBlob } from './blobAvailability'
import { useLightbox } from './lightboxStore'
import { ImageCropper } from './ImageCropper'
import {
  croppedPixelSize,
  displayAspect,
  isIdentity,
  readImageTransform,
  sameTransform,
  transformFields,
  transformStyle,
  type ImageTransform,
} from './transform'
import { canPan, clampPan, fitScale, scaleLimits, wheelFactor, zoomAround, type Size, type ZoomState } from './zoomMath'
import { useElementSize } from './useElementSize'
import './media.css'

interface Props {
  ctx: BoardContextValue
  id: string
  card: Card
  /** Board images in reading order, for previous / next. */
  order: readonly string[]
}

/** The portal still bubbles React events to the card and canvas; keep them inside the dialog. */
const stop = (e: SyntheticEvent) => e.stopPropagation()

const FOCUSABLE = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
/** Space kept around the fitted picture. */
const STAGE_PAD = 24
const KEY_ZOOM = 1.25
/** Arrow-key pan while zoomed in, as a fraction of the stage (Shift: the larger one). */
const KEY_PAN = 0.1
const KEY_PAN_BIG = 0.5
/** Arrow key -> direction the picture moves to show more of that side. */
const ARROW_PAN: Record<string, [number, number]> = { ArrowLeft: [1, 0], ArrowRight: [-1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }

export function ImageLightbox({ ctx, id, card, order }: Props) {
  const { boardId, doc, readOnly } = ctx
  const data = card as unknown as Record<string, unknown>
  const blob = isValidBlobHash(data.blob) ? data.blob : null
  const thumb = isValidBlobHash(data.thumb) ? data.thumb : null
  const name = asText(data.name, 255) || 'Image'
  const mime = asText(data.mime, 100)
  const [natural, setNatural] = useState<{ src: string; w: number; h: number } | null>(null)

  const full = useBlobUrl(blob, boardId)
  const small = useBlobUrl(thumb, boardId)
  const src = full.url ?? small.url
  const unavailable = full.state === 'missing' && small.state !== 'loading'
  useEffect(() => {
    if (full.state === 'ready') reportBlob(blob, 'local')
    else if (full.state === 'missing') reportBlob(blob, 'missing')
  }, [blob, full.state])

  // Cards from older clients may lack their size: the full image (not the thumbnail) tells.
  const known = positive(data.iw) > 0 && positive(data.ih) > 0
  const iw = known ? positive(data.iw) : natural && natural.src === full.url ? natural.w : 0
  const ih = known ? positive(data.ih) : natural && natural.src === full.url ? natural.h : 0
  const t = readImageTransform(data, iw, ih)
  const transformed = !isIdentity(t)
  const alt = readAlt(data.alt)

  const captionRaw = getCardMap(doc, id)?.get('caption')
  const caption = captionRaw instanceof Y.XmlFragment ? captionRaw : null
  const captionVersion = useYVersion(caption)
  const captionText = useMemo(() => (caption ? xmlToText(caption).trim() : ''), [caption, captionVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const captionShown = !!caption && !!captionText && !readCaptionHidden(data)
  const label = imageLabel(alt, captionText, name)

  const mode = useLightbox((s) => s.mode)
  const modeTarget = useLightbox((s) => s.target)
  const cropping = mode === 'crop' && modeTarget === id && !readOnly && !!blob

  const index = order.indexOf(id)
  const prevId = index > 0 ? order[index - 1] : null
  const nextId = index >= 0 && index < order.length - 1 ? order[index + 1] : null

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const cropKeys = useRef<((e: KeyboardEvent) => void) | null>(null)
  const menu = useRef<DownloadMenuHandle | null>(null)

  // ----- zoom and pan
  const { ref: stageRef, el: stageEl, size: stage, node: stageNode } = useElementSize<HTMLDivElement>()
  const avail = { w: Math.max(1, stage.w - STAGE_PAD * 2), h: Math.max(1, stage.h - STAGE_PAD * 2) }
  const content: Size = (() => {
    const px = croppedPixelSize(t, iw, ih)
    if (px.w > 0 && px.h > 0) return px
    // Size unknown until the picture loads: fit its probable aspect.
    const a = displayAspect(t, iw, ih)
    const w = Math.min(avail.w, avail.h * a)
    return { w, h: w / a }
  })()
  const fit = fitScale(content, avail)
  const limits = scaleLimits(fit)
  const [zoomed, setZoomed] = useState<{ id: string; z: ZoomState } | null>(null)
  const [animate, setAnimate] = useState(false)
  // Each image opens fitted; "fit" follows window resizes until someone zooms.
  const view: ZoomState = zoomed && zoomed.id === id ? zoomed.z : { scale: fit, x: 0, y: 0 }
  const isFit = !zoomed || zoomed.id !== id
  // The view as last set, ahead of React: pointer and key events can arrive several times per frame.
  const viewRef = useRef(view)
  viewRef.current = view
  const setView = (z: ZoomState | null, smooth = false) => {
    const next = z ? clampPan(z, content, stage) : null
    viewRef.current = next ?? { scale: fit, x: 0, y: 0 }
    setAnimate(smooth)
    setZoomed(next ? { id, z: next } : null)
  }
  const zoomAt = (factor: number, point = { x: 0, y: 0 }, smooth = false) => setView(zoomAround(viewRef.current, factor, point, limits), smooth)
  const actualSize = (point = { x: 0, y: 0 }) => zoomAt(1 / viewRef.current.scale, point, true)
  const pannable = canPan(view, content, stage)
  /** Moves the picture by (dx, dy) screen pixels. False when it fits the stage that way (nothing to look at). */
  const panBy = (dx: number, dy: number): boolean => {
    const v = viewRef.current
    const overflows = (dx !== 0 && content.w * v.scale > stage.w + 0.5) || (dy !== 0 && content.h * v.scale > stage.h + 0.5)
    if (!overflows) return false
    setView({ ...v, x: v.x + dx, y: v.y + dy }, true)
    return true
  }

  // ----- actions
  const close = () => {
    useLightbox.getState().setMode('view')
    usePanels.getState().setExpanded(null)
  }
  const go = (target: string | null) => {
    if (!target) return
    useLightbox.getState().setMode('view')
    usePanels.getState().setExpanded(target)
    useSelection.getState().select([target])
  }
  const [busy, setBusy] = useState(false)
  const run = async (task: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try {
      await task()
    } finally {
      setBusy(false)
    }
  }
  const saveOriginal = () => blob && run(() => downloadBlob(blob, name, mime, boardId))
  const saveEdited = () => blob && run(() => downloadEdited(blob, name, t, iw, ih, boardId))
  const openInTab = () => {
    if (!blob) return
    // Opened inside the click: browsers block tabs opened after an await.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    void run(async () => {
      if (!(await openImageInTab(blob, mime, iw, ih, boardId, tab))) tab?.close()
    })
  }
  const applyCrop = (next: ImageTransform) => {
    const m = getCardMap(doc, id)
    if (m && !readOnly) {
      const current = readImageTransform(readCard(m), iw, ih)
      if (!sameTransform(current, next)) {
        // One undo step of its own, even right after another edit.
        ctx.undo.stopCapturing()
        updateCard(doc, id, transformFields(next), getUser().id)
        ctx.undo.stopCapturing()
      }
    }
    if (useLightbox.getState().cropReturn === 'close') close()
    else useLightbox.getState().setMode('view')
  }

  // ----- keyboard: one capture listener, so board shortcuts never act behind the dialog
  const latest = useRef({ close, go, prevId, nextId, zoomAt, actualSize, setView, panBy, stage, cropping, readOnly, ctx })
  useEffect(() => {
    latest.current = { close, go, prevId, nextId, zoomAt, actualSize, setView, panBy, stage, cropping, readOnly, ctx }
  })
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      const l = latest.current
      // Nothing behind the dialog may react; default actions (activating buttons) still happen.
      e.stopPropagation()
      if (e.key === 'Tab') {
        menu.current?.close(false)
        trapFocus(e, dialogRef.current)
        return
      }
      if (l.cropping) {
        cropKeys.current?.(e)
        return
      }
      if (menu.current?.handleKey(e)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        l.close()
        return
      }
      const mod = e.ctrlKey || e.metaKey
      if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
        // After applying a crop from the viewer, undo works here too.
        e.preventDefault()
        if (l.readOnly) return
        if (e.shiftKey) l.ctx.undo.redo()
        else l.ctx.undo.undo()
        return
      }
      if (mod || e.altKey) return
      // Zoomed in past the stage, the arrows look around the picture (left and right only when it is
      // wider than the stage); Page Up / Down always change images.
      const pan = ARROW_PAN[e.key]
      if (pan) {
        const step = e.shiftKey ? KEY_PAN_BIG : KEY_PAN
        if (l.panBy(pan[0] * l.stage.w * step, pan[1] * l.stage.h * step)) {
          e.preventDefault()
          return
        }
      }
      switch (e.key) {
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault()
          l.go(l.prevId)
          return
        case 'ArrowRight':
        case 'PageDown':
          e.preventDefault()
          l.go(l.nextId)
          return
        case '+':
        case '=':
          e.preventDefault()
          l.zoomAt(KEY_ZOOM, undefined, true)
          return
        case '-':
        case '_':
          e.preventDefault()
          l.zoomAt(1 / KEY_ZOOM, undefined, true)
          return
        case '0':
          e.preventDefault()
          l.setView(null, true)
          return
        case '1':
          e.preventDefault()
          l.actualSize()
      }
    }
    const swallow = (e: Event) => e.stopPropagation()
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('paste', swallow, true)
    window.addEventListener('cut', swallow, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('paste', swallow, true)
      window.removeEventListener('cut', swallow, true)
      if (previous && previous.isConnected) previous.focus?.()
    }
  }, [])

  // Focus the viewer on open and when coming back from the cropper (which focuses its crop box itself).
  useEffect(() => {
    if (cropping) return
    const active = document.activeElement
    if (!active || !dialogRef.current?.contains(active) || active === document.body) closeRef.current?.focus()
  }, [cropping])

  // Wheel zoom needs a non-passive listener to keep the browser from zooming the page.
  useEffect(() => {
    const el = stageNode
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const r = el.getBoundingClientRect()
      latest.current.zoomAt(wheelFactor(e.deltaY, e.deltaMode), { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [stageNode])

  // Drag to pan; two pointers pinch. Every move is measured from where the gesture started, so moves
  // that arrive before React has rendered the previous one are not lost.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{
    start: ZoomState
    x: number
    y: number
    /** Pinching: finger distance and midpoint when it started; 0 while panning. */
    dist: number
    mid: { x: number; y: number }
    moved: boolean
    /** Pressed on the empty stage around the picture, where a plain click closes. */
    onBackdrop: boolean
  } | null>(null)
  const stagePoint = (x: number, y: number) => {
    const r = stageEl.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 }
  }
  const pinchInfo = () => {
    const [a, b] = Array.from(pointers.current.values())
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2) }
  }
  /** (Re)starts the gesture from the pointers that are down now and the current view. */
  const restartGesture = (x: number, y: number, moved: boolean, onBackdrop: boolean) => {
    const p = pointers.current.size >= 2 ? pinchInfo() : { dist: 0, mid: { x: 0, y: 0 } }
    gesture.current = { start: viewRef.current, x, y, dist: p.dist, mid: p.mid, moved, onBackdrop }
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const first = pointers.current.size === 0
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    // Read before capturing: every later event of this pointer targets the stage itself.
    const onBackdrop = first && e.target === e.currentTarget
    e.currentTarget.setPointerCapture(e.pointerId)
    // A second finger is never a click.
    restartGesture(e.clientX, e.clientY, !first || (gesture.current?.moved ?? false), onBackdrop)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g || !pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size >= 2) {
      const p = pinchInfo()
      if (g.dist > 0) {
        // Zoom about where the pinch started, then follow its midpoint.
        const z = zoomAround(g.start, p.dist / g.dist, g.mid, limits)
        setView({ ...z, x: z.x + p.mid.x - g.mid.x, y: z.y + p.mid.y - g.mid.y })
      }
      g.moved = true
      return
    }
    const dx = e.clientX - g.x
    const dy = e.clientY - g.y
    if (!g.moved && Math.hypot(dx, dy) < 4) return
    g.moved = true
    if (canPan(g.start, content, stage)) setView({ ...g.start, x: g.start.x + dx, y: g.start.y + dy })
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    const g = gesture.current
    if (!g) return
    if (pointers.current.size === 0) {
      gesture.current = null
      // A plain click on the backdrop closes. Clicks on the picture do not: double-click zooms it.
      if (!g.moved && g.onBackdrop && e.type === 'pointerup') close()
      return
    }
    // A finger lifted mid-pinch: carry on (as a pan when one is left) from the view as it is now.
    const [rest] = Array.from(pointers.current.values())
    restartGesture(rest.x, rest.y, true, false)
  }
  const onDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    if (isFit) actualSize(stagePoint(e.clientX, e.clientY))
    else setView(null, true)
  }

  const style = transformStyle(t, iw, ih)
  const shown = croppedPixelSize(t, iw, ih)
  const zoomPercent = Math.round(view.scale * 100)
  const helpId = useId()

  return createPortal(
    <div
      ref={dialogRef}
      className={`lightbox${cropping ? ' is-cropping' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={cropping ? `Crop ${label}` : label}
      aria-describedby={cropping ? undefined : helpId}
      onPointerDown={stop}
      onPointerUp={stop}
      onPointerMove={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onDragEnter={refuseStrayDrop}
      onDragOver={refuseStrayDrop}
      onDrop={refuseStrayDrop}
    >
      {cropping ? (
        <ImageCropper
          key={id}
          src={full.url ?? small.url}
          name={name}
          iw={iw}
          ih={ih}
          initial={t}
          keys={cropKeys}
          waiting={
            unavailable ? (
              <div className="lightbox__waiting">
                <BlobWaiting kind="image" />
              </div>
            ) : (
              <LoaderCircle size={28} className="media-spin lightbox__spinner" aria-label="Loading image" />
            )
          }
          onApply={applyCrop}
          onCancel={() => useLightbox.getState().setMode('view')}
          onClose={close}
          onNaturalSize={(loaded, w, h) => {
            if (loaded === full.url) setNatural({ src: loaded, w, h })
          }}
        />
      ) : (
        <>
          <p id={helpId} className="media-visually-hidden">
            Left and right arrows show the previous and next image. Plus and minus zoom, 0 fits the picture to the screen, 1 shows
            it at actual size. When the picture is larger than the screen, drag it or use the arrow keys to look around (Shift for
            larger steps), and Page Up and Page Down change images. Escape closes.
          </p>
          <div className="lightbox__bar">
            <div className="lightbox__title">
              <span className="lightbox__name" title={name}>
                {name}
              </span>
              {shown.w > 0 && (
                <span className="lightbox__dims" title={transformed ? `Original ${Math.round(iw)} × ${Math.round(ih)}` : undefined}>
                  {Math.round(shown.w)} × {Math.round(shown.h)}
                </span>
              )}
              {alt && <AltBadge alt={alt} />}
            </div>
            <div className="lightbox__actions">
              {index >= 0 && order.length > 1 && (
                <span className="lightbox__count" aria-label={`Image ${index + 1} of ${order.length}`}>
                  {index + 1} / {order.length}
                </span>
              )}
              <div className="lightbox__zoom" role="group" aria-label={`Zoom ${zoomPercent}%`}>
                <button type="button" className="lightbox__btn" onClick={() => setView(null, true)} aria-pressed={isFit} title="Fit to screen (0)">
                  Fit
                </button>
                <button type="button" className="lightbox__btn" onClick={() => actualSize()} aria-pressed={!isFit && Math.abs(view.scale - 1) < 0.005} title="Actual size (1)">
                  100%
                </button>
              </div>
              {!readOnly && (
                <button
                  type="button"
                  className="lightbox__btn"
                  onClick={() => useLightbox.getState().startCrop()}
                  disabled={!blob}
                  aria-label="Crop and rotate"
                  title="Crop and rotate"
                >
                  <Crop size={16} aria-hidden />
                  <span className="lightbox__label">Crop</span>
                </button>
              )}
              {transformed ? (
                <DownloadMenu ref={menu} disabled={!blob} busy={busy} onOriginal={saveOriginal} onEdited={saveEdited} />
              ) : (
                <button type="button" className="lightbox__btn" onClick={saveOriginal} disabled={!blob || busy} aria-label="Download original" title="Download original">
                  {busy ? <LoaderCircle size={16} className="media-spin" aria-hidden /> : <Download size={16} aria-hidden />}
                  <span className="lightbox__label">Download</span>
                </button>
              )}
              {!desktop && (
                <button type="button" className="lightbox__btn" onClick={openInTab} disabled={!blob || busy} aria-label="Open in new tab" title="Open in new tab">
                  <ExternalLink size={16} aria-hidden />
                  <span className="lightbox__label">Open in new tab</span>
                </button>
              )}
              <button ref={closeRef} type="button" className="lightbox__btn lightbox__btn--icon" onClick={close} aria-label="Close" title="Close (Esc)">
                <X size={18} aria-hidden />
              </button>
            </div>
          </div>
          <div
            ref={stageRef}
            className={`lightbox__stage${pannable ? ' can-pan' : ''}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={onDoubleClick}
          >
            {src ? (
              <div
                className={`lightbox__picture${animate ? ' is-animated' : ''}`}
                style={{
                  width: content.w * view.scale,
                  height: content.h * view.scale,
                  transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px)`,
                }}
              >
                <div className="lightbox__frame">
                  <div className="lightbox__inner" style={style.inner}>
                    <img
                      className="lightbox__img"
                      src={src}
                      alt={label}
                      draggable={false}
                      style={style.img}
                      onLoad={(e) => {
                        const img = e.currentTarget
                        if (img.src === full.url) setNatural({ src: img.src, w: img.naturalWidth, h: img.naturalHeight })
                      }}
                    />
                  </div>
                </div>
              </div>
            ) : unavailable ? (
              <div className="lightbox__waiting">
                <BlobWaiting kind="image" />
              </div>
            ) : (
              <LoaderCircle size={28} className="media-spin lightbox__spinner" aria-label="Loading image" />
            )}
            {prevId && (
              <button type="button" className="lightbox__nav lightbox__nav--prev" onClick={() => go(prevId)} aria-label="Previous image" title="Previous image">
                <ChevronLeft size={22} aria-hidden />
              </button>
            )}
            {nextId && (
              <button type="button" className="lightbox__nav lightbox__nav--next" onClick={() => go(nextId)} aria-label="Next image" title="Next image">
                <ChevronRight size={22} aria-hidden />
              </button>
            )}
          </div>
          {caption && captionShown && (
            <div className="lightbox__caption">
              <RichText fragment={caption} editing={false} variant="caption" readOnly className="lightbox__caption-text" />
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  )
}

/** Text badge (not an icon-only cue) that shows the alt text on hover, focus or press. */
function AltBadge({ alt }: { alt: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span className="lightbox__alt">
      <button
        type="button"
        className="lightbox__alt-badge"
        aria-describedby="lightbox-alt-text"
        aria-expanded={open}
        title={alt}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
      >
        ALT
      </button>
      <span id="lightbox-alt-text" role="tooltip" className={`lightbox__alt-text${open ? ' is-open' : ''}`}>
        {alt}
      </span>
    </span>
  )
}

interface DownloadMenuHandle {
  /** Handles a keydown while the menu is open; true when it did. */
  handleKey: (e: KeyboardEvent) => boolean
  close: (focusButton: boolean) => void
}

/** "Download" with a choice of the original file or the edited (cropped, rotated) picture. */
function DownloadMenu({
  ref,
  disabled,
  busy,
  onOriginal,
  onEdited,
}: {
  ref: React.RefObject<DownloadMenuHandle | null>
  disabled: boolean
  busy: boolean
  onOriginal: () => void
  onEdited: () => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const items = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  const closeMenu = (focusButton: boolean) => {
    setOpen(false)
    if (focusButton) buttonRef.current?.focus()
  }
  useEffect(() => {
    ref.current = {
      close: (focusButton) => {
        if (open) closeMenu(focusButton)
      },
      handleKey: (e) => {
        if (!open) return false
        const list = items()
        const at = list.indexOf(document.activeElement as HTMLButtonElement)
        if (e.key === 'Escape') {
          e.preventDefault()
          closeMenu(true)
          return true
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length
          list[next]?.focus()
          return true
        }
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          list[e.key === 'Home' ? 0 : list.length - 1]?.focus()
          return true
        }
        // Image navigation and zoom keys are not for the menu.
        return e.key.startsWith('Arrow')
      },
    }
  })
  useEffect(() => {
    if (open) items()[0]?.focus()
  }, [open])
  // A press anywhere else closes the menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!listRef.current?.contains(t) && !buttonRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const choose = (fn: () => void) => {
    closeMenu(true)
    fn()
  }
  return (
    <div className="lightbox__menu-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="lightbox__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen((o) => !o)}
        aria-label="Download"
        title="Download"
      >
        {busy ? <LoaderCircle size={16} className="media-spin" aria-hidden /> : <Download size={16} aria-hidden />}
        <span className="lightbox__label">Download</span>
        <ChevronDown size={14} aria-hidden />
      </button>
      {open && (
        <div ref={listRef} className="lightbox__menu" role="menu" aria-label="Download">
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={() => choose(onEdited)}>
            Edited picture
            <span className="lightbox__menu-hint">As shown, cropped and rotated</span>
          </button>
          <button type="button" role="menuitem" className="lightbox__menu-item" onClick={() => choose(onOriginal)}>
            Original file
            <span className="lightbox__menu-hint">Full image, as it was added</span>
          </button>
        </div>
      )}
    </div>
  )
}

function trapFocus(e: KeyboardEvent, root: HTMLElement | null) {
  if (!root) return
  const items = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault()
    first.focus()
  }
}
