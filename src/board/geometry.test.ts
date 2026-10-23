import { describe, expect, it } from 'vitest'
import { getCardElement, registerCardElement, unregisterCardElement } from './geometry'

const fakeEl = () => ({ dataset: {} }) as unknown as HTMLElement

describe('card element registry', () => {
  it('keeps the new element when the old shell of a re-parented card is cleaned up last', () => {
    const oldEl = fakeEl()
    const newEl = fakeEl()
    registerCardElement('c1', oldEl)
    // Moving into a column: the new shell registers, then the old shell's cleanup runs.
    registerCardElement('c1', newEl)
    unregisterCardElement('c1', oldEl)
    expect(getCardElement('c1')).toBe(newEl)
    expect(newEl.dataset.cardId).toBe('c1')
    unregisterCardElement('c1', newEl)
    expect(getCardElement('c1')).toBeUndefined()
  })

  it('still supports the legacy null form', () => {
    const el = fakeEl()
    registerCardElement('c2', el)
    registerCardElement('c2', null)
    expect(getCardElement('c2')).toBeUndefined()
  })
})
