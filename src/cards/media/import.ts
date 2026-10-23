/**
 * Turning outside content into cards: files and images (drop or paste), dragged web images,
 * URLs and plain text. Bytes go to the blob store; the doc only ever receives their SHA-256.
 */
import type * as Y from 'yjs'
import { createCard, LOCAL_ORIGIN } from '../../model/board'
import { MAX_BLOB_BYTES, putBlob } from '../../collab/blobs'
import { getUser } from '../../collab/identity'
import { desktop } from '../../lib/desktop'
import { toast } from '../../ui/toast'
import { useSelection, useView } from '../../board/store'
import { snap } from '../../board/actions'
import { processImageFile } from './image'
import { dataUrlToBlob } from './imageMeta'
import { centerGroup, gridLayout, imageCardHeight, imageCardWidth, type Box } from './layout'
import { cleanFileName, fileKind, formatBytes, guessMime } from './format'
import { extractSingleUrl, looksLikeImageUrl, normalizeUrl, parseUriList } from './url'
import { createLinkCard, createNoteFromText, prepareNoteText, MAX_NOTE_CHARS } from './create'
import { requestPreview } from './preview'
import { mapLimit, withTimeout } from './async'
import { columnAt, placeInColumn } from './columnTarget'
import { createRichNote } from '../../editor/richNote'

type Point = { x: number; y: number }

/** More files than this in one go are almost always a mistake (a whole folder of photos...). */
export const MAX_FILES_PER_IMPORT = 60
/** Images dragged in from web pages. */
const MAX_REMOTE_IMAGE_BYTES = 25 * 1024 * 1024
const REMOTE_IMAGE_TIMEOUT_MS = 20_000
const FILE_CARD_WIDTH = 300

/** True if a drag carries files from the OS (or a URL / text that can become a card). */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain')
}

/** Creates image/file/link/note cards from a drop at board position `at`. Resolves with the new card ids. */
export async function handleCanvasDrop(doc: Y.Doc, dt: DataTransfer, at: { x: number; y: number }): Promise<string[]> {
  // A DataTransfer is only readable while the drop event is dispatched: copy everything first.
  const { files, folders } = readDroppedFiles(dt)
  const text: DroppedText = { uriList: getData(dt, 'text/uri-list'), text: getData(dt, 'text/plain'), html: getData(dt, 'text/html') }
  const slot = columnAt(doc, at)
  if (folders) toast(folders === 1 ? 'Folders can’t be added. Drop the files inside it instead.' : 'Folders were skipped. Drop the files inside them instead.')
  try {
    const ids = files.length ? await importFiles(doc, files, at) : await importText(doc, text, at)
    placeInColumn(doc, ids, slot, getUser().id)
    return ids
  } catch (err) {
    console.error('Drop import failed', err)
    toast('Couldn’t add what you dropped', 'error')
    return []
  }
}

// ---------------------------------------------------------------------------
// Files

export interface ImportOptions {
  /** Select the new cards when their board is open (default true). */
  select?: boolean
  /** Centre the group on `at` instead of using it as the top-left corner (toolbar uploads). */
  center?: boolean
}

interface PreparedCard {
  type: 'image' | 'file'
  fields: Record<string, unknown>
  box: Box
  /** An HEIC/HEIF photo this browser could not decode (Chrome, Edge, the desktop app): added as a file. */
  heicAsFile?: boolean
}

/** iPhone photos. Safari decodes them; Chromium-based browsers and the desktop app cannot. */
export function isHeic(mime: string, name: string): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(mime) || /\.hei[cf]$/i.test(name)
}

/** Message for HEIC photos that became file cards, or null when there were none. */
export function heicNotice(names: string[]): string | null {
  if (!names.length) return null
  const why = 'this browser can’t show HEIC photos. To see them on the board, export them as JPEG (or open the board in Safari).'
  return names.length === 1 ? `“${names[0]}” was added as a file: ${why}` : `${names.length} photos were added as files: ${why}`
}

/**
 * Stores files in the blob store and creates one card per file, laid out in a 3-column masonry grid
 * starting at `at`. Images become image cards (very large ones are stored downscaled), everything
 * else becomes a file card. Resolves with the created ids (also selected).
 */
