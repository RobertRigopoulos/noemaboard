/**
 * Which parts of a link card are shown. The fields are user content (not derived from the preview),
 * and absent means shown, so cards from older clients look as before. Pure.
 */

export interface LinkDisplay {
  hideImage: boolean
  hideDescription: boolean
  hideUrl: boolean
  /** Show the preview instead of the inline player for embeddable links. */
  embedAsLink: boolean
}

export const LINK_DISPLAY_KEYS = ['hideImage', 'hideDescription', 'hideUrl', 'embedAsLink'] as const

/** Only a literal true counts (peers may write anything). */
export function readLinkDisplay(card: unknown): LinkDisplay {
  const o = card && typeof card === 'object' ? (card as Record<string, unknown>) : {}
  return {
    hideImage: o.hideImage === true,
    hideDescription: o.hideDescription === true,
    hideUrl: o.hideUrl === true,
    embedAsLink: o.embedAsLink === true,
  }
}

export interface LinkParts {
  /** Picture area: the inline player, the preview image, or nothing. */
  media: 'embed' | 'image' | null
  description: boolean
  /** The site / address line. */
  address: boolean
  /** Only the title is left: the card renders as a compact row. */
  titleOnly: boolean
}

/** Parts to render given the display toggles and what the preview actually has. */
export function linkParts(d: LinkDisplay, has: { image: boolean; description: boolean; embed: boolean }): LinkParts {
  const media = d.hideImage ? null : has.embed && !d.embedAsLink ? 'embed' : has.image ? 'image' : null
  const description = has.description && !d.hideDescription
  const address = !d.hideUrl
  return { media, description, address, titleOnly: !media && !description && !address }
}

/** Patch that flips one toggle: hiding writes true, showing removes the field. */
export function toggleLinkField(d: LinkDisplay, key: (typeof LINK_DISPLAY_KEYS)[number]): Record<string, true | undefined> {
  return { [key]: d[key] ? undefined : true }
}
