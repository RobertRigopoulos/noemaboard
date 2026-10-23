/**
 * SSRF guard for requests the main process makes on behalf of the renderer (link previews,
 * preview images). Only public unicast addresses may be contacted; anything that could reach
 * this computer, the LAN, cloud metadata endpoints or special-purpose ranges is refused.
 * Pure functions, no Electron imports (unit-tested in Node).
 */

export const MAX_URL_LENGTH = 4096

/** Parses a strict dotted-quad IPv4 address into a 32-bit unsigned number. */
export function parseIPv4(s: string): number | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n >>> 0
}

/** Parses an IPv6 address (with optional zone id and embedded IPv4) into 8 16-bit groups. */
export function parseIPv6(input: string): number[] | null {
  let s = input
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1)
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  if (!s.includes(':') || s.length > 45) return null

  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1) becomes two groups.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail)
    if (v4 === null) return null
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = parseGroups(halves[0])
  if (!head) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const rest = parseGroups(halves[1])
  if (!rest) return null
  const missing = 8 - head.length - rest.length
  if (missing < 1) return null
  return [...head, ...Array.from({ length: missing }, () => 0), ...rest]
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata lives here)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]

const V4_RANGES = V4_BLOCKED.map(([base, bits]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return { net: (parseIPv4(base)! & mask) >>> 0, mask }
})

export function isBlockedIPv4(n: number): boolean {
  return V4_RANGES.some(({ net, mask }) => ((n & mask) >>> 0) === net)
}

function embeddedV4(g: number[], hiIndex: number): number {
  return ((g[hiIndex] << 16) | g[hiIndex + 1]) >>> 0
}

export function isBlockedIPv6(g: number[]): boolean {
  const allZeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0)
  // :: (unspecified) and ::1 (loopback)
  if (allZeroUntil(7) && (g[7] === 0 || g[7] === 1)) return true
  // ::ffff:a.b.c.d (IPv4-mapped) and ::a.b.c.d (deprecated IPv4-compatible): judge the IPv4 part
  if (allZeroUntil(5) && g[5] === 0xffff) return isBlockedIPv4(embeddedV4(g, 6))
  if (allZeroUntil(6)) return true
  // ::ffff:0:a.b.c.d (IPv4-translated)
  if (allZeroUntil(4) && g[4] === 0xffff && g[5] === 0) return isBlockedIPv4(embeddedV4(g, 6))
  // 64:ff9b::/96 NAT64 well-known prefix → embedded IPv4; 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true
    if (g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(embeddedV4(g, 6))
  }
  // 100::/64 discard-only
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true
  // 2001::/23 IETF protocol assignments (incl. Teredo 2001::/32, which can tunnel to private v4)
  if (g[0] === 0x2001 && g[1] < 0x200) return true
  // 2001:db8::/32 documentation
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true
  // 2002::/16 6to4 → embedded IPv4 in groups 1-2
  if (g[0] === 0x2002) return isBlockedIPv4(embeddedV4(g, 1))
  // 3fff::/20 documentation
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true
  // fc00::/7 unique local
  if ((g[0] & 0xfe00) === 0xfc00) return true
  // fe80::/10 link-local and fec0::/10 deprecated site-local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true
  // ff00::/8 multicast
  if ((g[0] & 0xff00) === 0xff00) return true
  return false
}

/**
 * True if the address must never be contacted. Unparseable input counts as blocked so a
 * resolver returning something unexpected fails closed.
 */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIPv4(address)
  if (v4 !== null) return isBlockedIPv4(v4)
  const v6 = parseIPv6(address)
  if (v6) return isBlockedIPv6(v6)
  return true
}

/** True if the host is an IP literal (as normalized by the WHATWG URL parser). */
export function isIpLiteral(hostname: string): boolean {
  return parseIPv4(hostname) !== null || (hostname.startsWith('[') && parseIPv6(hostname) !== null)
}

/**
 * Validates a URL the renderer asked us to fetch. Returns the parsed URL, or null when it is
 * not a plain public http(s) URL. Hostnames are checked again after DNS resolution.
 */
export function validateTargetUrl(input: unknown, base?: URL): URL | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = base ? new URL(input, base) : new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  if (!host || host.length > 253) return null
  if (isIpLiteral(host)) return isBlockedAddress(host) ? null : url
  // Names that only ever mean "this machine" or the local network.
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null
  if (host.endsWith('.home.arpa') || host === 'home.arpa') return null
  if (!/^[a-z0-9._-]+$/.test(host) || host.startsWith('.') || host.includes('..')) return null
  return url
}
