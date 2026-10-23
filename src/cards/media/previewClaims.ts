/**
 * Link cards whose preview THIS device asked for: it created the card, changed its URL, or someone
 * pressed "Retry" / "Load preview" here. Only those are fetched automatically.
 *
 * The doc's previewBy / createdBy fields are written by peers, so trusting them would let any board
 * member make a chosen teammate's desktop app fetch pages of their choosing just by adding cards.
 * Remembered in local storage (pruned) so a fetch interrupted by closing the app resumes later.
 */
import { loadJSON, saveJSON } from '../../collab/profile'

const STORAGE_KEY = 'link-preview-claims'
const MAX_CARDS = 500
/** URLs remembered per card, so undoing a URL change still refreshes the preview. */
const MAX_URLS_PER_CARD = 5
const CLAIM_TTL_MS = 30 * 24 * 3600 * 1000

type Claims = Record<string, { urls: string[]; t: number }>

let claims: Claims | null = null

const keyOf = (boardId: string, cardId: string) => `${boardId}/${cardId}`

function load(): Claims {
  if (!claims) {
    const raw = loadJSON<unknown>(STORAGE_KEY, {})
    claims = {}
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const e = v as { urls?: unknown; t?: unknown } | null
        if (!e || !Array.isArray(e.urls) || typeof e.t !== 'number') continue
        const urls = e.urls.filter((u): u is string => typeof u === 'string').slice(0, MAX_URLS_PER_CARD)
        if (urls.length) claims[k] = { urls, t: e.t }
      }
    }
  }
  return claims
}

/** Records that this device asked for the preview of `url` on this card. */
export function claimPreview(boardId: string, cardId: string, url: string, now = Date.now()) {
  const all = load()
  const key = keyOf(boardId, cardId)
  const urls = [url, ...(all[key]?.urls ?? []).filter((u) => u !== url)].slice(0, MAX_URLS_PER_CARD)
  all[key] = { urls, t: now }
  const entries = Object.entries(all).filter(([, e]) => now - e.t < CLAIM_TTL_MS)
  if (entries.length > MAX_CARDS) entries.sort((a, b) => b[1].t - a[1].t).splice(MAX_CARDS)
  claims = Object.fromEntries(entries)
  saveJSON(STORAGE_KEY, claims)
}

/** True when this device asked for the preview of exactly this URL on this card. */
export function hasPreviewClaim(boardId: string, cardId: string, url: string): boolean {
  return load()[keyOf(boardId, cardId)]?.urls.includes(url) ?? false
}
