/**
 * Validation and trigger matching for @mentions. Pure (no editor), shared by the node, the static
 * renderer, plain-text extraction and the suggestion plugin.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/
export const MAX_MENTION_LABEL = 60

// Control, zero-width and bidirectional-override characters, built from code points so the source
// stays plain ASCII.
const CONTROL = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ]
    .map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`)
    .join('')}]`,
  'g',
)

/** A mention's member id, or null. */
export function cleanMentionId(value: unknown): string | null {
  return typeof value === 'string' && ID.test(value) ? value : null
}

/** A mention's label: control and direction-override characters removed, at most 60 characters. */
export function cleanMentionLabel(value: unknown): string {
  if (typeof value !== 'string') return ''
  return Array.from(value.replace(CONTROL, '').trim()).slice(0, MAX_MENTION_LABEL).join('').trim()
}

/** "@query" right before the caret, at the start of the text or after whitespace. */
export const MENTION_TRIGGER = /(^|\s)@([^\s@]{0,30})$/u

/**
 * The mention being typed at the end of `textBefore` (the text of the caret's block up to the
 * caret): the query and how many characters back the "@" is. Null when there is none, e.g. inside
 * an email address ("ada@example").
 */
export function matchMentionTrigger(textBefore: string): { query: string; length: number } | null {
  const m = MENTION_TRIGGER.exec(textBefore)
  if (!m) return null
  return { query: m[2], length: m[2].length + 1 }
}

/** True when `name` has a word starting with `query` (case- and accent-insensitive). */
export function nameMatches(name: string, query: string): boolean {
  if (!query) return true
  const fold = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
  const q = fold(query)
  return fold(name)
    .split(/[\s._-]+/)
    .some((word) => word.startsWith(q))
}
