/**
 * Network side of link previews, run in the main process so the renderer never needs CORS
 * workarounds. SSRF-guarded: every hop (including redirects) is validated, and the address
 * actually connected to is checked inside the socket's DNS lookup, which also defeats DNS
 * rebinding. No cookies, credentials, proxies or caches are involved.
 */
import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { pipeline, type Readable } from 'node:stream'
import zlib from 'node:zlib'
import type { LinkPreview } from '../src/lib/desktop'
import {
  basicPreview,
  decodeHtml,
  isAcceptedImageMime,
  isHtmlMime,
  parseContentType,
  parseLinkPreview,
  sniffImageMime,
} from './htmlMeta'
import { isBlockedAddress, validateTargetUrl } from './netGuard'

export const MAX_HTML_BYTES = 1024 * 1024
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_REDIRECTS = 5
export const TIMEOUT_MS = 8000

const ACCEPT_HTML = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5'
const ACCEPT_IMAGE = 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8'

export interface ResolvedAddress {
  address: string
  family: number
}

export interface FetchOptions {
  userAgent?: string
  acceptLanguage?: string
  timeoutMs?: number
  /** Resolves every address of a hostname. Injected by tests. */
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>
  /** Address policy. Injected by tests to allow a local test server. */
  isBlocked?: (address: string) => boolean
}

const defaultResolve = (hostname: string) => dns.promises.lookup(hostname, { all: true })

export function defaultUserAgent(chromeVersion = '140.0.0.0', platform: NodeJS.Platform = process.platform): string {
  const os =
    platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64'
  const major = chromeVersion.split('.')[0]
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

class GuardError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

/**
 * DNS lookup used by the sockets: resolves all addresses and refuses the connection if ANY of
 * them is private/special, so a hostname cannot mix a public and an internal address.
 */
export function guardedLookup(opts: FetchOptions): LookupFunction {
  const resolve = opts.resolve ?? defaultResolve
  const isBlocked = opts.isBlocked ?? isBlockedAddress
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (all) => {
        const fam = options.family === 4 || options.family === 'IPv4' ? 4 : options.family === 6 || options.family === 'IPv6' ? 6 : 0
        const list = fam ? all.filter((a) => a.family === fam) : all
        if (all.some((a) => isBlocked(a.address))) {
          callback(new GuardError(`Refusing to connect to a private address for ${hostname}`, 'EBLOCKED'), '', 0)
        } else if (list.length === 0) {
          callback(new GuardError(`No address for ${hostname}`, 'ENOTFOUND'), '', 0)
        } else if (options.all) {
          callback(null, list)
        } else {
          callback(null, list[0].address, list[0].family)
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, '', 0),
    )
  }
}

function request(url: URL, headers: Record<string, string>, lookup: LookupFunction, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    // agent: false → fresh socket, nothing shared with other requests.
    const req = mod.request(url, { method: 'GET', headers, lookup, signal, agent: false, maxHeaderSize: 32 * 1024 }, resolve)
    req.on('error', reject)
    req.end()
  })
}

/** Follows up to MAX_REDIRECTS redirects, validating every target. Resolves the 2xx response. */
async function openGuarded(
  start: URL,
  accept: string,
  opts: FetchOptions,
  signal: AbortSignal,
): Promise<{ url: URL; res: http.IncomingMessage } | null> {
  const lookup = guardedLookup(opts)
  const headers: Record<string, string> = {
    'User-Agent': opts.userAgent ?? defaultUserAgent(),
    Accept: accept,
    'Accept-Language': opts.acceptLanguage ?? 'en-US,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  }
  let url = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await request(url, headers, lookup, signal)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400) {
      const location = res.headers.location
      res.destroy()
      if (!location) return null
      // IP-literal hosts never reach the guarded lookup, so validateTargetUrl must vet them.
      const next = validateTargetUrl(location, url)
      if (!next) return null
      url = next
      continue
    }
    if (status < 200 || status >= 300) {
      res.destroy()
      return null
    }
    return { url, res }
  }
  return null
}

function decodedStream(res: http.IncomingMessage): Readable | null {
  const enc = String(res.headers['content-encoding'] ?? '').trim().toLowerCase()
  const noop = () => {}
  if (!enc || enc === 'identity') return res
  if (enc === 'gzip' || enc === 'x-gzip' || enc === 'deflate') return pipeline(res, zlib.createUnzip(), noop)
  if (enc === 'br') return pipeline(res, zlib.createBrotliDecompress(), noop)
  return null
}

