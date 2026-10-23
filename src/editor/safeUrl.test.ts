import { describe, expect, it } from 'vitest'
import { isAllowedLinkTarget, isSafeHref, normalizeLinkInput } from './safeUrl'
import { isDrawableCaretState, isRelativePositionJSON, caretLabel } from './caret'
import { paletteValue, safeCssColor } from './palette'

describe('isSafeHref', () => {
  it('accepts absolute http(s) and mailto', () => {
    expect(isSafeHref('https://example.com')).toBe(true)
    expect(isSafeHref('http://example.com/path?q=1#x')).toBe(true)
    expect(isSafeHref('mailto:someone@example.com')).toBe(true)
  })
  it('rejects scripts, data, relative and malformed URLs', () => {
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', 'example.com', 'https://', 'mailto:', '', 42, null]) {
      expect(isSafeHref(bad)).toBe(false)
    }
  })
})

describe('isAllowedLinkTarget', () => {
  it('allows http(s), mailto and scheme-less values but no other schemes', () => {
    expect(isAllowedLinkTarget('https://a.b')).toBe(true)
    expect(isAllowedLinkTarget('example.com')).toBe(true)
    expect(isAllowedLinkTarget('mailto:a@b.co')).toBe(true)
    expect(isAllowedLinkTarget('javascript:alert(1)')).toBe(false)
    expect(isAllowedLinkTarget('jav\u0000ascript:alert(1)')).toBe(false)
    expect(isAllowedLinkTarget('file:///etc/passwd')).toBe(false)
  })
})

describe('normalizeLinkInput', () => {
  it('auto-prefixes https:// and recognises e-mail addresses', () => {
    expect(normalizeLinkInput('example.com')).toBe('https://example.com')
    expect(normalizeLinkInput('  www.example.com/a?b=c  ')).toBe('https://www.example.com/a?b=c')
    expect(normalizeLinkInput('localhost:5173')).toBe('https://localhost:5173')
    expect(normalizeLinkInput('example.com:8080/x')).toBe('https://example.com:8080/x')
    expect(normalizeLinkInput('someone@example.com')).toBe('mailto:someone@example.com')
    expect(normalizeLinkInput('http://example.com')).toBe('http://example.com')
    expect(normalizeLinkInput('//cdn.example.com/x')).toBe('https://cdn.example.com/x')
  })
  it('rejects unsafe or meaningless input', () => {
    for (const bad of ['', '   ', 'javascript:alert(1)', 'not a url', 'word', 'ftp://example.com', 'data:x']) {
      expect(normalizeLinkInput(bad)).toBeNull()
    }
  })
})

describe('caret state validation', () => {
  const pos = { type: { client: 1, clock: 4 }, tname: null, item: { client: 2, clock: 9 }, assoc: 0 }
  const state = { user: { name: 'Ada', color: '#30a46c' }, cursor: { anchor: pos, head: pos } }
  it('accepts well-formed states', () => {
    expect(isRelativePositionJSON(pos)).toBe(true)
    expect(isDrawableCaretState(state)).toBe(true)
  })
  it('rejects malformed peer data', () => {
    expect(isDrawableCaretState(null)).toBe(false)
    expect(isDrawableCaretState({ ...state, cursor: null })).toBe(false)
    expect(isDrawableCaretState({ ...state, cursor: { anchor: null, head: pos } })).toBe(false)
    expect(isDrawableCaretState({ ...state, user: { name: 'x', color: 'red; background:url(x)' } })).toBe(false)
    expect(isDrawableCaretState({ ...state, user: { name: 5, color: '#ffffff' } })).toBe(false)
    expect(isRelativePositionJSON({ ...pos, tname: 'cards' })).toBe(false)
    expect(isRelativePositionJSON({ type: null, tname: null, item: null })).toBe(false)
    expect(isRelativePositionJSON({ ...pos, item: { client: 'x', clock: 1 } })).toBe(false)
    expect(isRelativePositionJSON({ ...pos, assoc: 'left' })).toBe(false)
  })
  it('labels carets safely', () => {
    expect(caretLabel('  ')).toBe('Someone')
    expect(caretLabel(undefined)).toBe('Someone')
    expect(caretLabel('x'.repeat(100))).toHaveLength(40)
  })
})

describe('colors', () => {
  it('accepts only palette values from pasted HTML', () => {
    expect(paletteValue('var(--rt-hl-yellow)')).toBe('var(--rt-hl-yellow)')
    expect(paletteValue('rgb(51, 51, 51)')).toBeNull()
  })
  it('accepts plain CSS colors but no injection', () => {
    expect(safeCssColor('#abc')).toBe('#abc')
    expect(safeCssColor('rgba(1, 2, 3, 0.5)')).toBe('rgba(1, 2, 3, 0.5)')
    expect(safeCssColor('red')).toBe('red')
    expect(safeCssColor('red; background: url(x)')).toBeNull()
    expect(safeCssColor('url(https://x)')).toBeNull()
    expect(safeCssColor('expression(alert(1))')).toBeNull()
  })
})
