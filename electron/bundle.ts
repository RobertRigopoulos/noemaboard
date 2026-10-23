/**
 * Pure helpers for the privileged `app://bundle/` scheme that serves the built renderer.
 * Never rename the scheme or host: they define the IndexedDB origin where every board lives.
 */
import path from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'bundle'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self' app:",
  "script-src 'self'",
  // Relays may be plain ws:// + http:// on this computer or the local network (CSP cannot express
  // "private addresses only"). Relay payloads are end-to-end encrypted, so plain transport is safe.
  "connect-src 'self' ws: wss: http: https: blob: data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  'frame-src https:',
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
}

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Maps the pathname of an app://bundle/ URL to a file inside `root`. Returns null for anything
 * that could escape the directory (encoded "..", backslashes, NUL bytes, absolute paths).
 */
export function resolveBundlePath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const segments = decoded.split('/').filter((s) => s !== '' && s !== '.')
  if (segments.some((s) => s === '..' || /^[a-zA-Z]:$/.test(s))) return null
  const rootAbs = path.resolve(root)
  const file = path.resolve(rootAbs, ...(segments.length ? segments : ['index.html']))
  const rel = path.relative(rootAbs, file)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return rel === '' ? path.join(rootAbs, 'index.html') : null
  return file
}

/** SPA fallback: extension-less paths that do not exist are served index.html. */
export function wantsSpaFallback(pathname: string): boolean {
  const last = pathname.split('/').pop() ?? ''
  return !last.includes('.')
}
