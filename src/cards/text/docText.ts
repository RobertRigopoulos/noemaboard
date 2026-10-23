/** Small pure text helpers for the document tile and the document editor. */

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
// Letters/digits, allowing inner apostrophes, dashes and dots ("don't", "e-mail", "v1.2").
const WORD = /[\p{L}\p{N}]+(?:[\p{Pd}\p{Pi}\p{Pf}'.][\p{L}\p{N}]+)*/gu

/** Counts words in any script: runs of letters/digits (CJK characters count one each). */
export function countWords(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK)?.length ?? 0
  const words = text.replace(CJK, ' ').match(WORD)?.length ?? 0
  return words + cjk
}

/**
 * Preview for a document tile: skips the first line when it repeats the title, joins the
 * remaining lines with spaces and cuts at a word boundary.
 */
export function previewText(text: string, title: string, max = 180): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length && title && lines[0].toLowerCase() === title.trim().toLowerCase()) lines.shift()
  const joined = lines.join(' ')
  if (joined.length <= max) return joined
  const cut = joined.slice(0, max)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '')}…`
}

export function formatWordCount(n: number): string {
  return n === 1 ? '1 word' : `${n.toLocaleString()} words`
}
