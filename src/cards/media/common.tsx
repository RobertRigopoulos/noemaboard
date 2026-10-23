/** Pieces shared by image, file and link cards. */
import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { CloudOff } from 'lucide-react'
import { useBoard, useYVersion } from '../../board/BoardContext'
import { ensureFragment, xmlToText } from '../../model/board'
import type { CardMap } from '../../model/types'
import { getBlob, hasBlob } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { RichText } from '../../editor/RichText'
import { importBelowCard } from './importBelow'
import './media.css'

export { positive } from './numbers'

/** Shown while a blob is not on this device and no connected peer has it yet. */
export function BlobWaiting({ kind, compact = false }: { kind: 'image' | 'file' | 'video' | 'audio'; compact?: boolean }) {
  const what = kind === 'image' ? 'image' : kind === 'video' ? 'video' : kind === 'audio' ? 'audio file' : 'file'
  return (
    <div className={`media-waiting${compact ? ' media-waiting--compact' : ''}`} role="status">
      <CloudOff size={compact ? 16 : 20} strokeWidth={1.75} aria-hidden />
      <span>Waiting for a teammate who has this {what} to come online</span>
    </div>
  )
}

/** Loading placeholder with a soft shimmer; the parent decides its size. */
export function Shimmer({ label }: { label: string }) {
  return <div className="media-shimmer" role="status" aria-label={label} />
}

/**
 * Optional rich-text caption under images and links. Visible when it has text and is not hidden, or
 * while the card is being edited (then it is the live editor). Files pasted into it become cards below.
 */
export function Caption({
  cardId,
  map,
  editing,
  readOnly,
  hidden = false,
  autofocus = 'end',
  onExit,
}: {
  cardId: string
  map: CardMap
  editing: boolean
  readOnly: boolean
  /** captionHidden: the text is kept but not shown (except while editing). */
  hidden?: boolean
  /** Where the caret goes when editing starts; false leaves focus where it is (a link's address field). */
  autofocus?: 'start' | 'end' | false
  onExit: () => void
}) {
  const { doc } = useBoard()
  const raw = map.get('caption')
  const frag = raw instanceof Y.XmlFragment ? raw : null
  const version = useYVersion(frag)
  const hasText = useMemo(() => (frag ? fragmentHasText(frag) : false), [frag, version]) // eslint-disable-line react-hooks/exhaustive-deps

  // Cards from older or foreign clients may lack the fragment: create it when someone starts editing.
  useEffect(() => {
    if (editing && !frag && !readOnly) ensureFragment(doc, map, 'caption')
  }, [editing, frag, readOnly, doc, map])

  const live = editing && !readOnly
  if (!frag || (!live && (!hasText || hidden))) return null
  return (
    <div className="media-caption">
      <RichText
        fragment={frag}
        editing={live}
        variant="caption"
        placeholder="Add a caption…"
        readOnly={readOnly}
        autofocus={autofocus}
        onExit={onExit}
        cardId={cardId}
        onPasteFiles={(files) => void importBelowCard(doc, cardId, files)}
        className="media-caption__text"
      />
    </div>
  )
}

export function fragmentHasText(frag: Y.XmlFragment): boolean {
  if (!frag.length) return false
  return xmlToText(frag).trim().length > 0
}

export type BlobPresence = 'checking' | 'local' | 'remote' | 'fetching' | 'missing'

/**
 * Whether a blob is on this device. With `fetch` it is pulled from peers (retrying with backoff
 * while nobody has it); without, a blob that is not local just reports 'remote' so large files
 * are only transferred on demand.
 */
export function useBlobPresence(hash: string | null, boardId: string | null, fetch: boolean): BlobPresence {
  const [state, setState] = useState<{ hash: string | null; value: BlobPresence }>({ hash, value: 'checking' })
  useEffect(() => {
    if (!hash || !isValidBlobHash(hash)) {
      setState({ hash, value: 'missing' })
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const set = (value: BlobPresence) => {
      if (!cancelled) setState({ hash, value })
    }
    const attempt = async () => {
      try {
        if (await hasBlob(hash)) return set('local')
        if (cancelled) return
        if (!fetch) return set('remote')
        set(attempts === 0 ? 'fetching' : 'missing')
        const blob = await getBlob(hash, boardId)
        if (cancelled) return
        if (blob) return set('local')
      } catch {
        // storage errors: treat like "not available yet"
      }
      if (cancelled) return
      set('missing')
      attempts++
      timer = setTimeout(attempt, Math.min(30_000, 2000 * attempts))
    }
    void attempt()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [hash, boardId, fetch])
  return state.hash === hash ? state.value : 'checking'
}


/** Stops pointer events on in-card controls from starting a card drag. */
export const stopPointer = (e: React.PointerEvent) => e.stopPropagation()