/**
 * Reads the (decompressed) body. With `truncate`, stops quietly at maxBytes; otherwise a larger
 * body is an error. With `stopAtHeadEnd`, stops as soon as `</head` has been seen.
 */
async function readBody(
  res: http.IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
  { truncate, stopAtHeadEnd }: { truncate: boolean; stopAtHeadEnd?: boolean },
): Promise<Uint8Array | null> {
  const stream = decodedStream(res)
  if (!stream) {
    res.destroy()
    return null
  }
  const onAbort = () => stream.destroy(new Error('Timed out'))
  signal.addEventListener('abort', onAbort, { once: true })
  const chunks: Buffer[] = []
  let total = 0
  let tail = ''
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const room = maxBytes - total
      if (chunk.length > room) {
        if (!truncate) return null
        chunks.push(chunk.subarray(0, room))
        total += room
        break
      }
      chunks.push(chunk)
      total += chunk.length
      if (stopAtHeadEnd) {
        const text = tail + chunk.toString('latin1').toLowerCase()
        if (text.includes('</head')) break
        tail = text.slice(-8)
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    stream.destroy()
    res.destroy()
  }
  const out = Buffer.concat(chunks, total)
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
}

const looksLikeMarkup = (b: Uint8Array) => /^\s*</.test(Buffer.from(b.subarray(0, 512)).toString('latin1'))

/** Fetches OpenGraph-style metadata for a public http(s) URL. Null on any failure. */
export async function fetchLinkPreview(raw: unknown, opts: FetchOptions = {}): Promise<LinkPreview | null> {
  const start = validateTargetUrl(raw)
  if (!start) return null
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
  try {
    const opened = await openGuarded(start, ACCEPT_HTML, opts, signal)
    if (!opened) return null
    const { url, res } = opened
    const ct = parseContentType(res.headers['content-type'])
    if (ct.mime && !isHtmlMime(ct.mime)) {
      res.destroy()
      return basicPreview(url.toString(), isAcceptedImageMime(ct.mime))
    }
    const body = await readBody(res, MAX_HTML_BYTES, signal, { truncate: true, stopAtHeadEnd: true })
    if (!body) return null
    if (!ct.mime && !looksLikeMarkup(body)) return basicPreview(url.toString(), false)
    return parseLinkPreview(decodeHtml(body, ct.charset), url.toString())
  } catch {
    return null
  }
}

/** Downloads a public raster image (≤10 MB). SVG and non-images are refused. */
export async function fetchImage(raw: unknown, opts: FetchOptions = {}): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const start = validateTargetUrl(raw)
  if (!start) return null
  const signal = AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS)
  try {
    const opened = await openGuarded(start, ACCEPT_IMAGE, opts, signal)
    if (!opened) return null
    const { res } = opened
    const ct = parseContentType(res.headers['content-type'])
    const declared = isAcceptedImageMime(ct.mime)
    const generic = ct.mime === '' || ct.mime === 'application/octet-stream' || ct.mime === 'binary/octet-stream'
    const length = Number(res.headers['content-length'])
    if ((!declared && !generic) || (Number.isFinite(length) && length > MAX_IMAGE_BYTES)) {
      res.destroy()
      return null
    }
    const bytes = await readBody(res, MAX_IMAGE_BYTES, signal, { truncate: false })
    if (!bytes || bytes.length === 0) return null
    const sniffed = sniffImageMime(bytes)
    // A "200 image/png" that is really an HTML/SVG error page is refused.
    if (!sniffed && (!declared || looksLikeMarkup(bytes))) return null
    return { bytes, mime: sniffed ?? ct.mime }
  } catch {
    return null
  }
}

/** Limits how many network fetches run at once; extra callers wait their turn. */
export function createLimiter(max: number) {
  let active = 0
  const queue: (() => void)[] = []
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing task hands its slot straight to the next waiter.
    if (active >= max) await new Promise<void>((r) => queue.push(r))
    else active++
    try {
      return await fn()
    } finally {
      const next = queue.shift()
      if (next) next()
      else active--
    }
  }
}
