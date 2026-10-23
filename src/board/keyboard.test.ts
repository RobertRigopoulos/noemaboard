import { describe, expect, it } from 'vitest'
import { isActivatableTarget, isTypingTarget } from './keyboard'

/** Minimal stand-in for an element: `closest` matches when the selector lists `tag`. */
const el = (tag: string) => ({ closest: (sel: string) => (sel.split(',').some((s) => s.trim() === tag) ? {} : null) })

describe('keyboard focus helpers', () => {
  it('treats focused buttons, links and menu items as controls that handle Enter/Space themselves', () => {
    expect(isActivatableTarget(el('button') as unknown as EventTarget)).toBe(true)
    expect(isActivatableTarget(el('[role="menuitem"]') as unknown as EventTarget)).toBe(true)
    expect(isActivatableTarget(el('div') as unknown as EventTarget)).toBe(false)
    expect(isActivatableTarget(null)).toBe(false)
    expect(isActivatableTarget({} as EventTarget)).toBe(false)
  })

  it('detects typing targets', () => {
    expect(isTypingTarget(el('textarea') as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget(el('button') as unknown as EventTarget)).toBe(false)
  })
})
