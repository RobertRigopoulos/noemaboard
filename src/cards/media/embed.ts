/**
 * Embeddable links (videos, music, designs, maps). `detectEmbed` maps a page URL to the provider's
 * official embed URL; `sanitizeEmbed` re-validates an embed read from the doc, because a peer could
 * write any iframe src there. Pure: no DOM.
 */

export interface Embed {
  provider: EmbedProvider
  /** https URL of the provider's embed player. */
  src: string
  /** Width / height of the player (CSS aspect-ratio). */
  aspect: number
}

export type EmbedProvider = 'youtube' | 'vimeo' | 'spotify' | 'soundcloud' | 'loom' | 'figma' | 'googlemaps'

export const EMBED_LABELS: Record<EmbedProvider, string> = {
  youtube: 'YouTube',
  vimeo: 'Vimeo',
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  loom: 'Loom',
  figma: 'Figma',
  googlemaps: 'Google Maps',
}

const VIDEO = 16 / 9
const MIN_ASPECT = 0.25
const MAX_ASPECT = 4

export function detectEmbed(url: unknown): Embed | null {
  if (typeof url !== 'string' || !url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  if (u.username || u.password) return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return youtube(u, host) ?? vimeo(u, host) ?? spotify(u, host) ?? soundcloud(u, host) ?? loom(u, host) ?? figma(u, host) ?? googleMaps(u, host)
}

const segments = (u: URL) => u.pathname.split('/').filter(Boolean)

// ---------------------------------------------------------------------------
// YouTube

const YT_ID = /^[A-Za-z0-9_-]{11}$/
const YT_LIST = /^[A-Za-z0-9_-]{2,64}$/

/** "90", "90s", "1m30s", "1h2m3s" -> seconds. */
export function parseTimestamp(v: string | null): number | null {
  if (!v) return null
  if (/^\d+$/.test(v)) return Number(v)
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(v)
  if (!m || !(m[1] || m[2] || m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}

function youtube(u: URL, host: string): Embed | null {
  const h = host.replace(/^(www|m|music)\./, '')
  let id: string | null = null
  let aspect = VIDEO
  let list = u.searchParams.get('list')
  if (h === 'youtu.be') {
    id = segments(u)[0] ?? null
  } else if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    const seg = segments(u)
    if (seg[0] === 'watch') id = u.searchParams.get('v')
    else if (seg[0] === 'shorts') {
      id = seg[1] ?? null
      aspect = 9 / 16
    } else if (seg[0] === 'embed' && seg[1] === 'videoseries') id = null
    else if (seg[0] === 'embed' || seg[0] === 'live' || seg[0] === 'v' || seg[0] === 'e') id = seg[1] ?? null
    else if (seg[0] !== 'playlist') return null
  } else return null

  if (list && !YT_LIST.test(list)) list = null
  if (id && !YT_ID.test(id)) return null
  if (!id && !list) return null

  const params = new URLSearchParams()
  if (list) params.set('list', list)
  const start = parseTimestamp(u.searchParams.get('t') ?? u.searchParams.get('start'))
  if (id && start) params.set('start', String(start))
  const qs = params.toString()
  const src = `https://www.youtube-nocookie.com/embed/${id ?? 'videoseries'}${qs ? `?${qs}` : ''}`
  return { provider: 'youtube', src, aspect }
}

// ---------------------------------------------------------------------------
// Vimeo

function vimeo(u: URL, host: string): Embed | null {
  const h = host.replace(/^www\./, '')
  const seg = segments(u)
  let id: string | null = null
  let hash: string | null = u.searchParams.get('h')
  if (h === 'player.vimeo.com') {
    if (seg[0] === 'video' && /^\d+$/.test(seg[1] ?? '')) id = seg[1]
  } else if (h === 'vimeo.com') {
    // vimeo.com/123, vimeo.com/123/abcdef (unlisted), vimeo.com/channels/x/123, vimeo.com/groups/x/videos/123
    const i = seg.findIndex((s) => /^\d{4,}$/.test(s))
    if (i >= 0) {
      id = seg[i]
      const next = seg[i + 1]
      if (!hash && next && /^[a-f0-9]{6,20}$/i.test(next)) hash = next
    }
  }
  if (!id) return null
  const src = `https://player.vimeo.com/video/${id}${hash && /^[a-f0-9]{6,20}$/i.test(hash) ? `?h=${hash}` : ''}`
  return { provider: 'vimeo', src, aspect: VIDEO }
}

// ---------------------------------------------------------------------------
// Spotify

const SPOTIFY_TYPES = new Set(['track', 'album', 'playlist', 'episode', 'show', 'artist'])

function spotify(u: URL, host: string): Embed | null {
  if (host !== 'open.spotify.com') return null
  const seg = segments(u)
  if (seg[0]?.startsWith('intl-')) seg.shift()
  if (seg[0] === 'embed') seg.shift()
  const [type, id] = seg
  if (!type || !SPOTIFY_TYPES.has(type) || !id || !/^[A-Za-z0-9]{10,40}$/.test(id)) return null
  // Compact player for single items, tall list player otherwise (Spotify's own heights: 152 / 352).
  const compact = type === 'track' || type === 'episode'
  return { provider: 'spotify', src: `https://open.spotify.com/embed/${type}/${id}`, aspect: compact ? 300 / 152 : 300 / 352 }
}

// ---------------------------------------------------------------------------
// SoundCloud

const SC_RESERVED = new Set([
  'discover',
  'search',
  'stream',
  'you',
  'upload',
  'charts',
  'pages',
  'settings',
  'messages',
  'notifications',
  'terms-of-use',
  'imprint',
  'mobile',
  'jobs',
  'feed',
  'people',
  'pro',
  'popular',
  'signin',
  'logout',
])
const SC_PROFILE_TABS = new Set(['likes', 'tracks', 'albums', 'sets', 'reposts', 'popular-tracks', 'followers', 'following', 'comments'])

function soundcloud(u: URL, host: string): Embed | null {
  const h = host.replace(/^(www|m)\./, '')
  if (h !== 'soundcloud.com') return null
  const seg = segments(u)
  if (seg.length < 2 || seg.length > 4 || SC_RESERVED.has(seg[0])) return null
  if (!seg.every((s) => /^[A-Za-z0-9_-]{1,100}$/.test(s))) return null
  if (seg.length === 2 && SC_PROFILE_TABS.has(seg[1])) return null
  const canonical = `https://soundcloud.com/${seg.join('/')}`
  const isSet = seg[1] === 'sets'
  return {
    provider: 'soundcloud',
    src: `https://w.soundcloud.com/player/?url=${encodeURIComponent(canonical)}`,
    aspect: isSet ? 300 / 400 : 300 / 166,
  }
}

// ---------------------------------------------------------------------------
// Loom

function loom(u: URL, host: string): Embed | null {
  if (host.replace(/^www\./, '') !== 'loom.com') return null
  const seg = segments(u)
  if ((seg[0] !== 'share' && seg[0] !== 'embed') || !seg[1]) return null
  // Newer share links carry a title slug before the 32-hex id: /share/My-video-0123abcd...
  const id = /([a-f0-9]{32})$/i.exec(seg[1])?.[1] ?? (/^[A-Za-z0-9]{10,64}$/.test(seg[1]) ? seg[1] : null)
  if (!id) return null
  return { provider: 'loom', src: `https://www.loom.com/embed/${id}`, aspect: VIDEO }
}

// ---------------------------------------------------------------------------
// Figma

const FIGMA_KINDS = new Set(['file', 'design', 'proto', 'board', 'slides', 'deck'])

function figmaFileUrl(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'figma.com' || u.protocol !== 'https:') return null
  const seg = segments(u)
  if (!FIGMA_KINDS.has(seg[0]) || !/^[A-Za-z0-9]{10,64}$/.test(seg[1] ?? '')) return null
  return `https://www.figma.com${u.pathname}${u.search}`
}

function figma(u: URL, host: string): Embed | null {
  if (host.replace(/^www\./, '') !== 'figma.com') return null
  let file: string | null
  if (segments(u)[0] === 'embed') {
    const inner = u.searchParams.get('url')
    try {
      file = inner ? figmaFileUrl(new URL(inner)) : null
    } catch {
      file = null
    }
  } else file = figmaFileUrl(u)
  if (!file) return null
  return { provider: 'figma', src: `https://www.figma.com/embed?embed_host=share&url=${encodeURIComponent(file)}`, aspect: VIDEO }
}

// ---------------------------------------------------------------------------
// Google Maps (only links that already are embed links: "Share > Embed a map")

function googleMaps(u: URL, host: string): Embed | null {
  const h = host.replace(/^(www|maps)\./, '')
  if (!/^google\.[a-z]{2,3}(\.[a-z]{2})?$/.test(h)) return null
  if (u.pathname !== '/maps/embed' && !u.pathname.startsWith('/maps/embed/v1/')) return null
  if (!u.search) return null
  return { provider: 'googlemaps', src: `https://www.google.com${u.pathname}${u.search}`, aspect: 4 / 3 }
}

// ---------------------------------------------------------------------------
// Validation of embeds read from the doc

const ALLOWED_SRC: Record<EmbedProvider, (u: URL) => boolean> = {
  youtube: (u) => u.hostname === 'www.youtube-nocookie.com' && /^\/embed\/([A-Za-z0-9_-]{11}|videoseries)$/.test(u.pathname),
  vimeo: (u) => u.hostname === 'player.vimeo.com' && /^\/video\/\d+$/.test(u.pathname),
  spotify: (u) =>
    u.hostname === 'open.spotify.com' && /^\/embed\/(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{10,40}$/.test(u.pathname),
  soundcloud: (u) =>
    u.hostname === 'w.soundcloud.com' && u.pathname === '/player/' && (u.searchParams.get('url') ?? '').startsWith('https://soundcloud.com/'),
  loom: (u) => u.hostname === 'www.loom.com' && /^\/embed\/[A-Za-z0-9]{10,64}$/.test(u.pathname),
  figma: (u) => {
    if (u.hostname !== 'www.figma.com' || u.pathname !== '/embed') return false
    try {
      return figmaFileUrl(new URL(u.searchParams.get('url') ?? '')) !== null
    } catch {
      return false
    }
  },
  googlemaps: (u) => u.hostname === 'www.google.com' && (u.pathname === '/maps/embed' || u.pathname.startsWith('/maps/embed/v1/')),
}

/** Returns a safe embed or null. Never trust an iframe src that came from the doc without this. */
export function sanitizeEmbed(v: unknown): Embed | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const provider = o.provider
  if (typeof provider !== 'string' || !Object.hasOwn(ALLOWED_SRC, provider)) return null
  if (typeof o.src !== 'string' || o.src.length > 4096) return null
  let u: URL
  try {
    u = new URL(o.src)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null
  if (!ALLOWED_SRC[provider as EmbedProvider](u)) return null
  const a = typeof o.aspect === 'number' && Number.isFinite(o.aspect) ? o.aspect : VIDEO
  return { provider: provider as EmbedProvider, src: u.href, aspect: Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, a)) }
}

/** Player URL to load after the person clicked play (autoplay where the provider supports it). */
export function playerSrc(e: Embed): string {
  if (e.provider !== 'youtube' && e.provider !== 'vimeo' && e.provider !== 'loom') return e.src
  const u = new URL(e.src)
  u.searchParams.set('autoplay', '1')
  return u.href
}
