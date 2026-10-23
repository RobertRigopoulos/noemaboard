/** Validation of arguments that arrive over IPC from the renderer (pure, unit-tested). */

export const MAX_SAVE_BYTES = 2 * 1024 * 1024 * 1024

export interface FileFilter {
  name: string
  extensions: string[]
}

const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i

/** Turns an arbitrary suggested name into a safe single file name (no directories). */
export function sanitizeFileName(raw: unknown, fallback = 'untitled'): string {
  if (typeof raw !== 'string') return fallback
  let name = raw
    // oxlint-disable-next-line no-control-regex -- matching control characters is intended
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Bidi overrides and other invisible format characters can disguise an extension.
    .replace(/\p{Cf}/gu, '')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
  if (name.length > 200) {
    const dot = name.lastIndexOf('.')
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
    name = name.slice(0, 200 - ext.length) + ext
  }
  if (!name || RESERVED_WIN.test(name)) return fallback
  return name
}

export function sanitizeFilters(raw: unknown): FileFilter[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length > 20) return undefined
  const out: FileFilter[] = []
  for (const f of raw) {
    if (!f || typeof f !== 'object') continue
    const { name, extensions } = f as Record<string, unknown>
    if (typeof name !== 'string' || !Array.isArray(extensions) || extensions.length === 0 || extensions.length > 50) continue
    const exts = extensions.filter((e): e is string => typeof e === 'string' && /^(\*|[A-Za-z0-9_-]{1,16})$/.test(e))
    if (exts.length) out.push({ name: name.slice(0, 100), extensions: exts })
  }
  return out.length ? out : undefined
}

/** Default dialog filters derived from the file extension ("board.zip" → ZIP + All files). */
export function defaultFiltersFor(fileName: string): FileFilter[] | undefined {
  const m = fileName.match(/\.([A-Za-z0-9]{1,16})$/)
  if (!m) return undefined
  return [
    { name: `${m[1].toUpperCase()} file`, extensions: [m[1].toLowerCase()] },
    { name: 'All files', extensions: ['*'] },
  ]
}

/** http(s) and mailto only; nothing that could launch a local program or file. */
export function isAllowedExternalUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 8192) return false
  try {
    const u = new URL(raw)
    if (u.protocol === 'mailto:') return true
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

export function isValidSaveData(data: unknown): data is Uint8Array {
  return data instanceof Uint8Array && data.byteLength <= MAX_SAVE_BYTES
}

export const PRINT_PAGE_SIZES: readonly string[] = ['A4', 'Letter', 'A3']

export interface PrintOptions {
  pageSize: 'A4' | 'Letter' | 'A3'
  landscape: boolean
}

/** Exactly { pageSize: 'A4' | 'Letter' | 'A3', landscape: boolean }; null for anything else. */
export function sanitizePrintOptions(raw: unknown): PrintOptions | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length !== 2 || !keys.includes('pageSize') || !keys.includes('landscape')) return null
  if (typeof o.pageSize !== 'string' || !PRINT_PAGE_SIZES.includes(o.pageSize)) return null
  if (typeof o.landscape !== 'boolean') return null
  return { pageSize: o.pageSize as PrintOptions['pageSize'], landscape: o.landscape }
}
