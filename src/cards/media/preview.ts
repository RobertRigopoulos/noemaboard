/**
 * Link preview fetching. Runs only on the device responsible for the card (see previewPolicy), and
 * only for cards this device itself asked to preview (see previewClaims), and writes results with
 * SYSTEM_ORIGIN so they never land on the undo stack. Remote pages are only read through the desktop
 * app's SSRF-guarded main process; their HTML is never rendered, only the extracted, capped strings
 * and re-hosted images (as content-addressed blobs).
 */
import type * as Y from 'yjs'
import { getCards, SYSTEM_ORIGIN, updateCard } from '../../model/board'
import { getUser } from '../../collab/identity'
import { putBlob } from '../../collab/blobs'
import { desktop, type LinkPreview } from '../../lib/desktop'
import { cleanText } from './format'
import { hostLabel, isHttpUrl, normalizeUrl } from './url'
import { detectEmbed, sanitizeEmbed } from './embed'
import { isPreviewStale, needsPreview, type PreviewFields } from './previewPolicy'
import { claimPreview, hasPreviewClaim } from './previewClaims'
import { shrinkImage } from './image'
import { withTimeout } from './async'

const PAGE_TIMEOUT_MS = 25_000
const IMAGE_TIMEOUT_MS = 20_000
const MAX_PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_FAVICON_BYTES = 256 * 1024
/** Preview images are stored at most this wide (cards are ~300px; keeps P2P transfers small). */
const PREVIEW_IMAGE_WIDTH = 1200

const running = new Set<string>()

function fieldsOf(m: Y.Map<unknown>): PreviewFields {
  return {
    url: m.get('url'),
    previewState: m.get('previewState'),
    previewBy: m.get('previewBy'),
    previewFor: m.get('previewFor'),
    previewStartedAt: m.get('previewStartedAt'),
    createdBy: m.get('createdBy'),
    updatedAt: m.get('updatedAt'),
  }
}

/**
 * Starts a preview fetch for a link card if this device asked for it (claimed), is responsible for
 * it, and one is due. Called whenever a link card renders.
 */
export function maybeFetchPreview(doc: Y.Doc, id: string) {
  if (doc.isDestroyed) return
  const m = getCards(doc).get(id)
  if (!m || m.get('type') !== 'link') return
  const key = `${doc.guid}/${id}`
  if (running.has(key)) return
  const me = getUser().id
  const fields = fieldsOf(m)
  if (typeof fields.url !== 'string' || !hasPreviewClaim(doc.guid, id, fields.url)) return
  if (!needsPreview(fields, me, Date.now())) return
  const raw = fields.url
  const stale = isPreviewStale(fields)
  running.add(key)
  // The same person may have the board open in several tabs/windows: one fetch is enough.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  const task = locks
    ? locks.request(`noema-link-preview:${key}`, { ifAvailable: true }, (lock) => (lock ? run(doc, id, raw, me, stale) : undefined))
    : run(doc, id, raw, me, stale)
  void Promise.resolve(task)
    .catch((err) => console.warn('Link preview failed', err))
    .finally(() => running.delete(key))
}

/** Remembers that this device asked for the card's current URL to be previewed. */
function claim(doc: Y.Doc, id: string): boolean {
  const url = getCards(doc).get(id)?.get('url')
  if (typeof url !== 'string' || !url) return false
  claimPreview(doc.guid, id, url)
  return true
}

/**
 * For link cards this person just created or whose URL they just changed (previewBy = them): fetch
 * the preview on this device.
 */
export function requestPreview(doc: Y.Doc, id: string) {
  if (doc.isDestroyed || !claim(doc, id)) return
  maybeFetchPreview(doc, id)
}

/** "Retry" on a failed preview, or "Load preview" on a basic one: this person takes over fetching it. */
export function retryPreview(doc: Y.Doc, id: string) {
  if (doc.isDestroyed) return
  const m = getCards(doc).get(id)
  if (!m) return
  // A browser can only write the host name: it must not replace a preview a desktop teammate loaded.
  const state = m.get('previewState')
  if (!desktop && (state === 'done' || state === 'basic') && !isPreviewStale(fieldsOf(m))) return
  if (!claim(doc, id)) return
  const me = getUser().id
  updateCard(doc, id, { previewState: 'idle', previewBy: me, previewFor: null }, me, SYSTEM_ORIGIN)
  maybeFetchPreview(doc, id)
}

