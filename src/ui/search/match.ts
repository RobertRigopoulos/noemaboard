/**
 * Text matching for search: case- and accent-insensitive, every query word must appear,
 * with highlight ranges mapped back to the original text for snippets.
 */

export interface Folded {
  /** Lower-case text without diacritics. */
  text: string
  /** For each folded char, the index of the original char it came from (+ a final sentinel). */
  map: number[]
}

const MARKS = /\p{M}/gu

/** Folds text for matching while remembering where each folded char came from. */
export function fold(s: string): Folded {
  let text = ''
  const map: number[] = []
  let i = 0
  for (const ch of s) {
    const f = ch.normalize('NFD').replace(MARKS, '').toLowerCase()
    for (let k = 0; k < f.length; k++) map.push(i)
    text += f
    i += ch.length
  }
  map.push(s.length)
  return { text, map }
}

export const MAX_TERMS = 8

/** Splits a query into folded words (deduplicated, longest first so overlaps highlight well). */
export function parseQuery(q: string): string[] {
  const terms = fold(q.slice(0, 200))
    .text.split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
  return Array.from(new Set(terms))
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_TERMS)
}

/** Names accepted by `type:` (folded), mapped to the item types they find. */
export const TYPE_OPERATOR_NAMES: Readonly<Record<string, readonly string[]>> = {
  note: ['note'],
  notes: ['note'],
  todo: ['todo'],
  todos: ['todo'],
  'to-do': ['todo'],
  task: ['todo'],
  tasks: ['todo'],
  link: ['link'],
  links: ['link'],
  image: ['image'],
  images: ['image'],
  photo: ['image'],
  file: ['file'],
  files: ['file'],
  board: ['board', 'board-title'],
  boards: ['board', 'board-title'],
  column: ['column'],
  columns: ['column'],
  comment: ['comment'],
  comments: ['comment'],
  color: ['swatch'],
  colour: ['swatch'],
  swatch: ['swatch'],
  sketch: ['sketch'],
  sketches: ['sketch'],
  drawing: ['sketch'],
  document: ['document'],
  documents: ['document'],
  doc: ['document'],
  line: ['line'],
  lines: ['line'],
}

export interface ParsedQuery {
  /** Plain words (folded, deduplicated, longest first). */
  terms: string[]
  /** "Quoted phrases" (folded, inner whitespace collapsed). */
  phrases: string[]
  /** From type:… operators; empty = any type. */
  types: string[]
  /** From in:… operators (folded board-name fragments); empty = any board. */
  boards: string[]
  /** The plain words in their original order (folded), for the whole-query phrase bonus. */
  text: string
}

const MAX_PHRASES = 4
const MAX_OPERATORS = 6

/**
 * Splits a query into words, "exact phrases" and operators: type:<card type> and in:"Board name"
 * (in:word works too). Unknown operators and unknown types stay plain text, so "10:30" or
 * "type:foo" still find what they say.
 */
export function parseSearchQuery(q: string): ParsedQuery {
  const src = q.slice(0, 200)
  const phrases: string[] = []
  const types = new Set<string>()
  const boards: string[] = []
  const words: string[] = []
  // in:"…" | type:value | "…" | word
  const re = /(\bin:"([^"]*)"?)|(\b(type|in):(\S+))|("([^"]*)"?)|(\S+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    if (m[1] !== undefined) {
      const name = fold(m[2].replace(/\s+/g, ' ').trim()).text
      if (name && boards.length < MAX_OPERATORS) boards.push(name)
    } else if (m[3] !== undefined) {
      const op = m[4].toLowerCase()
      const value = fold(m[5]).text
      if (op === 'type' && TYPE_OPERATOR_NAMES[value] && types.size < MAX_OPERATORS) TYPE_OPERATOR_NAMES[value].forEach((t) => types.add(t))
      else if (op === 'in' && value && boards.length < MAX_OPERATORS) boards.push(value)
      else words.push(m[3])
    } else if (m[6] !== undefined) {
      const phrase = fold(m[7].replace(/\s+/g, ' ').trim()).text
      if (!phrase) continue
      // A quoted single word is just a word.
      if (!phrase.includes(' ')) words.push(phrase)
      else if (phrases.length < MAX_PHRASES && !phrases.includes(phrase)) phrases.push(phrase)
    } else words.push(m[8])
  }
  const text = fold(words.join(' ').replace(/\s+/g, ' ').trim()).text
  return { terms: parseQuery(text), phrases, types: [...types], boards, text }
}

