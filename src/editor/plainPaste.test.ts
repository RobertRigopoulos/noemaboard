import { afterEach, describe, expect, it } from 'vitest'
import { endPlainPaste, isPlainTextPaste, notePasteKey } from './plainPaste'

const key = (over: Partial<KeyboardEvent>) => ({ key: 'v', code: 'KeyV', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over })

afterEach(() => endPlainPaste())

describe('plain-text paste shortcut', () => {
  it('notes Ctrl+Shift+V and Cmd+Shift+V for the paste that follows', () => {
    notePasteKey(key({ key: 'V', ctrlKey: true, shiftKey: true }), 1000)
    expect(isPlainTextPaste(1200)).toBe(true)
    endPlainPaste()
    notePasteKey(key({ key: 'V', metaKey: true, shiftKey: true }), 1000)
    expect(isPlainTextPaste(1200)).toBe(true)
  })

  it('does not count an ordinary paste, other keys or a paste much later', () => {
    notePasteKey(key({ ctrlKey: true }), 1000)
    expect(isPlainTextPaste(1001)).toBe(false)
    notePasteKey(key({ key: 'b', code: 'KeyB', ctrlKey: true, shiftKey: true }), 1000)
    expect(isPlainTextPaste(1001)).toBe(false)
    notePasteKey(key({ ctrlKey: true, shiftKey: true }), 1000)
    expect(isPlainTextPaste(5000)).toBe(false)
  })

  it('is cleared by a following ordinary Ctrl+V', () => {
    notePasteKey(key({ ctrlKey: true, shiftKey: true }), 1000)
    notePasteKey(key({ ctrlKey: true }), 1100)
    expect(isPlainTextPaste(1150)).toBe(false)
  })

  it('works on keyboard layouts where V is elsewhere (by key) and by physical key', () => {
    notePasteKey(key({ key: 'v', code: 'KeyK', ctrlKey: true, shiftKey: true }), 1000)
    expect(isPlainTextPaste(1001)).toBe(true)
  })
})
