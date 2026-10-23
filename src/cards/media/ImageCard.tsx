import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { ImageOff, Maximize2 } from 'lucide-react'
import type { CardProps } from '../types'
import type { ImageCard as ImageCardData } from '../../model/types'
import { useBoard, useYVersion } from '../../board/BoardContext'
import { SYSTEM_ORIGIN, updateCard, xmlToText } from '../../model/board'
import { getUser } from '../../collab/identity'
import { useView } from '../../board/store'
import { useBlobUrl } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { asText } from './format'
import { BlobWaiting, Caption, positive, Shimmer, stopPointer } from './common'
import { THUMB_WIDTH } from './image'
import { displayAspect, readImageTransform, transformStyle } from './transform'
import { imageLabel, readAlt } from './altText'
import { readCaptionHidden } from './captionState'
import { reportBlob } from './blobAvailability'
import { openImage } from './lightboxStore'
import './actions'
import './media.css'

/** `thumb`: optional hash of a smaller rendition used on the board (added by import). */
type ImageData = ImageCardData & { thumb?: unknown }

/**
 * Image card: the picture at the card's width (height from the aspect of what it shows, after crop and
 * rotation), plus an optional caption. The lightbox is a board overlay (actions.tsx).
 */
export function ImageCard({ id, card, map, editing, readOnly, stopEditing }: CardProps<ImageData>) {
  const { boardId, doc } = useBoard()
  const data = card as unknown as Record<string, unknown>
  const blob = isValidBlobHash(card.blob) ? card.blob : null
  const thumb = isValidBlobHash(card.thumb) ? card.thumb : null
  const name = asText(card.name, 255) || 'Image'
  const iw = positive(card.iw)
  const ih = positive(card.ih)
  const t = readImageTransform(data, iw, ih)
  // Reserve the final height before any bytes arrive so the board layout never jumps.
  const ratio = displayAspect(t, iw, ih)
  const style = transformStyle(t, iw, ih)

  // A tight crop shows a small part of the picture large: the thumbnail would look blurry.
  const wantsFull = useWantsFullResolution(card.w / (t.crop?.w ?? 1))
  const small = useBlobUrl(thumb, boardId)
  const needFull = !thumb || wantsFull || small.state === 'missing'
  const full = useBlobUrl(needFull ? blob : null, boardId)
  const src = full.url ?? small.url
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const broken = !!src && failedSrc === src
  const status: 'ready' | 'loading' | 'missing' | 'broken' = broken
    ? 'broken'
    : src
      ? 'ready'
      : !blob
        ? 'missing'
        : needFull
          ? full.state === 'ready'
            ? 'loading'
            : full.state
          : small.state === 'ready'
            ? 'loading'
            : small.state

  // A hint for Ctrl+C (see blobAvailability); actions are not disabled by it.
  useEffect(() => {
    if (!needFull) return
    if (full.state === 'ready') reportBlob(blob, 'local')
    else if (full.state === 'missing') reportBlob(blob, 'missing')
  }, [needFull, blob, full.state])

  const raw = map.get('caption')
  const caption = raw instanceof Y.XmlFragment ? raw : null
  const captionVersion = useYVersion(caption)
  const captionText = useMemo(() => (caption && caption.length ? xmlToText(caption) : ''), [caption, captionVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const label = imageLabel(readAlt(data.alt), captionText, name)

  return (
    <div className={`image-card${editing ? ' is-editing' : ''}`}>
      <div className="image-card__frame" style={{ aspectRatio: String(ratio) }} data-state={status}>
        {src && !broken && (
          <div className="image-card__transform" style={style.inner}>
            <img
              className="image-card__img"
              src={src}
              alt={label}
              draggable={false}
              decoding="async"
              style={style.img}
              onError={() => setFailedSrc(src)}
              onLoad={(e) => {
                // Cards from older clients may lack their size; fill it in once so layout is stable for everyone.
                const img = e.currentTarget
                if ((iw && ih) || readOnly || img.src !== full.url || !img.naturalWidth || !img.naturalHeight) return
                updateCard(doc, id, { iw: img.naturalWidth, ih: img.naturalHeight }, getUser().id, SYSTEM_ORIGIN)
              }}
            />
          </div>
        )}
        {status === 'loading' && <Shimmer label="Loading image" />}
        {status === 'missing' && <BlobWaiting kind="image" compact={card.w < 220} />}
        {status === 'broken' && (
          <div className="image-card__broken" role="status">
            <ImageOff size={20} strokeWidth={1.75} aria-hidden />
            <span>This image can’t be displayed</span>
          </div>
        )}
        {status === 'ready' && (
          <div className={`image-card__tools${editing ? ' is-visible' : ''}`} onPointerDown={stopPointer}>
            <button
              type="button"
              className="media-tool"
              onClick={(e) => {
                e.stopPropagation()
                openImage(id, 'view')
              }}
              aria-label="View full size"
              title="View full size (Space)"
            >
              <Maximize2 size={14} aria-hidden />
            </button>
          </div>
        )}
      </div>
      <Caption cardId={id} map={map} editing={editing} readOnly={readOnly} hidden={readCaptionHidden(data)} onExit={stopEditing} />
    </div>
  )
}

/**
 * True once the card is shown larger than its thumbnail can render sharply (zoomed in, hi-DPI, or a
 * tight crop). Latches so zooming back out does not swap back and forth between renditions.
 */
function useWantsFullResolution(shownWidth: number): boolean {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const want = useView((s) => shownWidth * s.viewport.zoom * dpr > THUMB_WIDTH * 1.1)
  const [latched, setLatched] = useState(want)
  useEffect(() => {
    if (want) setLatched(true)
  }, [want])
  return want || latched
}