export async function importFiles(doc: Y.Doc, files: Iterable<Blob>, at: Point, opts: ImportOptions = {}): Promise<string[]> {
  const all = Array.from(files)
  if (!all.length) return []
  const list = all.slice(0, MAX_FILES_PER_IMPORT)
  if (all.length > list.length) toast(`Only the first ${MAX_FILES_PER_IMPORT} files were added`, 'info', 6000)

  const tooBig = list.filter((f) => f.size > MAX_BLOB_BYTES)
  if (tooBig.length) {
    const limit = formatBytes(MAX_BLOB_BYTES)
    toast(
      tooBig.length === 1
        ? `“${displayName(tooBig[0])}” is larger than ${limit} and can’t be added`
        : `${tooBig.length} files are larger than ${limit} and were skipped`,
      'error',
      6000,
    )
  }
  const accepted = list.filter((f) => f.size <= MAX_BLOB_BYTES)
  if (!accepted.length) return []

  const total = accepted.reduce((n, f) => n + f.size, 0)
  if (accepted.length > 4 || total > 20 * 1024 * 1024) {
    toast(accepted.length === 1 ? `Adding “${displayName(accepted[0])}”…` : `Adding ${accepted.length} files…`, 'info', 3000)
  }

  const failed: string[] = []
  let quota = false
  const prepared = await mapLimit(accepted, 2, async (file) => {
    try {
      return await prepareFile(file, doc.guid)
    } catch (err) {
      console.warn('Import failed for', displayName(file), err)
      if (err instanceof DOMException && err.name === 'QuotaExceededError') quota = true
      failed.push(displayName(file))
      return null
    }
  })
  if (quota) toast('Not enough storage space on this device to add these files', 'error', 6000)
  else if (failed.length) toast(failed.length === 1 ? `Couldn’t add “${failed[0]}”` : `Couldn’t add ${failed.length} files`, 'error', 6000)

  const ready = prepared.filter((p): p is PreparedCard => p !== null)
  const heic = heicNotice(ready.filter((p) => p.heicAsFile).map((p) => String(p.fields.name)))
  if (heic) toast(heic, 'info', 9000)
  if (!ready.length || doc.isDestroyed) return []
  const boxes = ready.map((p) => p.box)
  const grid = gridLayout(boxes, at)
  const positions = opts.center ? centerGroup(grid, boxes, at) : grid
  const userId = getUser().id
  const ids: string[] = []
  doc.transact(() => {
    ready.forEach((p, i) => ids.push(createCard(doc, p.type, { ...p.fields, ...positions[i] }, userId)))
  }, LOCAL_ORIGIN)
  if (opts.select !== false) selectIfOpen(doc, ids)
  return ids
}

/** Browsers we target cannot decode these, so skip straight to a file card. */
const UNDECODABLE_IMAGES = /^image\/(tiff|vnd\.adobe\.photoshop|x-photoshop|x-xcf|x-raw|x-canon|x-nikon|x-sony|x-adobe-dng)/

async function prepareFile(file: Blob, boardId: string): Promise<PreparedCard> {
  const name = displayName(file)
  const mime = guessMime(name, file.type)
  // Some systems report no MIME type; the blob store keys the type off the Blob itself.
  const typed = file.type === mime ? file : new Blob([file], { type: mime })

  if (mime.startsWith('image/') && !UNDECODABLE_IMAGES.test(mime)) {
    const img = await processImageFile(typed, name).catch(() => null)
    if (img) {
      const stored = await putBlob(img.blob, boardId)
      const thumb = img.thumb ? ((await putBlob(img.thumb, boardId).catch(() => null))?.hash ?? null) : null
      const w = imageCardWidth(img.iw)
      return {
        type: 'image',
        fields: { blob: stored.hash, mime: stored.mime, name, iw: img.iw, ih: img.ih, w, thumb },
        box: { w, h: imageCardHeight(w, img.iw, img.ih) },
      }
    }
  }

  const stored = await putBlob(typed, boardId)
  const kind = fileKind(mime, name)
  const h = kind === 'audio' ? 130 : kind === 'video' ? 250 : 70
  return {
    type: 'file',
    fields: { blob: stored.hash, name, size: stored.size, mime: stored.mime, w: FILE_CARD_WIDTH },
    box: { w: FILE_CARD_WIDTH, h },
    heicAsFile: isHeic(mime, name),
  }
}

function displayName(file: Blob): string {
  const raw = typeof File !== 'undefined' && file instanceof File ? file.name : ''
  return cleanFileName(raw, file.type.startsWith('image/') ? 'Image' : 'Untitled file')
}

function readDroppedFiles(dt: DataTransfer): { files: File[]; folders: number } {
  const files: File[] = []
  let folders = 0
  const items = dt.items ? Array.from(dt.items) : []
  if (items.length) {
    for (const item of items) {
      if (item.kind !== 'file') continue
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
      if (entry?.isDirectory) {
        folders++
        continue
      }
      const f = item.getAsFile()
      if (f) files.push(f)
    }
    return { files, folders }
  }
  return { files: Array.from(dt.files ?? []), folders }
}

