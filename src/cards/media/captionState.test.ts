import { describe, expect, it } from 'vitest'
import { CAPTION_LABELS, captionState, readCaptionHidden } from './captionState'

describe('captionState', () => {
  it('adds an empty caption, else hides or shows it', () => {
    expect(captionState(false, false)).toBe('add')
    expect(captionState(false, true)).toBe('add')
    expect(captionState(true, false)).toBe('hide')
    expect(captionState(true, true)).toBe('show')
    expect(CAPTION_LABELS[captionState(true, true)]).toBe('Show caption')
  })

  it('hides only on a literal true', () => {
    expect(readCaptionHidden({ captionHidden: true })).toBe(true)
    expect(readCaptionHidden({ captionHidden: 'true' })).toBe(false)
    expect(readCaptionHidden({ captionHidden: 1 })).toBe(false)
    expect(readCaptionHidden(null)).toBe(false)
  })
})
