import { describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../collab/library'
import { canOpenBoard } from './boardAccess'

function entry(id: string, secret: string): LibraryEntry {
  return { id, secret, title: id, icon: null, color: null, parentId: 'home', shared: false, relay: null, lastOpened: 0 }
}

describe('canOpenBoard', () => {
  const entries = {
    known: entry('known', 'a'.repeat(43)),
    // Left behind by older versions when an unknown board was renamed: no key, so not really ours.
    phantom: entry('phantom', ''),
  }

  it('always opens Home', () => {
    expect(canOpenBoard('home', {})).toBe(true)
  })
  it('opens boards whose key this device knows', () => {
    expect(canOpenBoard('known', entries)).toBe(true)
  })
  it('refuses boards this device was never given', () => {
    expect(canOpenBoard('someoneElsesBoard', entries)).toBe(false)
    expect(canOpenBoard('phantom', entries)).toBe(false)
  })
  it('is not fooled by ids that look like object properties', () => {
    expect(canOpenBoard('constructor', entries)).toBe(false)
    expect(canOpenBoard('__proto__', entries)).toBe(false)
    expect(canOpenBoard('toString', entries)).toBe(false)
  })
})
