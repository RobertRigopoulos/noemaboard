/** Validation for the Network settings form (pure, unit-tested). */

export interface TurnRow {
  urls: string
  username: string
  credential: string
}

export const MAX_TURN_ROWS = 10
export const MAX_FIELD = 300
export const MAX_DISCOVERY_URLS = 20

export function toTurnRows(servers: RTCIceServer[]): TurnRow[] {
  return servers.map((s) => ({
    urls: Array.isArray(s.urls) ? s.urls.join(', ') : String(s.urls ?? ''),
    username: typeof s.username === 'string' ? s.username : '',
    credential: typeof s.credential === 'string' ? s.credential : '',
  }))
}

/** Validates TURN rows; returns ICE servers or the first problem. Empty rows are ignored. */
export function parseTurnRows(rows: TurnRow[]): { servers: RTCIceServer[] } | { error: string } {
  const servers: RTCIceServer[] = []
  for (const [i, r] of rows.entries()) {
    const urls = r.urls
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean)
    if (!urls.length && !r.username && !r.credential) continue
    if (!urls.length) return { error: `TURN server ${i + 1}: enter its address.` }
    for (const u of urls) {
      if (u.length > MAX_FIELD || !/^(turns?|stuns?):[^\s]+$/i.test(u))
        return { error: `TURN server ${i + 1}: “${u.slice(0, 60)}” should look like turn:host:3478 or turns:host:443.` }
    }
    if (r.username.length > MAX_FIELD || r.credential.length > MAX_FIELD) return { error: `TURN server ${i + 1}: username or password is too long.` }
    const s: RTCIceServer = { urls: urls.length === 1 ? urls[0] : urls }
    if (r.username) s.username = r.username
    if (r.credential) s.credential = r.credential
    servers.push(s)
  }
  return { servers }
}

/** One wss:// URL per line ('#' starts a comment line). Returns the list or the first invalid line. */
export function parseWssList(text: string, what: string): { urls: string[] } | { error: string } {
  const urls: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let ok = line.length <= MAX_FIELD && /^wss:\/\/[^\s]+$/i.test(line)
    if (ok) {
      try {
        ok = new URL(line).protocol === 'wss:'
      } catch {
        ok = false
      }
    }
    if (!ok) return { error: `${what}: “${line.slice(0, 60)}” is not a wss:// address.` }
    if (!urls.includes(line)) urls.push(line)
  }
  if (urls.length > MAX_DISCOVERY_URLS) return { error: `${what}: use at most ${MAX_DISCOVERY_URLS} addresses.` }
  return { urls }
}
