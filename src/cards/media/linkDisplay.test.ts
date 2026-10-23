import { describe, expect, it } from 'vitest'
import { linkParts, readLinkDisplay, toggleLinkField } from './linkDisplay'

const all = { image: true, description: true, embed: false }

describe('readLinkDisplay', () => {
  it('counts only literal true', () => {
    expect(readLinkDisplay({ hideImage: true, hideDescription: 'true', hideUrl: 1, embedAsLink: {} })).toEqual({
      hideImage: true,
      hideDescription: false,
      hideUrl: false,
      embedAsLink: false,
    })
    expect(readLinkDisplay(undefined)).toEqual({ hideImage: false, hideDescription: false, hideUrl: false, embedAsLink: false })
  })

  it('hides by writing true and shows by removing the field', () => {
    const d = readLinkDisplay({ hideUrl: true })
    expect(toggleLinkField(d, 'hideUrl')).toEqual({ hideUrl: undefined })
    expect(toggleLinkField(d, 'hideImage')).toEqual({ hideImage: true })
  })
})

describe('linkParts', () => {
  it('shows everything by default', () => {
    expect(linkParts(readLinkDisplay({}), all)).toEqual({ media: 'image', description: true, address: true, titleOnly: false })
  })

  it('renders each combination of toggles', () => {
    for (const hideImage of [false, true]) {
      for (const hideDescription of [false, true]) {
        for (const hideUrl of [false, true]) {
          const p = linkParts({ hideImage, hideDescription, hideUrl, embedAsLink: false }, all)
          expect(p.media).toBe(hideImage ? null : 'image')
          expect(p.description).toBe(!hideDescription)
          expect(p.address).toBe(!hideUrl)
          expect(p.titleOnly).toBe(hideImage && hideDescription && hideUrl)
        }
      }
    }
  })

  it('plays embeds inline unless shown as a link', () => {
    const embed = { image: true, description: false, embed: true }
    expect(linkParts(readLinkDisplay({}), embed).media).toBe('embed')
    expect(linkParts(readLinkDisplay({ embedAsLink: true }), embed).media).toBe('image')
    expect(linkParts(readLinkDisplay({ embedAsLink: true }), { ...embed, image: false }).media).toBeNull()
    expect(linkParts(readLinkDisplay({ hideImage: true }), embed).media).toBeNull()
  })

  it('is a title-only row when nothing else is available or shown', () => {
    expect(linkParts(readLinkDisplay({ hideUrl: true }), { image: false, description: false, embed: false }).titleOnly).toBe(true)
  })
})
