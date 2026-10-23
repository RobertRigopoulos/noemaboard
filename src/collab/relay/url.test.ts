import { describe, expect, it } from 'vitest'
import { blobUrlFor, healthUrlFor, isBlockedMixedContent, normalizeRelayUrl, parseRelayUrl, wsUrlFor } from './url'

describe('relay URLs', () => {
  it('accepts ws, wss, http and https', () => {
    expect(parseRelayUrl('wss://relay.example.com')).toMatchObject({
      secure: true,
      wsBase: 'wss://relay.example.com',
      httpBase: 'https://relay.example.com',
      accessKey: '',
      canonical: 'wss://relay.example.com',
    })
    expect(parseRelayUrl('https://relay.example.com/')).toMatchObject({ wsBase: 'wss://relay.example.com' })
    expect(parseRelayUrl('http://192.168.1.20:8787')).toMatchObject({ secure: false, wsBase: 'ws://192.168.1.20:8787', httpBase: 'http://192.168.1.20:8787' })
    expect(parseRelayUrl('ws://localhost:8787')).toMatchObject({ host: 'localhost:8787' })
  })

  it('assumes secure for bare hosts except this computer', () => {
    expect(parseRelayUrl('relay.example.com')?.wsBase).toBe('wss://relay.example.com')
    expect(parseRelayUrl('localhost:8787')?.wsBase).toBe('ws://localhost:8787')
    expect(parseRelayUrl('127.0.0.1:8787')?.wsBase).toBe('ws://127.0.0.1:8787')
  })

  it('keeps path prefixes and strips pasted endpoints', () => {
    expect(parseRelayUrl('https://example.com/relay/')?.wsBase).toBe('wss://example.com/relay')
    expect(parseRelayUrl('wss://example.com/relay/ws')?.wsBase).toBe('wss://example.com/relay')
    expect(parseRelayUrl('https://example.com/healthz')?.httpBase).toBe('https://example.com')
  })

  it('extracts the access key and keeps it out of the display form', () => {
    const ep = parseRelayUrl('https://relay.example.com/?key=s3cr%20t')!
    expect(ep.accessKey).toBe('s3cr t')
    expect(ep.display).toBe('wss://relay.example.com')
    expect(ep.canonical).toBe('wss://relay.example.com?key=s3cr%20t')
    expect(parseRelayUrl(ep.canonical)?.accessKey).toBe('s3cr t')
    expect(normalizeRelayUrl('  wss://relay.example.com/?key=abc  ')).toBe('wss://relay.example.com?key=abc')
  })

  it('rejects junk', () => {
    for (const bad of ['', '   ', 'ftp://x.com', 'javascript:alert(1)', 'wss://user:pass@x.com', 'wss://', 'not a url', 42, null, 'mailto:a@b.c']) {
      expect(parseRelayUrl(bad)).toBeNull()
    }
    expect(normalizeRelayUrl('ftp://x.com')).toBeNull()
  })

  it('builds endpoint URLs', () => {
    const ep = parseRelayUrl('https://example.com/relay')!
    expect(wsUrlFor(ep, 'ROOM')).toBe('wss://example.com/relay/ws/ROOM')
    expect(blobUrlFor(ep, 'ROOM', 'abc')).toBe('https://example.com/relay/blob/ROOM/abc')
    expect(healthUrlFor(ep)).toBe('https://example.com/relay/healthz')
  })

  it('detects mixed content that browsers block', () => {
    expect(isBlockedMixedContent(parseRelayUrl('ws://10.0.0.5:8787')!, 'https:')).toBe(true)
    expect(isBlockedMixedContent(parseRelayUrl('ws://localhost:8787')!, 'https:')).toBe(false)
    expect(isBlockedMixedContent(parseRelayUrl('wss://relay.example.com')!, 'https:')).toBe(false)
    expect(isBlockedMixedContent(parseRelayUrl('ws://10.0.0.5:8787')!, 'app:')).toBe(false)
  })
})
