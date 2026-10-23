import { describe, expect, it } from 'vitest'
import { strayKeyAction } from './modalGuard'

const key = (k: string) => ({ key: k })

describe('strayKeyAction (keys while focus is outside the top dialog)', () => {
  it('leaves keys inside the dialog to its own handlers', () => {
    for (const k of ['n', 'Tab', 'Escape', 'Enter', ' ']) expect(strayKeyAction(key(k), true, false)).toBe('ignore')
  })

  it('brings focus back for typing, keeping the character so it lands in the dialog field', () => {
    // First-run name prompt: "Nathan" typed after clicking the backdrop must not add a note.
    expect(strayKeyAction(key('n'), false, false)).toBe('refocus')
    expect(strayKeyAction(key('N'), false, false)).toBe('refocus')
    expect(strayKeyAction(key('Delete'), false, false)).toBe('refocus')
    expect(strayKeyAction(key('ArrowLeft'), false, false)).toBe('refocus')
  })

  it('never lets Enter or Space activate whatever receives focus', () => {
    expect(strayKeyAction(key('Enter'), false, false)).toBe('refocus-block')
    expect(strayKeyAction(key(' '), false, false)).toBe('refocus-block')
    expect(strayKeyAction(key('Spacebar'), false, false)).toBe('refocus-block')
  })

  it('traps Tab and handles Escape for the dialog', () => {
    expect(strayKeyAction(key('Tab'), false, false)).toBe('tab')
    expect(strayKeyAction(key('Escape'), false, false)).toBe('dismiss')
  })

  it('lets exempt overlays (toasts) keep their keys, except Tab which returns to the dialog', () => {
    expect(strayKeyAction(key('Enter'), false, true)).toBe('ignore')
    expect(strayKeyAction(key('Escape'), false, true)).toBe('ignore')
    expect(strayKeyAction(key('Tab'), false, true)).toBe('tab')
  })
})
