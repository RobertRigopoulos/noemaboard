import { describe, expect, it } from 'vitest'
import { extractSingleUrl, hostLabel, isHttpUrl, looksLikeImageUrl, normalizeUrl, parseUriList } from './url'

describe('normalizeUrl', () => {
  it('keeps valid http(s) URLs (canonicalised)', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeUrl('http://example.com/a?b=1#c')).toBe('http://example.com/a?b=1#c')
    expect(normalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path')
  })

  it('trims whitespace and common wrappers', () => {
    expect(normalizeUrl('  https://example.com/x  ')).toBe('https://example.com/x')
    expect(normalizeUrl('<https://example.com/x>')).toBe('https://example.com/x')
    expect(normalizeUrl('"https://example.com/x"')).toBe('https://example.com/x')
  })

  it('adds https:// when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/')
    expect(normalizeUrl('www.example.com/page')).toBe('https://www.example.com/page')
    expect(normalizeUrl('sub.domain.co.uk/a/b?q=1')).toBe('https://sub.domain.co.uk/a/b?q=1')
    expect(normalizeUrl('//cdn.example.com/x.js')).toBe('https://cdn.example.com/x.js')
  })

  it('treats host:port as a host, not a scheme', () => {
    expect(normalizeUrl('localhost:3000')).toBe('https://localhost:3000/')
    expect(normalizeUrl('example.com:8080/x')).toBe('https://example.com:8080/x')
    expect(normalizeUrl('192.168.1.10:8080')).toBe('https://192.168.1.10:8080/')
  })

  it('accepts only http and https', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeUrl('JavaScript:alert(1)')).toBeNull()
    expect(normalizeUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull()
    expect(normalizeUrl('ftp://example.com/file')).toBeNull()
    expect(normalizeUrl('file:///C:/secret.txt')).toBeNull()
    expect(normalizeUrl('vbscript:msgbox')).toBeNull()
  })

  it('rejects embedded credentials', () => {
    expect(normalizeUrl('https://user:pass@example.com')).toBeNull()
    expect(normalizeUrl('https://user@example.com')).toBeNull()
    expect(normalizeUrl('user:pass@example.com')).toBeNull()
    expect(normalizeUrl('user@example.com')).toBeNull()
    expect(normalizeUrl('https://example.com@evil.com')).toBeNull()
  })

  it('rejects things that are not web addresses', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
    expect(normalizeUrl('hello')).toBeNull()
    expect(normalizeUrl('hello world.com')).toBeNull()
    expect(normalizeUrl('https://')).toBeNull()
    expect(normalizeUrl('https://exa mple.com')).toBeNull()
    expect(normalizeUrl('https://example.123')).toBeNull()
    expect(normalizeUrl(42)).toBeNull()
    expect(normalizeUrl(null)).toBeNull()
    expect(normalizeUrl('https://example.com/' + 'a'.repeat(3000))).toBeNull()
  })

  it('accepts localhost, IP literals and IDNs', () => {
    expect(normalizeUrl('http://localhost/x')).toBe('http://localhost/x')
    expect(normalizeUrl('http://[::1]:8080/')).toBe('http://[::1]:8080/')
    expect(normalizeUrl('https://bücher.de')).toBe('https://xn--bcher-kva.de/')
  })
})

describe('isHttpUrl', () => {
  it('checks absolute http(s) URLs without credentials', () => {
    expect(isHttpUrl('https://a.com/x.png')).toBe(true)
    expect(isHttpUrl('http://a.com')).toBe(true)
    expect(isHttpUrl('a.com')).toBe(false)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('https://u:p@a.com')).toBe(false)
    expect(isHttpUrl(undefined)).toBe(false)
  })
})

describe('extractSingleUrl', () => {
  it('finds a single pasted link', () => {
    expect(extractSingleUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(extractSingleUrl('  https://example.com/a\n')).toBe('https://example.com/a')
    expect(extractSingleUrl('www.example.com')).toBe('https://www.example.com/')
  })

  it('leaves other text alone', () => {
    expect(extractSingleUrl('see https://example.com')).toBeNull()
    expect(extractSingleUrl('https://a.com https://b.com')).toBeNull()
    expect(extractSingleUrl('notes.txt')).toBeNull()
    expect(extractSingleUrl('example.com')).toBeNull()
    expect(extractSingleUrl('javascript:alert(1)')).toBeNull()
    expect(extractSingleUrl('')).toBeNull()
  })
})

describe('parseUriList', () => {
  it('reads URLs, skipping comments, blanks, duplicates and non-web schemes', () => {
    const list = '# comment\r\nhttps://a.com/1\r\n\r\nhttps://a.com/1\nfile:///etc/passwd\nhttps://b.com/2\n'
    expect(parseUriList(list)).toEqual(['https://a.com/1', 'https://b.com/2'])
  })

  it('caps the number of links', () => {
    const list = Array.from({ length: 50 }, (_, i) => `https://a.com/${i}`).join('\n')
    expect(parseUriList(list, 5)).toHaveLength(5)
  })

  it('handles empty input', () => {
    expect(parseUriList('')).toEqual([])
    expect(parseUriList(undefined)).toEqual([])
  })
})

describe('hostLabel / looksLikeImageUrl', () => {
  it('shows the host without www', () => {
    expect(hostLabel('https://www.example.com/x')).toBe('example.com')
    expect(hostLabel('https://docs.example.com')).toBe('docs.example.com')
    expect(hostLabel('not a url')).toBe('')
    expect(hostLabel(null)).toBe('')
  })

  it('recognises image paths', () => {
    expect(looksLikeImageUrl('https://a.com/pic.JPG?x=1')).toBe(true)
    expect(looksLikeImageUrl('https://a.com/pic.svg')).toBe(true)
    expect(looksLikeImageUrl('https://a.com/page.html')).toBe(false)
    expect(looksLikeImageUrl('https://a.com/?f=pic.png')).toBe(false)
  })
})
