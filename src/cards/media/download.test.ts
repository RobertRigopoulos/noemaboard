import { describe, expect, it } from 'vitest'
import { looksLikePdf } from './download'
import { heicNotice, isHeic } from './import'
import { carriesFiles } from './dropGuard'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('looksLikePdf', () => {
  it('accepts a PDF header, also after some leading junk', () => {
    expect(looksLikePdf(bytes('%PDF-1.7\n...'))).toBe(true)
    expect(looksLikePdf(bytes('\xEF\xBB\xBF  %PDF-1.4'))).toBe(true)
  })

  it('rejects anything else (HTML or a program labelled as PDF)', () => {
    expect(looksLikePdf(bytes('<html><script>alert(1)</script>'))).toBe(false)
    expect(looksLikePdf(bytes('MZ\x90\x00'))).toBe(false)
    expect(looksLikePdf(bytes('%PDF'))).toBe(false)
    expect(looksLikePdf(new Uint8Array(0))).toBe(false)
    expect(looksLikePdf(new Uint8Array([...new Uint8Array(1100), ...bytes('%PDF-1.7')]))).toBe(false)
  })
})

describe('HEIC photos', () => {
  it('recognises HEIC/HEIF by type or name', () => {
    expect(isHeic('image/heic', 'IMG_1.HEIC')).toBe(true)
    expect(isHeic('image/heif-sequence', 'burst')).toBe(true)
    expect(isHeic('', 'IMG_2.heif')).toBe(true)
    expect(isHeic('image/jpeg', 'IMG_3.jpg')).toBe(false)
  })

  it('explains why they became files', () => {
    expect(heicNotice([])).toBeNull()
    expect(heicNotice(['IMG_1.HEIC'])).toMatch(/^“IMG_1\.HEIC” was added as a file: .*JPEG/)
    expect(heicNotice(['a.heic', 'b.heic'])).toMatch(/^2 photos were added as files/)
  })
})

describe('carriesFiles', () => {
  it('detects file drags', () => {
    expect(carriesFiles({ types: ['Files', 'text/uri-list'] } as unknown as DataTransfer)).toBe(true)
    expect(carriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false)
    expect(carriesFiles(null)).toBe(false)
  })
})
