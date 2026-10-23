import { describe, expect, it } from 'vitest'
import { chromeKeyAction, mouseNavAction, parentInChain, type ChromeKeyEvent, type ChromeKeyState } from './chromeKeys'

const key = (k: string, code: string, mods: Partial<ChromeKeyEvent> = {}): ChromeKeyEvent => ({
  key: k,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
})
const idle: ChromeKeyState = { typing: false, hasSelection: false, presenting: false, isHome: false }

describe('chromeKeyAction', () => {
  it('opens search for all boards or this board', () => {
    expect(chromeKeyAction(key('f', 'KeyF', { ctrlKey: true }), idle)).toBe('search-all')
    expect(chromeKeyAction(key('F', 'KeyF', { metaKey: true, shiftKey: true }), idle)).toBe('search-board')
    // Works while typing too (it replaces the browser's find), but not while presenting.
    expect(chromeKeyAction(key('f', 'KeyF', { ctrlKey: true }), { ...idle, typing: true })).toBe('search-all')
    expect(chromeKeyAction(key('f', 'KeyF', { ctrlKey: true }), { ...idle, presenting: true })).toBeNull()
  })

  it('opens the quick note with Mod+Alt+N, even when Option changed the key', () => {
    expect(chromeKeyAction(key('˜', 'KeyN', { metaKey: true, altKey: true }), idle)).toBe('quick-note')
    expect(chromeKeyAction(key('n', 'KeyN', { ctrlKey: true, altKey: true }), { ...idle, typing: true })).toBeNull()
    expect(chromeKeyAction(key('n', 'KeyN', { ctrlKey: true }), idle)).toBeNull()
  })

  it('navigates back and forward only when nothing is selected', () => {
    expect(chromeKeyAction(key('[', 'BracketLeft', { ctrlKey: true }), idle)).toBe('back')
    expect(chromeKeyAction(key(']', 'BracketRight', { metaKey: true }), idle)).toBe('forward')
    expect(chromeKeyAction(key('[', 'BracketLeft', { ctrlKey: true }), { ...idle, hasSelection: true })).toBeNull()
    // Layouts where the bracket needs another key still match the physical key.
    expect(chromeKeyAction(key('ü', 'BracketLeft', { ctrlKey: true }), idle)).toBe('back')
    expect(chromeKeyAction(key('[', 'BracketLeft', { ctrlKey: true }), { ...idle, typing: true })).toBeNull()
  })

  it('opens the parent board with Mod+U, except on Home and while typing', () => {
    expect(chromeKeyAction(key('u', 'KeyU', { ctrlKey: true }), idle)).toBe('parent')
    expect(chromeKeyAction(key('u', 'KeyU', { ctrlKey: true }), { ...idle, isHome: true })).toBeNull()
    expect(chromeKeyAction(key('u', 'KeyU', { ctrlKey: true }), { ...idle, typing: true })).toBeNull()
  })

  it('opens the card menu with Shift+F10 or the menu key when cards are selected', () => {
    const sel = { ...idle, hasSelection: true }
    expect(chromeKeyAction(key('F10', 'F10', { shiftKey: true }), sel)).toBe('card-menu')
    expect(chromeKeyAction(key('ContextMenu', 'ContextMenu'), sel)).toBe('card-menu')
    // Without a selection the canvas menu (the browser's own event) is right.
    expect(chromeKeyAction(key('F10', 'F10', { shiftKey: true }), idle)).toBeNull()
    expect(chromeKeyAction(key('ContextMenu', 'ContextMenu'), idle)).toBeNull()
    // Text fields and card editors keep their own context menu; presenting hides the menu.
    expect(chromeKeyAction(key('F10', 'F10', { shiftKey: true }), { ...sel, typing: true })).toBeNull()
    expect(chromeKeyAction(key('ContextMenu', 'ContextMenu'), { ...sel, presenting: true })).toBeNull()
    expect(chromeKeyAction(key('F10', 'F10'), sel)).toBeNull()
    expect(chromeKeyAction(key('F10', 'F10', { shiftKey: true, ctrlKey: true }), sel)).toBeNull()
  })

  it('focuses the selection toolbar with Alt+F10', () => {
    const sel = { ...idle, hasSelection: true }
    expect(chromeKeyAction(key('F10', 'F10', { altKey: true }), sel)).toBe('selection-toolbar')
    expect(chromeKeyAction(key('F10', 'F10', { altKey: true }), idle)).toBeNull()
    expect(chromeKeyAction(key('F10', 'F10', { altKey: true }), { ...sel, typing: true })).toBeNull()
    expect(chromeKeyAction(key('F10', 'F10', { altKey: true, shiftKey: true }), sel)).toBeNull()
  })

  it('keeps print and the shortcut reference', () => {
    expect(chromeKeyAction(key('p', 'KeyP', { ctrlKey: true }), idle)).toBe('print')
    expect(chromeKeyAction(key('?', 'Slash', { shiftKey: true }), idle)).toBe('shortcuts')
    expect(chromeKeyAction(key('?', 'Slash', { shiftKey: true }), { ...idle, typing: true })).toBeNull()
    expect(chromeKeyAction(key('a', 'KeyA'), idle)).toBeNull()
  })
})

describe('navigation helpers', () => {
  it('finds the parent in the breadcrumb chain', () => {
    const chain = [{ id: 'home' }, { id: 'a' }, { id: 'b' }]
    expect(parentInChain(chain, 'b')).toBe('a')
    expect(parentInChain(chain, 'a')).toBe('home')
    expect(parentInChain(chain, 'home')).toBeNull()
    expect(parentInChain(chain, 'zz')).toBeNull()
  })

  it('maps the side mouse buttons', () => {
    expect(mouseNavAction(3)).toBe('back')
    expect(mouseNavAction(4)).toBe('forward')
    expect(mouseNavAction(0)).toBeNull()
    expect(mouseNavAction(1)).toBeNull()
  })
})
