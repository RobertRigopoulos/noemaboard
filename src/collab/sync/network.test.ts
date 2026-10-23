import { describe, expect, it } from 'vitest'
import { DEFAULT_STUN } from '../../config'
import {
  DEFAULT_NOSTR_RELAYS,
  DEFAULT_TRACKERS,
  buildNetConfig,
  checkIceServer,
  checkRelayUrl,
  hasTurn,
  netConfigKey,
  sanitizeIceServers,
  sanitizeRelayUrls,
} from './network'
import { MAX_BLOB_REPLY_BYTES } from './protocol'

describe('network settings', () => {
  it('keeps only secure, distinct relay URLs', () => {
    expect(
      sanitizeRelayUrls([
        'wss://relay.example.com/',
        'wss://relay.example.com',
        'ws://evil.example.com',
        'ws://localhost:7777',
        'https://x.example.com',
        'wss://user:pw@host.example.com',
        42,
        '  wss://other.example.org  ',
      ]),
    ).toEqual(['wss://relay.example.com', 'ws://localhost:7777', 'wss://other.example.org'])
    expect(sanitizeRelayUrls('wss://a.example.com')).toEqual([])
  })

  it('validates ICE servers', () => {
    expect(
      sanitizeIceServers([
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
        { urls: ['stun:stun.example.com', 'http://nope'] },
        { urls: 'javascript:alert(1)' },
        null,
      ]),
    ).toEqual([{ urls: ['turn:turn.example.com:3478'], username: 'u', credential: 'p' }, { urls: ['stun:stun.example.com'] }])
  })

  it('builds one fixed configuration: defaults plus user extras', () => {
    const c = buildNetConfig({
      nostrRelays: ['wss://mine.example.com', DEFAULT_NOSTR_RELAYS[0]],
      trackers: [],
      iceServers: [{ urls: 'turns:t.example.com', username: 'a', credential: 'b' }],
    })
    expect(c.nostrRelays).toEqual([...DEFAULT_NOSTR_RELAYS, 'wss://mine.example.com'])
    expect(c.trackers).toEqual(DEFAULT_TRACKERS)
    expect(c.rtcConfig.iceServers).toEqual([...DEFAULT_STUN, { urls: ['turns:t.example.com'], username: 'a', credential: 'b' }])
    expect(c.maxReceiveBytes).toBe(MAX_BLOB_REPLY_BYTES)
    expect(netConfigKey({ nostrRelays: [], trackers: [], iceServers: [] })).toBe(netConfigKey({ nostrRelays: ['ftp://x'], trackers: [], iceServers: [] }))
    expect(hasTurn({ iceServers: [{ urls: 'turn:x.example.com' }] })).toBe(true)
    expect(hasTurn({ iceServers: [{ urls: 'stun:x.example.com' }] })).toBe(false)
  })

  it('explains invalid input in settings', () => {
    expect(checkRelayUrl('wss://relay.example.com')).toBeNull()
    expect(checkRelayUrl('relay.example.com')).toMatch(/wss:\/\//)
    expect(checkRelayUrl('')).toMatch(/Enter/)
    expect(checkIceServer({ urls: 'turn:t.example.com:3478', username: 'u', credential: 'p' })).toBeNull()
    expect(checkIceServer({ urls: 'turn:t.example.com:3478' })).toMatch(/username/)
    expect(checkIceServer({ urls: 'example.com' })).toMatch(/turn:/)
  })
})
