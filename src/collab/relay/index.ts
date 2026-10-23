/**
 * Optional relay sync. Boards whose meta/library has a `relay` URL (or whose parent board has one)
 * also sync through that relay server, end-to-end encrypted: the relay stores and forwards
 * ciphertext only. See docs/RELAY.md.
 */
import { HOME_BOARD_ID } from '../../config'
import { readMeta, updateMeta, SYSTEM_ORIGIN } from '../../model/board'
import { bytesToBase64Url, isValidId } from '../../model/ids'
import { docs } from '../docs'
import { useLibrary } from '../library'
import { RelayManager } from './manager'
import { CLOSE, ERR, HELLO_PROBE, MSG, PROTOCOL_VERSION, decodeServerFrame, encodeHello } from './protocol'
import { MIXED_CONTENT_MESSAGE, healthUrlFor, isBlockedMixedContent, normalizeRelayUrl, parseRelayUrl, wsUrlFor, type RelayEndpoint } from './url'

export { useRelayStatus, useBoardRelayStatus, type BoardRelayStatus, type RelayConnectionState } from './status'
export { parseRelayUrl, normalizeRelayUrl, type RelayEndpoint } from './url'
export { effectiveRelay } from './manager'

let manager: RelayManager | null = null

/** Starts relay sync for every board with a relay address. Idempotent. */
export function startRelaySync(): void {
  if (manager || typeof window === 'undefined' || typeof WebSocket === 'undefined') return
  manager = new RelayManager()
  manager.start()
}

export interface RelayTestResult {
  ok: boolean
  message: string
}

const TEST_TIMEOUT_MS = 8000

/** Checks that a relay URL is reachable and speaks our protocol (health check + handshake). */
export async function testRelay(url: string): Promise<RelayTestResult> {
  const ep = parseRelayUrl(url)
  if (!ep) return { ok: false, message: 'Enter a relay address such as wss://relay.example.com.' }
  if (isBlockedMixedContent(ep, typeof location !== 'undefined' ? location.protocol : undefined)) {
    return { ok: false, message: MIXED_CONTENT_MESSAGE }
  }
  const started = Date.now()
  let health: Record<string, unknown>
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS)
    const res = await fetch(healthUrlFor(ep), { signal: ctrl.signal, cache: 'no-store' }).finally(() => clearTimeout(timer))
    if (!res.ok) return { ok: false, message: `The server at ${ep.host} answered with HTTP ${res.status}. Is this the relay address?` }
    const body: unknown = await res.json().catch(() => null)
    health = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return { ok: false, message: `Can't reach ${ep.host}. Check the address and that the relay is running.` }
  }
  if (health.service !== 'noema-relay' || health.ok !== true) {
    return { ok: false, message: `${ep.host} is reachable but does not look like a NoemaBoard relay.` }
  }
  if (health.protocol !== PROTOCOL_VERSION) {
    return { ok: false, message: 'This relay runs an incompatible version. Update the app or the relay.' }
  }
  if (health.accessKeyRequired === true && !ep.accessKey) {
    return { ok: false, message: 'This relay requires an access key. Add ?key=YOUR_KEY to the address.' }
  }
  const probe = await probeHandshake(ep)
  if (!probe.ok) return probe
  const version = typeof health.version === 'string' ? ` v${health.version.slice(0, 20)}` : ''
  return { ok: true, message: `Connected to the relay${version} at ${ep.host} in ${Date.now() - started} ms.` }
}

/** HELLO round trip with the probe flag: checks WebSockets get through and the access key works. */
function probeHandshake(ep: RelayEndpoint): Promise<RelayTestResult> {
  const roomId = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return new Promise((resolve) => {
    let done = false
    let ws: WebSocket
    const finish = (r: RelayTestResult) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws.onclose = ws.onmessage = ws.onerror = null
        ws.close()
      } catch {
        // ignore
      }
      resolve(r)
    }
    const timer = setTimeout(
      () => finish({ ok: false, message: 'The relay did not complete the handshake. A proxy or firewall may be blocking WebSockets.' }),
      TEST_TIMEOUT_MS,
    )
    try {
      ws = new WebSocket(wsUrlFor(ep, roomId))
    } catch {
      clearTimeout(timer)
      resolve({ ok: false, message: 'The relay address is not valid.' })
      return
    }
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => ws.send(encodeHello({ roomId, token, accessKey: ep.accessKey, flags: HELLO_PROBE }) as Uint8Array<ArrayBuffer>)
    ws.onmessage = (ev: MessageEvent) => {
      if (!(ev.data instanceof ArrayBuffer)) return
      try {
        const f = decodeServerFrame(new Uint8Array(ev.data))
        if (f.type === MSG.WELCOME) finish({ ok: true, message: 'ok' })
        else if (f.type === MSG.ERR && f.code === ERR.FORBIDDEN) finish({ ok: false, message: 'The relay did not accept the access key.' })
        else if (f.type === MSG.ERR && f.code === ERR.VERSION) {
          finish({ ok: false, message: 'This relay runs an incompatible version. Update the app or the relay.' })
        }
      } catch {
        finish({ ok: false, message: 'The relay answered with something unexpected.' })
      }
    }
    ws.onclose = (ev: CloseEvent) => {
      if (ev.code === CLOSE.FORBIDDEN) finish({ ok: false, message: 'The relay did not accept the access key.' })
      else finish({ ok: false, message: `The relay closed the connection${ev.code ? ` (code ${ev.code})` : ''}.` })
    }
    ws.onerror = () => {
      // close follows
    }
  })
}

/**
 * Sets (or clears, with null/'') the relay of a board for everyone on it: stored in the board's
 * meta (synced) and in the local library. Nested boards inherit it.
 */
export async function setBoardRelay(boardId: string, url: string | null): Promise<RelayTestResult & { url: string | null }> {
  if (boardId === HOME_BOARD_ID || !isValidId(boardId)) return { ok: false, message: 'Home cannot use a relay.', url: null }
  let canonical: string | null = null
  if (url && url.trim()) {
    canonical = normalizeRelayUrl(url)
    if (!canonical) return { ok: false, message: 'Enter a relay address such as wss://relay.example.com.', url: null }
  }
  await docs.withDoc(boardId, (doc) => {
    // A sharing setting, not a canvas edit: keep it out of the undo history.
    if (readMeta(doc).relay !== canonical) updateMeta(doc, { relay: canonical }, SYSTEM_ORIGIN)
  })
  useLibrary.getState().upsert({ id: boardId, relay: canonical })
  return { ok: true, message: canonical ? 'Relay saved.' : 'Relay removed.', url: canonical }
}
