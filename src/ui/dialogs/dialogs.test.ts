import { describe, expect, it } from 'vitest'
import { displayKeys, SHORTCUT_GROUPS } from './shortcutList'
import { parseTurnRows, parseWssList, toTurnRows } from './settings/networkValidation'

describe('shortcut list', () => {
  it('maps modifiers per platform and keeps "+"-like keys intact', () => {
    expect(displayKeys('Mod+Shift+Z', false)).toEqual(['Ctrl', 'Shift', 'Z'])
    expect(displayKeys('Mod+Shift+Z', true)).toEqual(['⌘', '⇧', 'Z'])
    expect(displayKeys('Mod+=', false)).toEqual(['Ctrl', '='])
    expect(displayKeys('Mod+Alt+1', true)).toEqual(['⌘', '⌥', '1'])
    expect(displayKeys('?', false)).toEqual(['?'])
  })
  it('has no duplicate labels inside a group', () => {
    for (const g of SHORTCUT_GROUPS) {
      const labels = g.items.map((i) => i.label)
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

describe('network settings validation', () => {
  it('accepts TURN servers, skipping empty rows', () => {
    const r = parseTurnRows([
      { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
      { urls: '', username: '', credential: '' },
      { urls: 'turns:a.example.com:443, turn:b.example.com', username: '', credential: '' },
    ])
    expect(r).toEqual({
      servers: [
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
        { urls: ['turns:a.example.com:443', 'turn:b.example.com'] },
      ],
    })
  })
  it('rejects bad TURN rows', () => {
    expect(parseTurnRows([{ urls: 'https://turn.example.com', username: '', credential: '' }])).toHaveProperty('error')
    expect(parseTurnRows([{ urls: '', username: 'only-user', credential: '' }])).toHaveProperty('error')
    expect(parseTurnRows([{ urls: 'turn:x', username: 'u'.repeat(400), credential: '' }])).toHaveProperty('error')
  })
  it('round-trips ICE servers into editable rows', () => {
    expect(toTurnRows([{ urls: ['turn:a', 'turn:b'], username: 'u' }])).toEqual([{ urls: 'turn:a, turn:b', username: 'u', credential: '' }])
  })
  it('accepts only wss:// discovery URLs, one per line', () => {
    expect(parseWssList('wss://a.example.com\n\n# comment\nwss://a.example.com\r\nwss://b.example.com/x', 'Relays')).toEqual({
      urls: ['wss://a.example.com', 'wss://b.example.com/x'],
    })
    expect(parseWssList('ws://insecure.example.com', 'Relays')).toHaveProperty('error')
    expect(parseWssList('https://a.example.com', 'Trackers')).toHaveProperty('error')
    expect(parseWssList(Array.from({ length: 21 }, (_, i) => `wss://r${i}.example.com`).join('\n'), 'Relays')).toHaveProperty('error')
  })
})
