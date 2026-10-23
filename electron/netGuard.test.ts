import { describe, expect, it } from 'vitest'
import { isBlockedAddress, parseIPv4, parseIPv6, validateTargetUrl } from './netGuard'

describe('IP parsing', () => {
  it('parses IPv4 strictly', () => {
    expect(parseIPv4('1.2.3.4')).toBe(0x01020304)
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff)
    expect(parseIPv4('256.1.1.1')).toBeNull()
    expect(parseIPv4('1.2.3')).toBeNull()
    expect(parseIPv4('a.b.c.d')).toBeNull()
  })

  it('parses IPv6 with compression, zones and embedded IPv4', () => {
    expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('[2606:4700::1111]')).toEqual([0x2606, 0x4700, 0, 0, 0, 0, 0, 0x1111])
    expect(parseIPv6('fe80::1%eth0')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1])
    expect(parseIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(parseIPv6('1::2::3')).toBeNull()
    expect(parseIPv6('12345::')).toBeNull()
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull()
  })
})

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    'fec0::1',
    '64:ff9b::7f00:1', // NAT64 → 127.0.0.1
    '2002:7f00:1::', // 6to4 → 127.0.0.1
    '2001::1', // Teredo
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true)
  })

  it.each(['1.1.1.1', '8.8.8.8', '93.184.215.14', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '64:ff9b::808:808', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false)
    },
  )
})

describe('validateTargetUrl', () => {
  it('accepts public http(s) URLs', () => {
    expect(validateTargetUrl('https://example.com/a?b=c')?.hostname).toBe('example.com')
    expect(validateTargetUrl('http://1.1.1.1/')?.hostname).toBe('1.1.1.1')
  })

  it('rejects other schemes, credentials and local names', () => {
    for (const u of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/',
      'https://user:pw@example.com/',
      'http://localhost:3000/',
      'http://api.localhost/',
      'http://printer.local/',
      'http://metadata.google.internal/',
      'http://127.0.0.1/',
      'http://2130706433/', // decimal 127.0.0.1
      'http://0x7f.1/',
      'http://[::1]/',
      'http://[::ffff:169.254.169.254]/',
      'http://169.254.169.254/latest/meta-data/',
      '',
      'not a url',
      `https://example.com/${'a'.repeat(5000)}`,
    ]) {
      expect(validateTargetUrl(u), u).toBeNull()
    }
    expect(validateTargetUrl(42)).toBeNull()
  })

  it('resolves relative redirects against a base', () => {
    const base = new URL('https://example.com/a/b')
    expect(validateTargetUrl('/c', base)?.toString()).toBe('https://example.com/c')
    expect(validateTargetUrl('http://10.0.0.1/', base)).toBeNull()
  })
})
