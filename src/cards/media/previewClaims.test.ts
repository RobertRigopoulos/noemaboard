import { describe, expect, it } from 'vitest'
import { claimPreview, hasPreviewClaim } from './previewClaims'

describe('preview claims', () => {
  it('only covers the URLs this device asked for', () => {
    expect(hasPreviewClaim('b1', 'c1', 'https://a.example/')).toBe(false)
    claimPreview('b1', 'c1', 'https://a.example/')
    expect(hasPreviewClaim('b1', 'c1', 'https://a.example/')).toBe(true)
    // A peer changing the URL (or naming this person in previewBy) does not make this device fetch it.
    expect(hasPreviewClaim('b1', 'c1', 'https://attacker.example/u1/1')).toBe(false)
    expect(hasPreviewClaim('b1', 'c2', 'https://a.example/')).toBe(false)
    expect(hasPreviewClaim('b2', 'c1', 'https://a.example/')).toBe(false)
  })

  it('remembers the previous URLs of a card, so undoing a URL change refreshes the preview', () => {
    claimPreview('b4', 'c', 'https://one.example/')
    claimPreview('b4', 'c', 'https://two.example/')
    expect(hasPreviewClaim('b4', 'c', 'https://one.example/')).toBe(true)
    expect(hasPreviewClaim('b4', 'c', 'https://two.example/')).toBe(true)
    for (let i = 0; i < 5; i++) claimPreview('b4', 'c', `https://more${i}.example/`)
    expect(hasPreviewClaim('b4', 'c', 'https://one.example/')).toBe(false)
    expect(hasPreviewClaim('b4', 'c', 'https://more4.example/')).toBe(true)
  })

  it('forgets old claims', () => {
    const long = Date.now() - 40 * 24 * 3600 * 1000
    claimPreview('b3', 'old', 'https://old.example/', long)
    claimPreview('b3', 'new', 'https://new.example/')
    expect(hasPreviewClaim('b3', 'old', 'https://old.example/')).toBe(false)
    expect(hasPreviewClaim('b3', 'new', 'https://new.example/')).toBe(true)
  })
})
