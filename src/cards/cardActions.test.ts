import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LucideIcon } from 'lucide-react'
import type { BoardContextValue } from '../board/BoardContext'
import type { IndexedCard } from '../board/cardIndex'
import type { CardAction } from './cardActions'

type Module = typeof import('./cardActions')

// The provider registry is module state: every test gets a fresh copy of the module.
let mod: Module
beforeEach(async () => {
  vi.resetModules()
  mod = await import('./cardActions')
})

const icon = (() => null) as unknown as LucideIcon
const ctx = (readOnly = false) => ({ readOnly }) as BoardContextValue
const cards = [{ id: 'a' }] as unknown as IndexedCard[]
const action = (id: string, extra: Partial<CardAction> = {}): CardAction => ({ id, label: id, icon, group: 'edit', ...extra })

type KeyInit = Partial<Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>>
const key = (init: KeyInit) =>
  ({ key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent

describe('card action providers', () => {
  it('collects in registration order and registers a provider only once', () => {
    const first = () => [action('first')]
    const second = () => [action('second.a'), action('second.b')]
    mod.registerCardActions(first)
    mod.registerCardActions(second)
    mod.registerCardActions(first)
    expect(mod.collectCardActions(ctx(), cards).map((a) => a.id)).toEqual(['first', 'second.a', 'second.b'])
  })

  it('offers nothing without a selection', () => {
    mod.registerCardActions(() => [action('x')])
    expect(mod.collectCardActions(ctx(), [])).toEqual([])
  })

  it('filters read-only boards, children included, and drops a parent left without children', () => {
    mod.registerCardActions(() => [
      action('edit'),
      action('view', { readOnlyOk: true }),
      action('menu', {
        readOnlyOk: true,
        children: [action('menu.copy', { readOnlyOk: true }), action('menu.crop')],
      }),
      action('empty', { readOnlyOk: true, children: [action('empty.crop')] }),
    ])
    const ro = mod.collectCardActions(ctx(true), cards)
    expect(ro.map((a) => a.id)).toEqual(['view', 'menu'])
    expect(ro[1].children?.map((a) => a.id)).toEqual(['menu.copy'])
    // Editable boards get everything untouched.
    const rw = mod.collectCardActions(ctx(false), cards)
    expect(rw.map((a) => a.id)).toEqual(['edit', 'view', 'menu', 'empty'])
    expect(rw[2].children).toHaveLength(2)
  })

  it('skips a provider that throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mod.registerCardActions(() => [action('before')])
    mod.registerCardActions(() => {
      throw new Error('boom')
    })
    mod.registerCardActions(() => [action('after')])
    expect(mod.collectCardActions(ctx(), cards).map((a) => a.id)).toEqual(['before', 'after'])
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('flattens sub-actions for shortcut dispatch', () => {
    const list = [
      action('a'),
      action('b', { children: [action('b.1'), action('b.2', { children: [action('b.2.x')] })] }),
      action('c'),
    ]
    expect(mod.flattenActions(list).map((a) => a.id)).toEqual(['a', 'b.1', 'b.2.x', 'c'])
  })

  it('registers each board overlay key once', () => {
    const A = () => null
    const B = () => null
    mod.registerBoardOverlay('a', A)
    mod.registerBoardOverlay('a', B)
    mod.registerBoardOverlay('b', B)
    expect(mod.boardOverlays().map((o) => o.key)).toEqual(['a', 'b'])
    expect(mod.boardOverlays()[0].overlay).toBe(A)
  })
})

describe('matchesKeys', () => {
  it('treats Ctrl and Cmd alike for Mod', () => {
    expect(mod.matchesKeys('Mod+Alt+M', key({ key: 'm', code: 'KeyM', ctrlKey: true, altKey: true }))).toBe(true)
    expect(mod.matchesKeys('Mod+Alt+M', key({ key: 'm', code: 'KeyM', metaKey: true, altKey: true }))).toBe(true)
  })

  it('requires unlisted modifiers to be up', () => {
    expect(mod.matchesKeys('Mod+Alt+M', key({ key: 'M', code: 'KeyM', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false)
    expect(mod.matchesKeys('Mod+Alt+M', key({ key: 'm', code: 'KeyM', altKey: true }))).toBe(false)
    expect(mod.matchesKeys('Alt+A', key({ key: 'a', code: 'KeyA', altKey: true, ctrlKey: true }))).toBe(false)
  })

  it('matches letters by the letter typed, so non-QWERTY layouts follow the key labels', () => {
    // AZERTY: the key labelled A sits where QWERTY has Q, and the one labelled Q where QWERTY has A.
    expect(mod.matchesKeys('Alt+A', key({ key: 'a', code: 'KeyQ', altKey: true }))).toBe(true)
    expect(mod.matchesKeys('Alt+A', key({ key: 'q', code: 'KeyA', altKey: true }))).toBe(false)
    expect(mod.matchesKeys('Alt+W', key({ key: 'z', code: 'KeyW', altKey: true }))).toBe(false)
    // Dvorak: the key labelled L is QWERTY's P; Shift makes the letter upper case.
    expect(mod.matchesKeys('Mod+Shift+L', key({ key: 'L', code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(mod.matchesKeys('Mod+Shift+L', key({ key: 'N', code: 'KeyL', ctrlKey: true, shiftKey: true }))).toBe(false)
  })

  it('falls back to the physical key when no ASCII letter is typed (macOS Option, other scripts)', () => {
    expect(mod.matchesKeys('Mod+Alt+M', key({ key: 'µ', code: 'KeyM', metaKey: true, altKey: true }))).toBe(true)
    expect(mod.matchesKeys('Alt+Shift+H', key({ key: 'Ó', code: 'KeyH', altKey: true, shiftKey: true }))).toBe(true)
    expect(mod.matchesKeys('Alt+A', key({ key: 'ф', code: 'KeyA', altKey: true }))).toBe(true)
    expect(mod.matchesKeys('Alt+A', key({ key: 'Dead', code: 'KeyA', altKey: true }))).toBe(true)
    expect(mod.matchesKeys('Alt+A', key({ key: 'ф', code: 'KeyQ', altKey: true }))).toBe(false)
  })

  it('matches digits by code and Space', () => {
    expect(mod.matchesKeys('Shift+2', key({ key: '@', code: 'Digit2', shiftKey: true }))).toBe(true)
    expect(mod.matchesKeys('Space', key({ key: ' ', code: 'Space' }))).toBe(true)
  })

  it('matches named keys and punctuation by key', () => {
    const up = key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true })
    expect(mod.matchesKeys('Mod+Shift+ArrowUp', up)).toBe(true)
    expect(mod.matchesKeys('Mod+Shift+ArrowDown', up)).toBe(false)
    expect(mod.matchesKeys('Mod+ArrowUp', up)).toBe(false)
    expect(mod.matchesKeys(']', key({ key: ']', code: 'BracketRight' }))).toBe(true)
    expect(mod.matchesKeys(']', key({ key: ']', code: 'BracketRight', ctrlKey: true }))).toBe(false)
    expect(mod.matchesKeys('Mod+]', key({ key: ']', code: 'BracketRight', metaKey: true }))).toBe(true)
  })

  it('rejects malformed key strings', () => {
    expect(mod.matchesKeys('Hyper+M', key({ key: 'm', code: 'KeyM' }))).toBe(false)
    expect(mod.matchesKeys('', key({ key: '', code: '' }))).toBe(false)
  })
})

describe('keysHint', () => {
  it('uses symbols without separators on macOS', () => {
    expect(mod.keysHint('Mod+Alt+M', true)).toBe('⌘⌥M')
    expect(mod.keysHint('Mod+Shift+ArrowUp', true)).toBe('⌘⇧↑')
    expect(mod.keysHint('Mod+[', true)).toBe('⌘[')
  })

  it('uses words joined by + elsewhere, modifiers in a fixed order', () => {
    expect(mod.keysHint('Mod+Alt+M', false)).toBe('Ctrl+Alt+M')
    expect(mod.keysHint('Shift+Alt+h', false)).toBe('Alt+Shift+H')
    expect(mod.keysHint('Mod+Shift+ArrowDown', false)).toBe('Ctrl+Shift+↓')
    expect(mod.keysHint('Space', false)).toBe('Space')
  })
})