/** True when the query asks for something (words, phrases or a filter operator). */
export function hasCriteria(p: ParsedQuery): boolean {
  return p.terms.length > 0 || p.phrases.length > 0 || p.types.length > 0 || p.boards.length > 0
}

export interface Range {
  start: number
  end: number
}

/** Merges overlapping/adjacent ranges. */
export function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** All occurrences of every term, as ranges in the ORIGINAL string. Empty if no term occurs. */
export function findRanges(folded: Folded, terms: string[], limit = 50): Range[] {
  const out: Range[] = []
  for (const t of terms) {
    let from = 0
    while (out.length < limit) {
      const i = folded.text.indexOf(t, from)
      if (i < 0) break
      out.push({ start: folded.map[i], end: folded.map[i + t.length] ?? folded.map[folded.map.length - 1] })
      from = i + Math.max(1, t.length)
    }
  }
  return mergeRanges(out)
}

/** True when every term occurs somewhere in at least one of the folded fields. */
export function matchesAll(fields: Folded[], terms: string[]): boolean {
  return terms.every((t) => fields.some((f) => f.text.includes(t)))
}

export interface SnippetPart {
  text: string
  hit: boolean
}

/** Splits text into plain/highlighted parts. */
export function highlight(text: string, ranges: Range[]): SnippetPart[] {
  const parts: SnippetPart[] = []
  let pos = 0
  for (const r of ranges) {
    if (r.start > pos) parts.push({ text: text.slice(pos, r.start), hit: false })
    if (r.end > r.start) parts.push({ text: text.slice(r.start, r.end), hit: true })
    pos = Math.max(pos, r.end)
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), hit: false })
  return parts
}

/**
 * A single-line excerpt around the first match with all matches highlighted.
 * `max` is the excerpt length budget in characters.
 */
export function makeSnippet(text: string, terms: string[], max = 140): SnippetPart[] {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return []
  const folded = fold(flat)
  const ranges = findRanges(folded, terms)
  if (!ranges.length) return [{ text: flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat, hit: false }]
  const first = ranges[0]
  let start = 0
  if (flat.length > max) {
    // Show some context before the first hit, starting at a word boundary.
    start = Math.max(0, Math.min(first.start - Math.floor(max / 3), flat.length - max))
    if (start > 0) {
      const space = flat.lastIndexOf(' ', start)
      if (space > start - 15 && space >= 0) start = space + 1
    }
  }
  const end = Math.min(flat.length, start + max)
  const slice = flat.slice(start, end)
  const local = ranges
    .filter((r) => r.end > start && r.start < end)
    .map((r) => ({ start: Math.max(0, r.start - start), end: Math.min(slice.length, r.end - start) }))
  const parts = highlight(slice, local)
  if (start > 0) parts.unshift({ text: '…', hit: false })
  if (end < flat.length) parts.push({ text: '…', hit: false })
  return parts
}

/**
 * Relevance: title hits beat body hits, whole-word and prefix hits beat infix hits,
 * the full query as a phrase gets a bonus.
 */
export function scoreFields(title: Folded, body: Folded, terms: string[], phrase: string): number {
  let score = 0
  for (const t of terms) {
    const ti = title.text.indexOf(t)
    if (ti >= 0) {
      score += 10
      if (ti === 0) score += 6
      else if (/\W/.test(title.text[ti - 1] ?? ' ')) score += 3
    } else if (body.text.indexOf(t) >= 0) {
      score += 3
      const bi = body.text.indexOf(t)
      if (bi === 0 || /\W/.test(body.text[bi - 1] ?? ' ')) score += 1
    }
  }
  if (phrase && terms.length > 1) {
    if (title.text.includes(phrase)) score += 12
    else if (body.text.includes(phrase)) score += 4
  }
  if (title.text === phrase) score += 20
  return score
}
