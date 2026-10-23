import { beforeEach, describe, expect, it } from 'vitest'
import { usePanels, useSelection } from '../../board/store'
import { openImage, requestCaptionFocus, useCaptionFocus, useLightbox } from './lightboxStore'

describe('lightbox mode', () => {
  beforeEach(() => {
    usePanels.getState().setExpanded(null)
    useLightbox.setState({ mode: 'view', target: null, cropReturn: 'view' })
  })

  it('opens straight in the cropper and stays there while that image is shown', () => {
    openImage('a', 'crop')
    expect(useLightbox.getState()).toMatchObject({ mode: 'crop', target: 'a', cropReturn: 'close' })
    usePanels.getState().setExpanded('a')
    expect(useLightbox.getState().mode).toBe('crop')
  })

  it('goes back to viewing when the lightbox closes, from anywhere', () => {
    openImage('a', 'crop')
    usePanels.getState().setExpanded(null)
    expect(useLightbox.getState().mode).toBe('view')
    openImage('a', 'view')
    expect(useLightbox.getState().mode).toBe('view')
  })

  it('goes back to viewing when another card is shown', () => {
    openImage('a', 'crop')
    usePanels.getState().setExpanded('b')
    expect(useLightbox.getState().mode).toBe('view')
  })

  it('crops the image being viewed when asked from the viewer', () => {
    openImage('a')
    useLightbox.getState().startCrop()
    expect(useLightbox.getState()).toMatchObject({ mode: 'crop', target: 'a', cropReturn: 'view' })
  })
})

describe('caption focus', () => {
  beforeEach(() => {
    useSelection.getState().setEditing(null)
    useCaptionFocus.setState({ cardId: null })
  })

  it('lasts for the edit session it was asked for', () => {
    requestCaptionFocus('link')
    useSelection.getState().setEditing('link')
    expect(useCaptionFocus.getState().cardId).toBe('link')
    useSelection.getState().setEditing(null)
    expect(useCaptionFocus.getState().cardId).toBeNull()
  })

  it('is dropped when another card is edited', () => {
    requestCaptionFocus('link')
    useSelection.getState().setEditing('other')
    expect(useCaptionFocus.getState().cardId).toBeNull()
  })
})
