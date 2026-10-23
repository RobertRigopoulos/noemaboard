import { describe, expect, it } from 'vitest'
import { parseNetworkSettings } from './settings'

describe('network settings from storage', () => {
  it('keeps valid values and drops anything else', () => {
    expect(parseNetworkSettings(null)).toEqual({ iceServers: [], nostrRelays: [], trackers: [], p2pEnabled: true })
    expect(
      parseNetworkSettings({
        p2pEnabled: false,
        nostrRelays: ['wss://relay.example', 'http://nope', 5],
        trackers: 'wss://x',
        iceServers: [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'p' }, { urls: 'javascript:alert(1)' }],
      }),
    ).toEqual({
      p2pEnabled: false,
      nostrRelays: ['wss://relay.example'],
      trackers: [],
      iceServers: [{ urls: ['turn:turn.example:3478'], username: 'u', credential: 'p' }],
    })
  })
})
