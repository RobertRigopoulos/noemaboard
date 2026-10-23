/**
 * Copy / cut / paste from menus, where there is no ClipboardEvent. Copy runs the regular copy
 * code against a synthetic event and writes the result (with the HTML card marker) through the
 * async Clipboard API; paste reads the system clipboard and replays it as a synthetic paste so
 * our card format, images, links and text take the same path as Ctrl+V. Best effort: browsers
 * may deny clipboard access, in which case the in-memory clipboard still works inside this tab.
 */
import type * as Y from 'yjs'
import { copySelection, deleteSelection, pasteCards, snap } from '../../board/actions'
import { useSelection } from '../../board/store'
import { copyImageCardToClipboard } from '../../cards/media/clipboardImage'
import { handlePaste } from '../../cards/media/paste'
import { getUser } from '../../collab/identity'
import { createTextNote, getCardMap, getCards } from '../../model/board'
import { toast } from '../toast'
import { modKey } from './keys'

const MAX_TEXT = 200_000
const PASTE_HINT = `${modKey}V`

/** The selected card when exactly one image card is selected. */
function singleImage(doc: Y.Doc): string | null {
  const sel = useSelection.getState().selected
  if (sel.size !== 1) return null
  const [id] = sel
  return getCardMap(doc, id)?.get('type') === 'image' ? id : null
}

/** text/plain plus text/html (the card marker followed by the cards as rich text, from copySelection). */
async function writeRich(text: string, html: string) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      }),
    ])
  } catch {
    await navigator.clipboard?.writeText(text).catch(() => {})
  }
}

/** Copies the current selection to the system clipboard (and the in-app memory clipboard). */
export async function copyCardsToClipboard(doc: Y.Doc, cut = false): Promise<boolean> {
  const image = singleImage(doc)
  let dt: DataTransfer | null = null
  let ok = false
  try {
    dt = new DataTransfer()
    const ev = new ClipboardEvent('copy', { clipboardData: dt, cancelable: true })
    if (!ev.clipboardData) throw new Error('no clipboardData')
    ok = copySelection(doc, ev)
  } catch {
    dt = null
    // Writes plain text through the Clipboard API itself.
    ok = copySelection(doc)
  }
  if (!ok) return false
  // One image goes out as a picture other apps can paste (still carrying the card marker, so
  // pasting it here clones the card). One clipboard write, so it stays inside the click.
  const pictureCopied = image ? await copyImageCardToClipboard(doc, image, doc.guid) : false
  if (dt && !pictureCopied) await writeRich(dt.getData('text/plain'), dt.getData('text/html'))
  if (cut) deleteSelection(doc)
  return true
}

interface ClipboardSnapshot {
  html: string
  text: string
  files: File[]
}

async function readClipboard(): Promise<ClipboardSnapshot | null> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
  if (!clip) return null
  const out: ClipboardSnapshot = { html: '', text: '', files: [] }
  if (typeof clip.read === 'function') {
    try {
      // Sanitized HTML may lose our <meta> card marker; Chromium can return it unsanitized.
      const read = clip.read.bind(clip) as (opts?: { unsanitized?: string[] }) => Promise<ClipboardItems>
      const items = await read({ unsanitized: ['text/html'] }).catch(() => read())
      for (const item of items) {
        for (const type of item.types) {
          const blob = await item.getType(type)
          if (type === 'text/html' && !out.html) out.html = await blob.text()
          else if (type === 'text/plain' && !out.text) out.text = await blob.text()
          else if (type.startsWith('image/')) {
            const ext = type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
            out.files.push(new File([blob], `image.${ext}`, { type }))
          }
        }
      }
      return out
    } catch {
      // Permission denied or unsupported types: fall back to plain text.
    }
  }
  if (typeof clip.readText === 'function') {
    try {
      out.text = await clip.readText()
      return out
    } catch {
      return null
    }
  }
  return null
}

/** A ClipboardEvent carrying the snapshot (real DataTransfer when supported, else a minimal stand-in). */
function syntheticPaste(s: ClipboardSnapshot): ClipboardEvent {
  try {
    const dt = new DataTransfer()
    if (s.text) dt.setData('text/plain', s.text)
    if (s.html) dt.setData('text/html', s.html)
    for (const f of s.files) dt.items.add(f)
    const ev = new ClipboardEvent('paste', { clipboardData: dt, cancelable: true })
    if (ev.clipboardData) return ev
  } catch {
    // Older engines cannot construct these; use the stand-in below.
  }
  const data = (type: string) => (type === 'text/plain' ? s.text : type === 'text/html' ? s.html : '')
  const types = [s.text && 'text/plain', s.html && 'text/html', s.files.length && 'Files'].filter(Boolean) as string[]
  return {
    clipboardData: { getData: data, types, files: s.files, items: [] },
    preventDefault() {},
    defaultPrevented: false,
  } as unknown as ClipboardEvent
}

/** Pastes the clipboard at board position `at`. Returns true when something was added. */
export async function pasteFromClipboard(doc: Y.Doc, at: { x: number; y: number }): Promise<boolean> {
  const s = await readClipboard()
  if (!s) {
    toast(`Clipboard access was blocked. Press ${PASTE_HINT} to paste.`, 'info')
    return false
  }
  if (s.text.length > MAX_TEXT) s.text = s.text.slice(0, MAX_TEXT)
  const ev = syntheticPaste(s)
  if (pasteCards(doc, ev, at)) return true
  if (!s.text.trim() && !s.files.length) {
    toast('The clipboard is empty.', 'info')
    return false
  }
  const before = getCards(doc).size
  try {
    const ids = await handlePaste(doc, ev, at)
    if (Array.isArray(ids) && ids.length) return true
  } catch {
    // Fall through: keep plain text rather than losing it.
  }
  if (getCards(doc).size > before) return true
  if (!s.text.trim()) return false
  const id = createTextNote(doc, s.text, { x: snap(at.x), y: snap(at.y) }, getUser().id)
  useSelection.getState().select([id])
  return true
}
