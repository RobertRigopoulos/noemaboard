// @ts-check
/** Token-bucket rate limiting per client IP (connections, WebSocket messages, bytes, HTTP requests). */
import net from 'node:net'

/** Eight 16-bit groups of a valid IPv6 address (net.isIPv6 must have accepted it). */
function ipv6Groups(/** @type {string} */ addr) {
  /** @type {number[]} */
  let tail = []
  const v4 = addr.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4) {
    const p = v4[2].split('.').map(Number)
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]]
    addr = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1)
  }
  const parse = (/** @type {string} */ s) => (s ? s.split(':').map((g) => parseInt(g, 16)) : [])
  const gap = addr.indexOf('::')
  let groups
  if (gap >= 0) {
    const left = parse(addr.slice(0, gap))
    const right = parse(addr.slice(gap + 2))
    groups = [...left, ...new Array(Math.max(0, 8 - tail.length - left.length - right.length)).fill(0), ...right]
  } else {
    groups = parse(addr)
  }
  return [...groups, ...tail]
}

/**
 * Key that rate limits are counted under: an IPv4 address, or the /64 prefix of an IPv6 address
 * (one subscriber usually gets a whole /64, so per-address limits would be trivial to dodge).
 * IPv4-mapped IPv6 addresses count as their IPv4 address; ports and zone ids are ignored.
 * @param {string | undefined | null} addr
 */
export function ipKey(addr) {
  let a = String(addr ?? '').trim()
  const bracketed = a.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketed) a = bracketed[1]
  const v4port = a.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/)
  if (v4port) a = v4port[1]
  const zone = a.indexOf('%')
  if (zone >= 0) a = a.slice(0, zone)
  a = a.toLowerCase()
  if (!a) return 'unknown'
  if (net.isIPv4(a)) return a
  if (!net.isIPv6(a)) return a.slice(0, 64)
  const g = ipv6Groups(a)
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}

/**
 * Client address behind `hops` trusted reverse proxies. Proxies append the address they received
 * the request from, so only the last `hops` entries of X-Forwarded-For were written by them; any
 * entry further left was sent by the client and can be forged. Returns null when the header is
 * missing (the request did not come through the proxy).
 * @param {string | string[] | undefined} header X-Forwarded-For value(s)
 * @param {number} hops number of trusted proxies in front of the relay (>= 1)
 */
export function forwardedClient(header, hops) {
  const list = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length || hops < 1) return null
  return list[Math.max(0, list.length - hops)]
}

export class TokenBucket {
  /**
   * @param {number} rate tokens added per second
   * @param {number} burst bucket capacity
   */
  constructor(rate, burst) {
    this.rate = rate
    this.burst = burst
    this.tokens = burst
    this.last = Date.now()
  }

  refill(now = Date.now()) {
    const dt = (now - this.last) / 1000
    if (dt > 0) {
      this.tokens = Math.min(this.burst, this.tokens + dt * this.rate)
      this.last = now
    }
  }

  /** Takes `n` tokens; returns false (taking nothing) when the bucket does not hold enough. */
  take(n = 1) {
    if (this.rate <= 0) return true
    this.refill()
    if (this.tokens < n) return false
    this.tokens -= n
    return true
  }

  get full() {
    this.refill()
    return this.tokens >= this.burst
  }
}

/**
 * @typedef {{ maxConnections: number, messagesPerSecond: number, messageBurst: number,
 *   bytesPerSecond: number, byteBurst: number, httpPerSecond: number, httpBurst: number }} IpLimits
 */

export class IpLimiter {
  /** @param {IpLimits} limits */
  constructor(limits) {
    this.limits = limits
    /** @type {Map<string, { connections: number, messages: TokenBucket, bytes: TokenBucket, http: TokenBucket }>} */
    this.ips = new Map()
  }

  /** @param {string} ip */
  entry(ip) {
    let e = this.ips.get(ip)
    if (!e) {
      const l = this.limits
      e = {
        connections: 0,
        messages: new TokenBucket(l.messagesPerSecond, l.messageBurst),
        bytes: new TokenBucket(l.bytesPerSecond, l.byteBurst),
        http: new TokenBucket(l.httpPerSecond, l.httpBurst),
      }
      this.ips.set(ip, e)
    }
    return e
  }

  /** @param {string} ip */
  connect(ip) {
    const e = this.entry(ip)
    if (this.limits.maxConnections > 0 && e.connections >= this.limits.maxConnections) return false
    e.connections++
    return true
  }

  /** @param {string} ip */
  disconnect(ip) {
    const e = this.ips.get(ip)
    if (e && e.connections > 0) e.connections--
  }

  /** One WebSocket message of `size` bytes. @param {string} ip @param {number} size */
  message(ip, size) {
    const e = this.entry(ip)
    return e.messages.take(1) && e.bytes.take(Math.min(size, this.limits.byteBurst))
  }

  /** @param {string} ip */
  http(ip) {
    return this.entry(ip).http.take(1)
  }

  /** Forgets idle IPs so the map does not grow without bound. */
  sweep() {
    for (const [ip, e] of this.ips) {
      if (e.connections === 0 && e.messages.full && e.bytes.full && e.http.full) this.ips.delete(ip)
    }
  }
}
