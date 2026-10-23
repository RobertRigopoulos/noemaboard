import { describe, expect, it } from 'vitest'
import { ACTIVATABLE_SELECTOR, activatesControl, isActivationKey } from './keyGuard'

/** Minimal stand-in for a DOM element: `closest` answers for the selector we use. */
const el = (isControl: boolean) => ({ closest: (sel: string) => (sel === ACTIVATABLE_SELECTOR && isControl ? {} : null) })
const button = el(true) as unknown as EventTarget
const plain = el(false) as unknown as EventTarget

describe('isActivationKey', () => {
  it('recognises Enter and Space (by key or physical code)', () => {
    expect(isActivationKey({ key: 'Enter' })).toBe(true)
    expect(isActivationKey({ key: ' ' })).toBe(true)
    expect(isActivationKey({ key: 'Spacebar' })).toBe(true)
    expect(isActivationKey({ key: 'Unidentified', code: 'Space' })).toBe(true)
    expect(isActivationKey({ key: 'n', code: 'KeyN' })).toBe(false)
    expect(isActivationKey({ key: 'Escape' })).toBe(false)
  })
})

describe('activatesControl', () => {
  it('claims Space/Enter on buttons so they activate instead of panning or editing a card', () => {
    expect(activatesControl({ key: 'Enter', target: button })).toBe(true)
    expect(activatesControl({ key: ' ', code: 'Space', target: button })).toBe(true)
  })
  it('leaves other keys and non-control targets to the board', () => {
    expect(activatesControl({ key: 'n', target: button })).toBe(false)
    expect(activatesControl({ key: 'Delete', target: button })).toBe(false)
    expect(activatesControl({ key: 'Enter', target: plain })).toBe(false)
    expect(activatesControl({ key: 'Enter', target: null })).toBe(false)
  })
  it('covers menu items and toggles, not just <button>', () => {
    for (const part of ['button', 'a[href]', '[role="button"]', '[role="menuitem"]', '[role="radio"]']) {
      expect(ACTIVATABLE_SELECTOR).toContain(part)
    }
  })
})
