import type * as Y from 'yjs'
import { importFiles, importText } from './import'
import { toast } from '../../ui/toast'
import { getUser } from '../../collab/identity'
import { columnAt, placeInColumn } from './columnTarget'

/**
 * Handles a paste on the canvas that is not our own card format:
 * images -> image cards, files -> file cards, URLs -> link cards, text -> note cards.
 * Only calls preventDefault when it handles something. Resolves with the created card ids.
 */
export async function handlePaste(doc: Y.Doc, e: ClipboardEvent, at: { x: number; y: number }): Promise<string[]> {
  const cd = e.clipboardData
  if (!cd) return []
  // Clipboard data is only readable during the event: read everything before the first await.
  const files = clipboardFiles(cd)
  const text = safeGetData(cd, 'text/plain')
  const html = safeGetData(cd, 'text/html')

  let run: (() => Promise<string[]>) | null = null
  const office = isOfficeCopy(files, text, html)
  if (files.length && !office) {
    run = () => importFiles(doc, files.map(renamePasted), at)
  } else if (text.trim()) {
    // Formatted text keeps its formatting (headings, lists...); Office copies stay plain text as before.
    run = () => importText(doc, { uriList: '', text, html: office ? '' : html }, at)
  } else if (/<img\b[^>]*?\bsrc\s*=\s*["']?data:image\//i.test(html)) {
    // Some apps put only HTML with an inline (data: URL) picture on the clipboard.
    run = () => importText(doc, { uriList: '', text: '', html }, at)
  }
  if (!run) return []
  e.preventDefault()
  // Pasting with the pointer over a column puts the new cards into it.
  const slot = columnAt(doc, at, true)
  try {
    const ids = await run()
    placeInColumn(doc, ids, slot, getUser().id)
    return ids
  } catch (err) {
    console.error('Paste failed', err)
    toast('Couldn’t paste that here', 'error')
    return []
  }
}

function safeGetData(cd: DataTransfer, type: string): string {
  try {
    return cd.getData(type) || ''
  } catch {
    return ''
  }
}

function clipboardFiles(cd: DataTransfer): File[] {
  const out: File[] = []
  for (const f of Array.from(cd.files ?? [])) if (f) out.push(f)
  if (!out.length) {
    for (const item of Array.from(cd.items ?? [])) {
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (f) out.push(f)
    }
  }
  return out
}

/**
 * Word, Excel and PowerPoint put a picture of the copied content next to the text. People pasting
 * a table or a paragraph expect the text, so prefer it when the "file" is just that rendering.
 */
export function isOfficeCopy(files: File[], text: string, html: string): boolean {
  if (files.length !== 1 || !files[0].type.startsWith('image/')) return false
  if (!text.trim() || !html) return false
  return !/<img\b/i.test(html) || /urn:schemas-microsoft-com:office/i.test(html)
}

/** Clipboard images arrive as "image.png"; give them a findable name instead. */
export function renamePasted(f: File): File {
  if (f.name && !/^image\.(png|jpe?g|gif|webp|bmp|tiff?)$/i.test(f.name)) return f
  const ext = /^image\/(png|jpeg|gif|webp|bmp)$/.exec(f.type)?.[1]?.replace('jpeg', 'jpg') ?? 'png'
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  return new File([f], `Pasted image ${stamp}.${ext}`, { type: f.type, lastModified: f.lastModified })
}
