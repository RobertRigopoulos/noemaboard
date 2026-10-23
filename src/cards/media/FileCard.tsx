import { useEffect, useMemo, useState } from 'react'
import {
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  LoaderCircle,
  Play,
  type LucideIcon,
} from 'lucide-react'
import type { CardProps } from '../types'
import type { FileCard as FileCardData } from '../../model/types'
import { useBoard } from '../../board/BoardContext'
import { useBlobUrl } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { desktop } from '../../lib/desktop'
import { asText, cleanFileName, fileExtension, fileKind, formatBytes, typeLabel, type FileKind } from './format'
import { BlobWaiting, positive, stopPointer, useBlobPresence } from './common'
import { downloadBlob, openPdfInTab } from './download'
import { reportBlob } from './blobAvailability'
import './actions'
import './media.css'

const KIND_ICON: Record<FileKind, LucideIcon> = {
  pdf: FileText,
  image: FileImage,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  spreadsheet: FileSpreadsheet,
  document: FileText,
  other: FileIcon,
}

/** Files up to this size are pulled from teammates as soon as the card is shown. */
const AUTO_FETCH_BYTES = 25 * 1024 * 1024

/** Whether this browser can play a media type inline (e.g. no MKV/AVI in most browsers). */
function canPlay(kind: FileKind, mime: string): boolean {
  if ((kind !== 'audio' && kind !== 'video') || typeof document === 'undefined') return false
  try {
    return document.createElement(kind).canPlayType(mime) !== ''
  } catch {
    return false
  }
}

/** File card: type icon, name, size and a download button; audio and video play inline. */
export function FileCard({ card }: CardProps<FileCardData>) {
  const { boardId } = useBoard()
  const hash = isValidBlobHash(card.blob) ? card.blob : null
  const name = cleanFileName(asText(card.name, 255), 'Untitled file')
  const mime = asText(card.mime, 100).toLowerCase()
  const size = positive(card.size)
  const kind = fileKind(mime, name)
  const Icon = KIND_ICON[kind]
  const playable = useMemo(() => canPlay(kind, mime), [kind, mime])

  const [requested, setRequested] = useState(false)
  const presence = useBlobPresence(hash, boardId, requested || size <= AUTO_FETCH_BYTES)
  const media = useBlobUrl(playable && presence === 'local' ? hash : null, boardId)
  useEffect(() => {
    if (presence === 'local') reportBlob(hash, 'local')
    else if (presence === 'missing') reportBlob(hash, 'missing')
  }, [hash, presence])

  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!hash || saving) return
    setSaving(true)
    setRequested(true)
    await downloadBlob(hash, name, mime, boardId)
    setSaving(false)
  }

  // A real PDF name, not just a PDF type claimed by whoever added the file. In the browser it opens
  // in the browser's PDF viewer; the desktop app (no viewer in the window) saves it like any file.
  const canOpenPdf = kind === 'pdf' && fileExtension(name) === 'pdf' && !desktop
  const openPdf = async () => {
    if (!hash || saving) return
    // Opened right away, inside the click: browsers block tabs opened after an await.
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    setSaving(true)
    setRequested(true)
    const ok = await openPdfInTab(hash, boardId, tab)
    if (!ok) tab?.close()
    setSaving(false)
  }
  const meta = [typeLabel(name, mime), size ? formatBytes(size) : null].filter(Boolean).join(' · ')

  return (
    <div className="file-card" data-kind={kind}>
      <div className="file-card__row">
        <div className="file-card__icon" aria-hidden>
          <Icon size={20} strokeWidth={1.75} />
        </div>
        <div className="file-card__text">
          <div className="file-card__name" title={name}>
            {name}
          </div>
          <div className="file-card__meta">
            {meta}
            {presence === 'remote' && <span className="file-card__where"> · on a teammate’s device</span>}
          </div>
        </div>
        {canOpenPdf ? (
          <button
            type="button"
            className="file-card__open"
            onPointerDown={stopPointer}
            onClick={openPdf}
            disabled={!hash || saving}
            aria-label={`Open ${name}`}
            title="Open in a new tab"
          >
            {saving ? <LoaderCircle size={14} className="media-spin" aria-hidden /> : 'Open'}
          </button>
        ) : (
          <button
            type="button"
            className="media-icon-btn"
            onPointerDown={stopPointer}
            onClick={save}
            disabled={!hash || saving}
            aria-label={`Download ${name}`}
            title="Download"
          >
            {saving ? <LoaderCircle size={16} className="media-spin" aria-hidden /> : <Download size={16} aria-hidden />}
          </button>
        )}
      </div>

      {playable && presence === 'remote' && (
        <button type="button" className="file-card__load" onPointerDown={stopPointer} onClick={() => setRequested(true)}>
          <Play size={14} aria-hidden />
          <span>Load {kind === 'video' ? 'video' : 'audio'} ({formatBytes(size)})</span>
        </button>
      )}
      {playable && media.url && kind === 'audio' && (
        <audio className="file-card__audio no-drag" controls preload="metadata" src={media.url}>
        </audio>
      )}
      {playable && media.url && kind === 'video' && (
        <video className="file-card__video no-drag" controls preload="metadata" playsInline src={media.url}>
        </video>
      )}
      {(presence === 'fetching' || (playable && presence === 'local' && media.state === 'loading')) && (
        <div className="file-card__status" role="status">
          <LoaderCircle size={14} className="media-spin" aria-hidden />
          <span>Loading…</span>
        </div>
      )}
      {presence === 'missing' && (
        <div className="file-card__missing">
          <BlobWaiting kind={kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'file'} compact />
        </div>
      )}
    </div>
  )
}
