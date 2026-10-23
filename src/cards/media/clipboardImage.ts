/**
 * Copies an image card to the system clipboard as a picture other apps can paste (PNG), with an HTML
 * marker so pasting back into NoemaBoard still clones the card itself (pasteCards checks it first).
 */
import * as Y from 'yjs'
import { getCardMap, isTrashed, readCard, serializeCards, xmlToText } from '../../model/board'
import { bytesToBase64Url } from '../../model/ids'
import { getBlob } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { toast } from '../../ui/toast'
import { imageLabel, readAlt } from './altText'
import { asText, cleanFileName } from './format'
import { renderTransformed } from './image'
import { positive } from './numbers'
import { readImageTransform } from './transform'

/** Chromium writes nothing larger reliably, and other apps choke on huge clipboard images. */
const MAX_CLIPBOARD_EDGE = 8192

const escapeAttr = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** HTML flavour of a copied image: the card marker (base64url data) then an <img> carrying its label. */
export function imageClipboardHtml(data: string, label: string): string {
  // Only base64url can be in the marker: anything else would not match pasteCards' pattern anyway.
  const safe = data.replace(/[^A-Za-z0-9_-]/g, '')
  return `<meta name="noema-cards" content="${safe}"><img alt="${escapeAttr(label)}">`
}

/** Why the picture could not be copied. */
export type CopyImageFailure = 'unsupported' | 'not-here' | 'failed'

class CopyImageError extends Error {
  constructor(readonly reason: CopyImageFailure) {
    super(reason)
  }
}

/** What the person is told when copying the picture fails. */
export function copyImageMessage(reason: CopyImageFailure, explain: boolean): { text: string; kind: 'info' | 'error' } | null {
  if (explain) {
    if (reason === 'not-here') return { text: 'This image isn’t on this device yet. It can be copied once a teammate who has it comes online.', kind: 'error' }
    return { text: 'Could not copy the image. Use Download instead.', kind: 'error' }
  }
  // The card itself was copied already (Ctrl+C, the menu's Copy): pasting it into NoemaBoard works. Only
  // a picture that is not here is worth a word; a browser without image clipboard support is not news.
  if (reason === 'not-here') return { text: 'Copied the card. The picture itself isn’t on this device yet, so other apps can’t paste it.', kind: 'info' }
  return null
}

export interface CopyImageOptions {
  /**
   * True for the explicit 'Copy image' action: any failure is explained. Otherwise (copying the card,
   * which has worked by then) failures are quiet, except a picture that is not on this device.
   */
  explain?: boolean
}

/**
 * Puts image card `cardId` on the system clipboard (cropped and rotated as shown). Resolves false when
 * the image or the clipboard is not available, telling the person as `options` says.
 */
export async function copyImageCardToClipboard(doc: Y.Doc, cardId: string, boardId: string, options: CopyImageOptions = {}): Promise<boolean> {
  try {
    const m = getCardMap(doc, cardId)
    if (!m || isTrashed(m) || m.get('type') !== 'image') throw new CopyImageError('failed')
    const card = readCard(m) as unknown as Record<string, unknown>
    const hash = isValidBlobHash(card.blob) ? card.blob : null
    if (!hash) throw new CopyImageError('failed')
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new CopyImageError('unsupported')
    const iw = positive(card.iw)
    const ih = positive(card.ih)
    const t = readImageTransform(card, iw, ih)
    const name = cleanFileName(asText(card.name, 255), 'Image')
    const caption = m.get('caption')
    const label = imageLabel(readAlt(card.alt), caption instanceof Y.XmlFragment ? xmlToText(caption) : '', name)
    const html = imageClipboardHtml(bytesToBase64Url(serializeCards(doc, [cardId])), label)

    let missing = false
    const png = (async () => {
      const blob = await getBlob(hash, boardId)
      if (!blob) {
        missing = true
        throw new CopyImageError('not-here')
      }
      return renderTransformed(blob, t, iw, ih, MAX_CLIPBOARD_EDGE, 'image/png')
    })()
    // Its failure is reported through the write below (or not at all if the write fails first).
    png.catch(() => {})
    // Promise-valued items keep the write inside the click for browsers that require that (Safari).
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'image/png': png,
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([name], { type: 'text/plain' }),
        }),
      ])
    } catch (err) {
      // The browser reports its own error for a rejected item: keep ours.
      throw missing ? new CopyImageError('not-here') : err
    }
    return true
  } catch (err) {
    const reason: CopyImageFailure = err instanceof CopyImageError ? err.reason : 'failed'
    if (reason !== 'not-here') console.warn('Copy image failed', err)
    const message = copyImageMessage(reason, !!options.explain)
    if (message) toast(message.text, message.kind, 6000)
    return false
  }
}
