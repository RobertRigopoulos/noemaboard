import { describe, expect, it } from 'vitest'
import { countWords, formatWordCount, previewText } from './docText'

describe('countWords', () => {
  it('counts words across punctuation and lines', () => {
    expect(countWords('')).toBe(0)
    expect(countWords('Hello, world!\nIt’s a test-case for v1.2 — ok?')).toBe(8)
    expect(countWords("don't stop")).toBe(2)
  })
  it('counts each CJK character as a word', () => {
    expect(countWords('日本語 text')).toBe(4)
  })
})

describe('previewText', () => {
  it('drops a first line that repeats the title and joins lines', () => {
    expect(previewText('Plan\nFirst   point\n\nSecond', 'plan')).toBe('First point Second')
  })
  it('cuts long text at a word boundary with an ellipsis', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'
    const out = previewText(text, '', 30)
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(31)
    expect(text.startsWith(out.slice(0, -1))).toBe(true)
  })
})

describe('formatWordCount', () => {
  it('pluralises', () => {
    expect(formatWordCount(1)).toBe('1 word')
    expect(formatWordCount(0)).toBe('0 words')
  })
})
