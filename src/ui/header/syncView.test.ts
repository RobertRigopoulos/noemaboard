import { describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../../collab/library'
import { describeSync, syncScope, timeAgo } from './syncView'

function entry(id: string, parentId: string | null, shared = false): LibraryEntry {
  return { id, secret: 's', title: id, icon: null, color: null, parentId, shared, relay: null, lastOpened: 0 }
}

describe('syncScope', () => {
  const entries = {
    root: entry('root', 'home', true),
    child: entry('child', 'root'),
    grandchild: entry('grandchild', 'child'),
    lonely: entry('lonely', 'home'),
    loopA: entry('loopA', 'loopB'),
    loopB: entry('loopB', 'loopA'),
  }
  it('finds the nearest shared board up the parent chain', () => {
    expect(syncScope('root', entries)).toBe('root')
    expect(syncScope('grandchild', entries)).toBe('root')
    expect(syncScope('lonely', entries)).toBeNull()
    expect(syncScope('unknown', entries)).toBeNull()
    expect(syncScope('home', entries)).toBeNull()
  })
  it('survives parent cycles', () => {
    expect(syncScope('loopA', entries)).toBeNull()
  })
})

describe('describeSync', () => {
  it('reports offline first', () => {
    expect(describeSync(false, 'x', 'b', { peers: 3, active: true, lastSyncAt: 0 }).kind).toBe('offline')
  })
  it('reports private boards', () => {
    expect(describeSync(true, null, null, undefined)).toMatchObject({ kind: 'private', label: 'Private' })
  })
  it('counts you plus connected devices', () => {
    expect(describeSync(true, null, 'b', { peers: 2, active: true, lastSyncAt: 0 })).toMatchObject({ kind: 'live', label: '3 online' })
  })
  it('shows problems only while nobody is connected, linking to network settings', () => {
    const v = describeSync(true, 'Add a TURN server', 'b', { peers: 0, active: true, lastSyncAt: 0 })
    expect(v).toMatchObject({ kind: 'problem', action: 'network' })
    expect(describeSync(true, 'Add a TURN server', 'b', { peers: 1, active: true, lastSyncAt: 0 }).kind).toBe('live')
  })
  it('uses the relay when no teammate is online', () => {
    const relay = { url: 'wss://relay.example.com', state: 'connected' as const, lastSyncAt: Date.now() }
    const v = describeSync(true, null, null, undefined, relay)
    expect(v.kind).toBe('relay')
    expect(v.detail).toContain('relay.example.com')
    expect(describeSync(true, null, 'b', undefined, { ...relay, state: 'error', message: 'Access key rejected' })).toMatchObject({
      kind: 'problem',
      action: 'share',
    })
  })
  it('says sync is off (and points to Network settings) when peer-to-peer is turned off and there is no relay', () => {
    const v = describeSync(true, null, 'b', { peers: 0, active: false, lastSyncAt: 0 }, undefined, false)
    expect(v).toMatchObject({ kind: 'off', label: 'Sync off', action: 'network' })
    expect(v.detail).not.toContain('when someone opens this board')
    // Private boards stay private whatever the setting.
    expect(describeSync(true, null, null, undefined, undefined, false).kind).toBe('private')
    // Offline still wins.
    expect(describeSync(false, null, 'b', undefined, undefined, false).kind).toBe('offline')
  })
  it('keeps syncing through a relay when peer-to-peer is off', () => {
    const relay = { url: 'wss://relay.example.com', state: 'connected' as const, lastSyncAt: 0 }
    expect(describeSync(true, null, 'b', { peers: 0, active: false, lastSyncAt: 0 }, relay, false).kind).toBe('relay')
    expect(describeSync(true, null, 'b', undefined, { ...relay, peers: 2 }, false)).toMatchObject({ kind: 'live', label: '3 online' })
    const down = describeSync(true, null, 'b', undefined, { ...relay, state: 'offline' }, false)
    expect(down).toMatchObject({ kind: 'problem', action: 'network' })
    expect(down.detail).not.toContain('when someone opens this board')
    expect(describeSync(true, null, 'b', undefined, { ...relay, state: 'connecting' }, false)).toMatchObject({ action: 'network' })
  })
  it('says "Only you" with the last sync time', () => {
    const v = describeSync(true, null, 'b', { peers: 0, active: true, lastSyncAt: Date.now() - 5 * 60_000 })
    expect(v).toMatchObject({ kind: 'alone', label: 'Only you' })
    expect(v.detail).toContain('5 min ago')
  })
})

describe('timeAgo', () => {
  it('formats relative times', () => {
    const now = 1_000_000_000_000
    expect(timeAgo(0, now)).toBe('')
    expect(timeAgo(now - 10_000, now)).toBe('just now')
    expect(timeAgo(now - 3 * 3600_000, now)).toBe('3 h ago')
  })
})
