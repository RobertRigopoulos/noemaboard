import { describe, expect, it } from 'vitest'
import {
  absoluteHttpUrl,
  basicPreview,
  cleanText,
  decodeHtml,
  extractHead,
  findHeadEnd,
  isAcceptedImageMime,
  parseContentType,
  parseLinkPreview,
  sniffCharset,
  sniffImageMime,
} from './htmlMeta'

const enc = new TextEncoder()

describe('parseContentType', () => {
  it('splits mime and charset', () => {
    expect(parseContentType('text/html; charset="ISO-8859-1"')).toEqual({ mime: 'text/html', charset: 'iso-8859-1' })
    expect(parseContentType('Application/XHTML+XML')).toEqual({ mime: 'application/xhtml+xml', charset: null })
    expect(parseContentType(undefined)).toEqual({ mime: '', charset: null })
  })
})

describe('charset sniffing', () => {
  it('prefers BOM, then header, then meta, then utf-8', () => {
    expect(sniffCharset(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]), 'iso-8859-1')).toBe('utf-8')
    expect(sniffCharset(enc.encode('<meta charset="shift_jis">'), 'windows-1252')).toBe('windows-1252')
    expect(sniffCharset(enc.encode('<head><meta charset="windows-1252"></head>'), null)).toBe('windows-1252')
    expect(sniffCharset(enc.encode('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-2">'), null)).toBe('iso-8859-2')
    expect(sniffCharset(enc.encode('<meta charset="utf-16">'), null)).toBe('utf-8')
    expect(sniffCharset(enc.encode('<meta charset="bogus-enc">'), 'also-bogus')).toBe('utf-8')
  })

  it('decodes legacy encodings', () => {
    const latin1 = new Uint8Array([...enc.encode('<title>Caf'), 0xe9, ...enc.encode('</title>')])
    expect(decodeHtml(latin1, 'windows-1252')).toBe('<title>Café</title>')
  })
})

describe('findHeadEnd', () => {
  it('finds </head case-insensitively', () => {
    const b = enc.encode('<html><HEAD><title>x</title></HeAd><body>')
    expect(findHeadEnd(b)).toBeGreaterThan(0)
    expect(findHeadEnd(enc.encode('<html><head>'))).toBe(-1)
  })
})

describe('parseLinkPreview', () => {
  const html = `<!doctype html><html><head>
    <base href="https://cdn.example.com/assets/">
    <title>  Fallback   title </title>
    <meta property="og:title" content="Open &amp; Graph">
    <meta property="og:description" content="A   description
      over lines">
    <meta property="og:site_name" content="Example">
    <meta property="og:image" content="img/cover.png">
    <meta property="og:image" content="https://example.com/second.png">
    <link rel="icon" href="/favicon-16.png" sizes="16x16">
    <link rel="icon" href="/favicon-64.png" sizes="64x64">
    <svg><title>not the title</title></svg>
  </head><body><meta property="og:title" content="ignored"></body></html>`

  it('extracts OpenGraph data with relative URLs resolved against <base>', () => {
    const p = parseLinkPreview(html, 'https://example.com/post/1')
    expect(p).toEqual({
      url: 'https://example.com/post/1',
      title: 'Open & Graph',
      description: 'A description over lines',
      siteName: 'Example',
      image: 'https://cdn.example.com/assets/img/cover.png',
      favicon: 'https://cdn.example.com/favicon-64.png',
    })
  })

  it('falls back to <title>, meta description, twitter cards and /favicon.ico', () => {
    const p = parseLinkPreview(
      '<head><title>Plain &lt;Title&gt;</title><meta name="description" content="Desc"><meta name="twitter:image" content="//img.example.org/t.jpg"></head>',
      'http://www.example.org/x',
    )
    expect(p.title).toBe('Plain <Title>')
    expect(p.description).toBe('Desc')
    expect(p.siteName).toBe('example.org')
    expect(p.image).toBe('http://img.example.org/t.jpg')
    expect(p.favicon).toBe('http://www.example.org/favicon.ico')
  })

  it('drops non-http image URLs and uses the hostname as last resort', () => {
    const p = parseLinkPreview('<meta property="og:image" content="javascript:alert(1)">', 'https://example.net/')
    expect(p.image).toBeNull()
    expect(p.title).toBe('example.net')
  })

  it('caps very long values', () => {
    const p = parseLinkPreview(`<title>${'x'.repeat(5000)}</title>`, 'https://example.net/')
    expect(p.title.length).toBeLessThanOrEqual(300)
  })

  it('ignores a <base> with a dangerous scheme', () => {
    const head = extractHead('<base href="javascript:alert(1)//"><meta property="og:image" content="a.png">')
    expect(head.baseHref).toBe('javascript:alert(1)//')
    expect(parseLinkPreview('<base href="javascript:alert(1)//"><meta property="og:image" content="a.png">', 'https://e.com/d/').image).toBe(
      'https://e.com/d/a.png',
    )
  })
})

describe('basicPreview', () => {
  it('names non-HTML resources after their file', () => {
    expect(basicPreview('https://example.com/docs/My%20Report.pdf', false)).toMatchObject({ title: 'My Report.pdf', image: null, siteName: 'example.com' })
    expect(basicPreview('https://example.com/cat.png', true).image).toBe('https://example.com/cat.png')
  })
})

describe('helpers', () => {
  it('cleanText strips control characters and collapses whitespace', () => {
    expect(cleanText(' a\u0000b \n\t c\u202e ', 100)).toBe('ab c')
    expect(cleanText('abcdef', 4)).toBe('abc…')
  })

  it('absoluteHttpUrl only keeps http(s)', () => {
    expect(absoluteHttpUrl('data:image/png;base64,AAA', 'https://e.com/')).toBeNull()
    expect(absoluteHttpUrl('https://u:p@e.com/x', 'https://e.com/')).toBeNull()
    expect(absoluteHttpUrl('../x.png', 'https://e.com/a/b/')).toBe('https://e.com/a/x.png')
  })

  it('sniffs raster images and never SVG', () => {
    expect(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png')
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffImageMime(enc.encode('GIF89a....'))).toBe('image/gif')
    expect(sniffImageMime(enc.encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffImageMime(enc.encode('\0\0\0\x1cftypavif'))).toBe('image/avif')
    expect(sniffImageMime(enc.encode('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull()
    expect(isAcceptedImageMime('image/svg+xml')).toBe(false)
    expect(isAcceptedImageMime('image/png')).toBe(true)
    expect(isAcceptedImageMime('text/html')).toBe(false)
  })
})
