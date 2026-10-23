/** Formatting and sanitising helpers for media cards. Pure: no DOM. */

/** "0 B", "512 B", "1.5 KB", "12 MB", "1.2 GB" (binary units, like file managers). */
export function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  if (i === 0) return `${Math.round(v)} B`
  // One decimal below 10 ("1.5 MB"), whole numbers above ("120 MB"); "1.0" is shown as "1".
  const s = v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v))
  // Rounding can reach 1024 ("1024 KB"): promote to the next unit.
  if (s === '1024' && i < units.length - 1) return `1 ${units[i + 1]}`
  return `${s} ${units[i]}`
}

/** Plain string from untrusted doc data, capped (never renders objects as React children). */
export function asText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v.length > max ? truncate(v, max) : v
}

/** Single-line text from a remote page (titles, site names): control chars and runs of whitespace collapsed. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim()
  return truncate(s, max)
}

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  let out = s.slice(0, max)
  const last = out.charCodeAt(out.length - 1)
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1)
  return out
}

export function finiteNumber(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * Invisible format characters (Unicode category Cf): bidi overrides and isolates (U+202A-202E,
 * U+2066-2069), marks (U+200E/200F, U+061C), zero-width spaces, BOM... They can make
 * "Invoice‮fdp.exe" read as "Invoiceexe.pdf". ZWJ/ZWNJ stay: they never reorder text, and emoji and
 * scripts such as Persian need them.
 */
const FORMAT_CHARS = /(?![‌‍])\p{Cf}/gu

/** A file name safe to show and to save: no path separators, control or invisible format characters. */
export function cleanFileName(v: unknown, fallback = 'file'): string {
  if (typeof v !== 'string') return fallback
  // Trailing dots/spaces are invalid on Windows; a lone leading dot (".env") is kept.
  const s = v
    .replace(FORMAT_CHARS, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]+/g, '_')
    .replace(/^\s+|[\s.]+$/g, '')
  return truncate(s, 200) || fallback
}

/** Lower-case extension without the dot ("Report.PDF" -> "pdf"), or ''. */
export function fileExtension(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name)
  return m ? m[1].toLowerCase() : ''
}

export type FileKind = 'pdf' | 'image' | 'audio' | 'video' | 'archive' | 'spreadsheet' | 'document' | 'other'

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  svg: 'image',
  bmp: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  psd: 'image',
  ico: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  flac: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  webm: 'video',
  mkv: 'video',
  avi: 'video',
  wmv: 'video',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  xls: 'spreadsheet',
  xlsx: 'spreadsheet',
  xlsm: 'spreadsheet',
  csv: 'spreadsheet',
  tsv: 'spreadsheet',
  ods: 'spreadsheet',
  numbers: 'spreadsheet',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  txt: 'document',
  md: 'document',
  pages: 'document',
  ppt: 'document',
  pptx: 'document',
  odp: 'document',
  key: 'document',
}

function kindFromMime(mime: string): FileKind {
  const m = mime.toLowerCase()
  if (m === 'application/pdf') return 'pdf'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  if (/zip|x-7z|x-rar|x-tar|gzip|x-bzip|x-xz|compressed/.test(m)) return 'archive'
  if (/spreadsheet|excel|text\/csv|tab-separated/.test(m)) return 'spreadsheet'
  if (/msword|wordprocessing|opendocument\.text|presentation|powerpoint|rtf|^text\//.test(m)) return 'document'
  return 'other'
}

const isMedia = (k: FileKind) => k === 'audio' || k === 'video'

/**
 * What a file is, for its icon and actions. The MIME type comes from whoever added the file (a peer
 * can write anything), while the name's extension decides how the computer opens the saved file.
 * When both are known they must agree; otherwise the extension wins, so "report.exe" sent as
 * application/pdf never gets the PDF look. Names without an extension fall back to the MIME type.
 */
export function fileKind(mime: string, name: string): FileKind {
  const byMime = kindFromMime(mime)
  const ext = fileExtension(name)
  if (!ext) return byMime
  const byExt = EXT_KIND[ext] ?? 'other'
  if (byMime === byExt || byMime === 'other') return byExt
  // Containers such as .webm, .ogg and .mp4 hold audio or video: either is safe to play inline.
  if (isMedia(byMime) && isMedia(byExt)) return byMime
  return byExt
}

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/opus',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  zip: 'application/zip',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
}

/** MIME type for a file the OS reported without one, guessed from its extension. */
export function guessMime(name: string, reported = ''): string {
  if (reported && reported !== 'application/octet-stream') return reported
  return EXT_MIME[fileExtension(name)] ?? (reported || 'application/octet-stream')
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
}

const SAME_EXT: Record<string, string> = { jpeg: 'jpg', jpe: 'jpg', jfif: 'jpg', tif: 'tiff' }
const canonicalExt = (e: string) => SAME_EXT[e] ?? e

/**
 * Name to save a blob under. Large images are stored re-encoded (e.g. as WebP) while the card keeps
 * the original name, so the extension is corrected to match the bytes being saved.
 */
export function downloadName(name: unknown, mime: unknown): string {
  const clean = cleanFileName(name, 'file')
  const want = typeof mime === 'string' ? MIME_EXT[mime.toLowerCase()] : undefined
  if (!want) return clean
  const ext = fileExtension(clean)
  if (canonicalExt(ext) === want) return clean
  if (ext && EXT_KIND[ext] === 'image') return clean.slice(0, -ext.length) + want
  return `${clean}.${want}`
}

/** Short type label for the file card ("PDF", "MP3", "File"). */
export function typeLabel(name: string, mime: string): string {
  const ext = fileExtension(name)
  if (ext) return ext.toUpperCase()
  const sub = /^[a-z]+\/([a-z0-9]+)$/i.exec(mime)?.[1]
  return sub && sub !== 'octet-stream' ? sub.toUpperCase() : 'File'
}
