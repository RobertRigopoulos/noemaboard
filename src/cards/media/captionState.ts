/** What the Caption action does for an image or link card. Pure. */

export type CaptionAction = 'add' | 'hide' | 'show'

/** Empty caption: add one. Caption with text: hide it, or show it again when hidden. */
export function captionState(hasText: boolean, hidden: boolean): CaptionAction {
  if (!hasText) return 'add'
  return hidden ? 'show' : 'hide'
}

export const CAPTION_LABELS: Record<CaptionAction, string> = {
  add: 'Add caption',
  hide: 'Hide caption',
  show: 'Show caption',
}

/** `captionHidden` as written by anyone: only a literal true hides. */
export function readCaptionHidden(card: unknown): boolean {
  return !!card && typeof card === 'object' && (card as Record<string, unknown>).captionHidden === true
}
