/**
 * Splits plain comment text into text, link and mention segments. Only http(s) and mailto links are
 * produced; everything else (javascript:, data:, file:, ...) stays plain text. Segments are rendered
 * as React text, never as HTML.
 */

export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'mention'; text: string; id: string }

/** A person a message mentions, with the name its '@Name' text uses. */
export interface MentionName {
  id: string
  name: string
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/** '@Name' at `at` in `text` stands on its own: not glued to a word before or after it. */
function isMentionAt(text: string, at: number, name: string): boolean {
  if (text[at] !== '@' || text.slice(at + 1, at + 1 + name.length) !== name) return false
  const before = at > 0 ? text[at - 1] : ''
  if (before && (WORD_CHAR.test(before) || before === '@')) return false
  const after = text[at + 1 + name.length] ?? ''
  return !after || !WORD_CHAR.test(after)
}

/** True when the text names `name` as '@Name' (exact name, standing on its own). */
export function containsMention(text: string, name: string): boolean {
  if (!name || typeof text !== 'string') return false
  for (let at = text.indexOf('@' + name); at >= 0; at = text.indexOf('@' + name, at + 1)) {
    if (isMentionAt(text, at, name)) return true
  }
  return false
}

/** Non-overlapping '@Name' runs, left to right; at one position the longest name wins. */
function mentionRuns(text: string, mentions: readonly MentionName[]): { start: number; end: number; id: string }[] {
  const named = mentions.filter((m) => m && typeof m.name === 'string' && m.name && typeof m.id === 'string')
  if (!named.length || !text.includes('@')) return []
  const byLength = [...named].sort((a, b) => b.name.length - a.name.length)
  const runs: { start: number; end: number; id: string }[] = []
  for (let at = text.indexOf('@'); at >= 0; ) {
    const hit = byLength.find((m) => isMentionAt(text, at, m.name))
    if (hit) {
      const end = at + 1 + hit.name.length
      runs.push({ start: at, end, id: hit.id })
      at = text.indexOf('@', end)
    } else at = text.indexOf('@', at + 1)
  }
  return runs
}

const URL_MAX = 2048

// http(s)://…, www.…, mailto:…, or a bare e-mail address.
const LINK_RE = /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+|\bmailto:[^\s<>"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gi

const TRAILING = /[.,;:!?'"*_~]$/

/** Drops sentence punctuation and unbalanced closing brackets picked up at the end of a match. */
export function trimTrailing(raw: string): string {
  let s = raw
  for (;;) {
    if (TRAILING.test(s)) {
      s = s.slice(0, -1)
      continue
    }
    const last = s[s.length - 1]
    const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' }
    if (last && pairs[last]) {
      const open = pairs[last]
      const opens = s.split(open).length - 1
      const closes = s.split(last).length - 1
      if (closes > opens) {
        s = s.slice(0, -1)
        continue
      }
    }
    return s
  }
}

/** Normalised href for a matched link, or null when it is not a safe http(s)/mailto URL. */
export function safeHref(raw: string): string | null {
  if (!raw || raw.length > URL_MAX) return null
  let candidate = raw
  if (/^www\./i.test(candidate)) candidate = `https://${candidate}`
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate) && candidate.includes('@')) candidate = `mailto:${candidate}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (!url.hostname) return null
    return url.href
  }
  if (url.protocol === 'mailto:') {
    return /^[^\s@]+@[^\s@]+$/.test(decodeSafe(url.pathname)) ? url.href : null
  }
  return null
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Splits text into segments. With `mentions`, every '@Name' run naming one of them becomes a
 * mention segment (only people the message really lists, so typing '@Someone' by hand is just text).
 */
export function linkify(text: string, mentions: readonly MentionName[] = []): TextSegment[] {
  if (typeof text !== 'string' || !text) return []
  const runs = mentionRuns(text, mentions)
  if (!runs.length) return linkifyPlain(text)
  const out: TextSegment[] = []
  const pushAll = (segs: TextSegment[]) => {
    for (const s of segs) {
      const prev = out[out.length - 1]
      if (s.kind === 'text' && prev && prev.kind === 'text') prev.text += s.text
      else out.push(s)
    }
  }
  let last = 0
  for (const r of runs) {
    pushAll(linkifyPlain(text.slice(last, r.start)))
    out.push({ kind: 'mention', text: text.slice(r.start, r.end), id: r.id })
    last = r.end
  }
  pushAll(linkifyPlain(text.slice(last)))
  return out
}

function linkifyPlain(text: string): TextSegment[] {
  if (!text) return []
  const out: TextSegment[] = []
  let last = 0
  const push = (t: string) => {
    if (!t) return
    const prev = out[out.length - 1]
    if (prev && prev.kind === 'text') prev.text += t
    else out.push({ kind: 'text', text: t })
  }
  LINK_RE.lastIndex = 0
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) {
    const matched = trimTrailing(m[0])
    const start = m.index
    const href = matched ? safeHref(matched) : null
    if (!href) continue
    push(text.slice(last, start))
    out.push({ kind: 'link', text: matched, href })
    last = start + matched.length
    // Resume right after the trimmed link so trailing punctuation stays text.
    LINK_RE.lastIndex = last
  }
  push(text.slice(last))
  return out
}

// ---------------------------------------------------------------------------
// Typing a mention

/** Longest query looked at after '@' (names are at most 60 characters, usually far shorter). */
const QUERY_MAX = 40

/**
 * The '@query' being typed right before `caret`: '@' at the start of the text or after whitespace,
 * on the same line, not followed directly by a space. Names may contain spaces ('@Ana Lu').
 */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  if (typeof text !== 'string' || caret < 1 || caret > text.length) return null
  for (let i = caret - 1; i >= 0 && caret - i <= QUERY_MAX + 1; i--) {
    const ch = text[i]
    if (ch === '\n') return null
    if (ch !== '@') continue
    const prev = i > 0 ? text[i - 1] : ''
    if (prev && !/\s/.test(prev)) return null
    const query = text.slice(i + 1, caret)
    if (query.startsWith(' ')) return null
    return { start: i, query }
  }
  return null
}

/** Replaces '@query' (from `start` to `caret`) with '@Name ' and returns the new text and caret. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const rest = text.slice(caret)
  const spacer = /^\s/.test(rest) ? '' : ' '
  const inserted = `@${name}${spacer}`
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length + (spacer ? 0 : 1) }
}

/**
 * People whose name starts with the query, then people with a later word starting with it
 * (case-insensitive), in the given order within each group; at most `max`.
 */
export function matchPeople<T extends { name: string }>(people: readonly T[], query: string, max = 8): T[] {
  const q = query.toLocaleLowerCase()
  const first: T[] = []
  const later: T[] = []
  for (const p of people) {
    const name = p.name.toLocaleLowerCase()
    if (name.startsWith(q)) first.push(p)
    else if (name.split(/\s+/).some((w, i) => i > 0 && w.startsWith(q))) later.push(p)
  }
  return [...first, ...later].slice(0, max)
}
