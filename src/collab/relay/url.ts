/**
 * Relay addresses. People paste whatever their admin gave them, so we accept ws://, wss://, http://,
 * https:// or a bare host, with an optional `?key=` access key, and derive both the WebSocket and the
 * HTTP base from it.
 */

export interface RelayEndpoint {
  /** Canonical form to store on a board: `wss://host[:port][/prefix]` plus `?key=...` when set. */
  canonical: string
  /** Same without the access key, safe to show in the UI. */
  display: string
  /** host[:port] */
  host: string
  secure: boolean
  /** ws(s)://host[:port][/prefix] (no trailing slash) */
  wsBase: string
  /** http(s)://host[:port][/prefix] (no trailing slash) */
  httpBase: string
  accessKey: string
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

export function parseRelayUrl(input: unknown): RelayEndpoint | null {
  if (typeof input !== 'string') return null
  let text = input.trim()
  if (!text || text.length > 2048 || /\s/.test(text)) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    // Bare host: secure by default, except for this computer.
    const host = text.split(/[/?#]/)[0].replace(/:\d+$/, '')
    text = `${LOCAL_HOST.test(host) ? 'ws' : 'wss'}://${text}`
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const proto = url.protocol.toLowerCase()
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(proto)) return null
  if (!url.hostname || url.username || url.password) return null
  const secure = proto === 'wss:' || proto === 'https:'
  const accessKey = url.searchParams.get('key') ?? ''
  if (accessKey.length > 256 || Array.from(accessKey).some((ch) => ch.charCodeAt(0) < 32)) return null
  let path = url.pathname.replace(/\/+$/, '')
  // Tolerate pasted endpoint URLs.
  path = path.replace(/\/(ws|healthz)$/, '')
  const host = url.host
  const wsBase = `${secure ? 'wss' : 'ws'}://${host}${path}`
  const httpBase = `${secure ? 'https' : 'http'}://${host}${path}`
  return {
    canonical: accessKey ? `${wsBase}?key=${encodeURIComponent(accessKey)}` : wsBase,
    display: wsBase,
    host,
    secure,
    wsBase,
    httpBase,
    accessKey,
  }
}

/** Canonical relay URL to store on a board, or null when the input is not a usable address. */
export function normalizeRelayUrl(input: unknown): string | null {
  return parseRelayUrl(input)?.canonical ?? null
}

/** Why a ws:// or http:// relay cannot be used from the web app (shown to people). */
export const MIXED_CONTENT_MESSAGE =
  'This page is served over https, so the browser only allows secure relays (wss:// or https://). Put the relay behind TLS or use the desktop app.'

/** Browsers block ws:// and http:// from https pages, except for this computer. */
export function isBlockedMixedContent(ep: RelayEndpoint, pageProtocol: string | undefined): boolean {
  if (ep.secure || pageProtocol !== 'https:') return false
  const hostname = ep.host.replace(/:\d+$/, '')
  return !LOCAL_HOST.test(hostname)
}

export const wsUrlFor = (ep: RelayEndpoint, roomId: string) => `${ep.wsBase}/ws/${roomId}`
export const blobUrlFor = (ep: RelayEndpoint, roomId: string, key: string) => `${ep.httpBase}/blob/${roomId}/${key}`
export const healthUrlFor = (ep: RelayEndpoint) => `${ep.httpBase}/healthz`
