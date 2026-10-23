// @ts-check
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { IpLimiter, forwardedClient, ipKey } from '../src/limits.js'

describe('client keys', () => {
  test('IPv4 addresses are used as they are', () => {
    assert.equal(ipKey('203.0.113.7'), '203.0.113.7')
    assert.equal(ipKey('203.0.113.7:5678'), '203.0.113.7')
    assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7')
    assert.equal(ipKey('::FFFF:203.0.113.7'), '203.0.113.7')
  })

  test('IPv6 addresses count per /64', () => {
    const key = ipKey('2001:db8:1:2:3:4:5:6')
    assert.equal(key, '2001:db8:1:2::/64')
    for (const a of ['2001:db8:1:2::9', '2001:DB8:1:2:ffff:ffff:ffff:ffff', '[2001:db8:1:2::1]:443', '2001:db8:1:2::1%eth0']) {
      assert.equal(ipKey(a), key, a)
    }
    assert.notEqual(ipKey('2001:db8:1:3::1'), key)
    assert.equal(ipKey('::1'), '0:0:0:0::/64')
    assert.equal(ipKey('64:ff9b::192.0.2.1'), '64:ff9b:0:0::/64')
  })

  test('missing or odd addresses still get a bounded key', () => {
    assert.equal(ipKey(undefined), 'unknown')
    assert.equal(ipKey(''), 'unknown')
    assert.equal(ipKey('x'.repeat(500)).length, 64)
  })
})

describe('X-Forwarded-For behind trusted proxies', () => {
  test('uses the entry written by the trusted proxy, not what the client sent', () => {
    // nginx/ALB/HAProxy append the peer address to whatever the client sent.
    assert.equal(forwardedClient('6.6.6.6, 198.51.100.4', 1), '198.51.100.4')
    assert.equal(forwardedClient(['6.6.6.6', '198.51.100.4'], 1), '198.51.100.4')
    assert.equal(forwardedClient('198.51.100.4', 1), '198.51.100.4')
    // Two proxies: the client is the second entry from the right.
    assert.equal(forwardedClient('6.6.6.6, 198.51.100.4, 10.0.0.2', 2), '198.51.100.4')
    assert.equal(forwardedClient('198.51.100.4', 3), '198.51.100.4')
  })

  test('no header means no forwarded address', () => {
    assert.equal(forwardedClient(undefined, 1), null)
    assert.equal(forwardedClient(' , ', 1), null)
    assert.equal(forwardedClient('1.2.3.4', 0), null)
  })
})

describe('IpLimiter', () => {
  test('counts connections per key and releases them', () => {
    const l = new IpLimiter({ maxConnections: 2, messagesPerSecond: 10, messageBurst: 10, bytesPerSecond: 100, byteBurst: 100, httpPerSecond: 1, httpBurst: 2 })
    assert.equal(l.connect('a'), true)
    assert.equal(l.connect('a'), true)
    assert.equal(l.connect('a'), false)
    assert.equal(l.connect('b'), true)
    l.disconnect('a')
    assert.equal(l.connect('a'), true)
    assert.equal(l.http('c'), true)
    assert.equal(l.http('c'), true)
    assert.equal(l.http('c'), false)
  })
})