function getData(dt: DataTransfer, type: string): string {
  try {
    return dt.getData(type) || ''
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// URLs and text

export interface DroppedText {
  uriList: string
  text: string
  html: string
}

/**
 * Text content from a drop or paste: a dragged web image becomes an image card, URLs become link
 * cards, anything else becomes a note (one paragraph per line).
 */
export async function importText(doc: Y.Doc, data: DroppedText, at: Point): Promise<string[]> {
  const urls = parseUriList(data.uriList)
  const imgSrc = firstImageSrc(data.html)

  // Inline images (data: URLs) dragged from pages or other apps. A picture inside formatted text that
  // also has words is part of that text, not the thing being added.
  const htmlImage = !data.text.trim() || /^data:image\//i.test(data.text.trim()) ? (imgSrc ?? '') : ''
  const dataUrl = [data.uriList.trim(), htmlImage].find((s) => /^data:image\//i.test(s))
  if (!urls.length && dataUrl) {
    const blob = dataUrlToBlob(dataUrl, MAX_REMOTE_IMAGE_BYTES)
    if (blob) return importFiles(doc, [namedFile(blob, 'Image')], at)
  }

  // A web image dragged from another page: try to bring the picture itself.
  if (urls.length === 1) {
    const url = urls[0]
    const fromImg = imgSrc ? normalizeUrl(decodeEntities(imgSrc)) === url : false
    if (fromImg || (!data.html && looksLikeImageUrl(url))) {
      const blob = await fetchRemoteImage(url)
      if (blob) return importFiles(doc, [namedFile(blob, nameFromUrl(url))], at)
    }
  }

  if (urls.length) return createLinks(doc, urls, at)
  const single = extractSingleUrl(data.text)
  if (single) return createLinks(doc, [single], at)
  if (!data.text.trim()) return []
  // Formatted text (HTML or Markdown) becomes a note that keeps its formatting.
  let rich: string | null = null
  try {
    rich = createRichNote(doc, { html: data.html || null, text: data.text }, { x: snap(at.x), y: snap(at.y) }, getUser().id)
  } catch (err) {
    // Malformed markup must not lose the text: it still becomes a plain note.
    console.warn('Formatted paste failed, adding plain text', err)
  }
  if (rich) {
    selectIfOpen(doc, [rich])
    return [rich]
  }
  return createNote(doc, data.text, at)
}

/** Creates link cards (grid laid out) and starts their previews. */
export function createLinks(doc: Y.Doc, urls: string[], at: Point): string[] {
  const userId = getUser().id
  const positions = gridLayout(
    urls.map(() => ({ w: 300, h: 120 })),
    at,
  )
  const ids: string[] = []
  doc.transact(() => {
    urls.forEach((url, i) => ids.push(createLinkCard(doc, url, positions[i], userId)))
  }, LOCAL_ORIGIN)
  for (const id of ids) requestPreview(doc, id)
  selectIfOpen(doc, ids)
  return ids
}

/** Creates a note holding plain text (line breaks preserved). */
export function createNote(doc: Y.Doc, text: string, at: Point): string[] {
  const { truncated } = prepareNoteText(text)
  const id = createNoteFromText(doc, text, { x: snap(at.x), y: snap(at.y) }, getUser().id)
  if (!id) return []
  if (truncated) toast(`The text was cut to ${MAX_NOTE_CHARS.toLocaleString()} characters`, 'info', 6000)
  selectIfOpen(doc, [id])
  return [id]
}

function selectIfOpen(doc: Y.Doc, ids: string[]) {
  if (!ids.length || useView.getState().boardId !== doc.guid) return
  const sel = useSelection.getState()
  if (sel.editing) sel.setEditing(null)
  sel.select(ids)
}

function namedFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type })
}

function firstImageSrc(html: string): string | null {
  if (!html || !/<img\b/i.test(html)) return null
  const m = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(html)
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|quot|#39|apos|lt|gt);/g, (_, e: string) => ({ amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' })[e] ?? _)
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
    return cleanFileName(decodeURIComponent(last), 'Image')
  } catch {
    return 'Image'
  }
}

/** Fetches a dragged web image: via the desktop app, or directly when the site allows it (CORS). */
async function fetchRemoteImage(url: string): Promise<Blob | null> {
  try {
    if (desktop) {
      const r = await withTimeout(desktop.fetchImage(url), REMOTE_IMAGE_TIMEOUT_MS)
      if (!r || typeof r !== 'object' || typeof r.mime !== 'string') return null
      const raw: unknown = r.bytes
      const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null
      const mime = r.mime.split(';')[0].trim().toLowerCase()
      if (!bytes || !bytes.byteLength || !mime.startsWith('image/') || bytes.byteLength > MAX_REMOTE_IMAGE_BYTES) return null
      return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), REMOTE_IMAGE_TIMEOUT_MS)
    try {
      const res = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal })
      if (!res.ok) return null
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
      if (!type.startsWith('image/')) return null
      if (Number(res.headers.get('content-length') ?? 0) > MAX_REMOTE_IMAGE_BYTES) return null
      const blob = await res.blob()
      if (blob.size === 0 || blob.size > MAX_REMOTE_IMAGE_BYTES) return null
      return blob.type === type ? blob : new Blob([blob], { type })
    } finally {
      clearTimeout(timer)
    }
  } catch {
    // CORS refusal, network error, timeout: the caller falls back to a link card.
    return null
  }
}