async function run(doc: Y.Doc, id: string, raw: string, me: string, stale: boolean) {
  // Results are dropped if the URL changed (or the card vanished) while we were fetching.
  const current = () => !doc.isDestroyed && getCards(doc).get(id)?.get('url') === raw
  const patch = (p: Record<string, unknown>) => {
    if (current()) updateCard(doc, id, p, me, SYSTEM_ORIGIN)
  }
  const url = normalizeUrl(raw)
  if (!url) {
    patch({ previewState: 'error', previewFor: raw })
    return
  }
  // Data that belongs to another URL (e.g. after undoing a URL change) must not linger.
  const reset = stale ? { title: '', description: '', siteName: '', imageBlob: null, imageUrl: null, favicon: null } : null

  if (!desktop) {
    // Browsers cannot read other sites (CORS): show the host name as the title. 'basic' (not 'done')
    // lets teammates on the desktop app load the full preview.
    patch({ ...reset, title: hostLabel(url), previewState: 'basic', previewFor: raw })
    return
  }

  // previewStartedAt lets everyone tell a fetch abandoned mid-way (app closed) from a slow one.
  patch({ ...reset, previewState: 'loading', previewStartedAt: Date.now() })

  let preview: LinkPreview | null = null
  try {
    preview = await withTimeout(desktop.fetchLinkPreview(url), PAGE_TIMEOUT_MS)
  } catch {
    preview = null
  }
  if (!current()) return
  if (!preview || typeof preview !== 'object') {
    patch({ previewState: 'error', previewFor: raw })
    return
  }

  const imageUrl = isHttpUrl(preview.image) ? preview.image : null
  const faviconUrl = isHttpUrl(preview.favicon) ? preview.favicon : null
  const result: Record<string, unknown> = {
    title: cleanText(preview.title, 300) || hostLabel(url),
    description: cleanText(preview.description, 600),
    siteName: cleanText(preview.siteName, 120),
    imageUrl,
    previewState: 'done',
    previewFor: raw,
  }
  // Short links (e.g. youtu.be, bit.ly) may only be embeddable at their final address.
  if (!sanitizeEmbed(getCards(doc).get(id)?.get('embed'))) {
    const finalUrl = normalizeUrl(preview.url)
    const embed = finalUrl ? detectEmbed(finalUrl) : null
    if (embed) result.embed = embed
  }
  patch(result)

  const [image, favicon] = await Promise.all([
    imageUrl ? fetchImageBlob(imageUrl, doc.guid, PREVIEW_IMAGE_WIDTH, MAX_PREVIEW_IMAGE_BYTES) : null,
    faviconUrl ? fetchImageBlob(faviconUrl, doc.guid, 64, MAX_FAVICON_BYTES) : null,
  ])
  const extra: Record<string, unknown> = {}
  if (image) extra.imageBlob = image
  if (favicon) extra.favicon = favicon
  if (Object.keys(extra).length) patch(extra)
}

/** Downloads a remote image through the desktop app and stores it as a blob. Returns its hash. */
async function fetchImageBlob(url: string, boardId: string, maxWidth: number, maxBytes: number): Promise<string | null> {
  if (!desktop) return null
  try {
    const r = await withTimeout(desktop.fetchImage(url), IMAGE_TIMEOUT_MS)
    if (!r || typeof r !== 'object') return null
    const raw: unknown = r.bytes
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : null
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null
    const mime = typeof r.mime === 'string' ? r.mime.split(';')[0].trim().toLowerCase() : ''
    if (!/^image\/[a-z0-9.+-]{1,60}$/.test(mime)) return null
    let blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime })
    blob = await shrinkImage(blob, maxWidth).catch(() => blob)
    return (await putBlob(blob, boardId)).hash
  } catch {
    return null
  }
}
