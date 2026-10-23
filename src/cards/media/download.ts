import { getBlob } from '../../collab/blobs'
import { saveFile } from '../../lib/desktop'
import { toast } from '../../ui/toast'
import { cleanFileName, downloadName } from './format'
import { renderTransformed } from './image'
import { IDENTITY, type ImageTransform } from './transform'

const notHere = (what: string) => `This file isn’t on this device yet. It can be ${what} once a teammate who has it comes online.`

/** True when the bytes start like a PDF (the header may follow up to 1 KB of junk, as readers allow). */
export function looksLikePdf(head: Uint8Array): boolean {
  const n = Math.min(head.length, 1024)
  outer: for (let i = 0; i + 5 <= n; i++) {
    for (let j = 0; j < 5; j++) if (head[i + j] !== '%PDF-'.charCodeAt(j)) continue outer
    return true
  }
  return false
}

/**
 * Shows a PDF in the browser's own viewer, in `tab` (a window opened synchronously by the click, so
 * popup blockers allow it). The bytes are checked and always served as application/pdf, whatever
 * type the peer who added the file claimed. Resolves false (and the caller closes the tab) on failure.
 */
export async function openPdfInTab(hash: string, boardId: string | null, tab: Window | null): Promise<boolean> {
  if (!tab) {
    toast('Your browser blocked the new tab. Allow pop-ups for this site, or download the PDF instead.', 'error', 6000)
    return false
  }
  try {
    const blob = await getBlob(hash, boardId)
    if (!blob) {
      toast(notHere('opened'), 'error', 6000)
      return false
    }
    if (!looksLikePdf(new Uint8Array(await blob.slice(0, 1024).arrayBuffer()))) {
      toast('This file isn’t a valid PDF, so it can’t be opened here. Download it instead.', 'error', 6000)
      return false
    }
    const url = URL.createObjectURL(new Blob([blob], { type: 'application/pdf' }))
    tab.location.replace(url)
    // The viewer has loaded the bytes long before this.
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60_000)
    return true
  } catch (err) {
    console.error('Open PDF failed', err)
    toast('Couldn’t open the PDF', 'error')
    return false
  }
}

/**
 * Saves a blob to disk (native dialog on desktop, download in the browser), fetching it from
 * teammates first if this device does not have it. Resolves true if saved.
 */
export async function downloadBlob(hash: string, name: string, mime: string, boardId: string | null): Promise<boolean> {
  try {
    const blob = await getBlob(hash, boardId)
    if (!blob) {
      toast(notHere('saved'), 'error', 6000)
      return false
    }
    const type = blob.type || mime || 'application/octet-stream'
    return await saveFile(downloadName(name, type), blob, type)
  } catch (err) {
    console.error('Save failed', err)
    toast('Couldn’t save the file', 'error')
    return false
  }
}

const TYPE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

/** "Beach.heic" -> "Beach (edited).png": the edited copy is named after the original, with the new type. */
export function editedName(name: unknown, type: string): string {
  const clean = cleanFileName(name, 'Image')
  const base = clean.replace(/\.[A-Za-z0-9]{1,10}$/, '') || 'Image'
  return `${base} (edited).${TYPE_EXT[type] ?? 'png'}`
}

/**
 * Saves the image as shown on the card (cropped, rotated, mirrored), fetching the original from
 * teammates first if needed. Resolves true if saved.
 */
export async function downloadEdited(hash: string, name: string, t: ImageTransform, iw: number, ih: number, boardId: string | null): Promise<boolean> {
  try {
    const blob = await getBlob(hash, boardId)
    if (!blob) {
      toast(notHere('saved'), 'error', 6000)
      return false
    }
    const out = await renderTransformed(blob, t, iw, ih)
    return await saveFile(editedName(name, out.type), out, out.type)
  } catch (err) {
    console.error('Save edited image failed', err)
    toast('Couldn’t save the edited image', 'error')
    return false
  }
}

/** Image types a browser tab shows as a picture. Anything else (SVG above all) could run script in this app's origin. */
const TAB_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp'])

/**
 * Shows an image in `tab`, a window opened synchronously by the click. Unsafe types are converted to
 * PNG first. Resolves false (and the caller closes the tab) on failure.
 */
export async function openImageInTab(hash: string, mime: string, iw: number, ih: number, boardId: string | null, tab: Window | null): Promise<boolean> {
  if (!tab) {
    toast('Your browser blocked the new tab. Allow pop-ups for this site, or download the image instead.', 'error', 6000)
    return false
  }
  try {
    const blob = await getBlob(hash, boardId)
    if (!blob) {
      toast(notHere('opened'), 'error', 6000)
      return false
    }
    const type = (blob.type || mime).toLowerCase()
    const safe = TAB_SAFE_TYPES.has(type) ? new Blob([blob], { type }) : await renderTransformed(blob, IDENTITY, iw, ih, 8192, 'image/png')
    const url = URL.createObjectURL(safe)
    tab.location.replace(url)
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return true
  } catch (err) {
    console.error('Open image failed', err)
    toast('Couldn’t open the image', 'error')
    return false
  }
}
