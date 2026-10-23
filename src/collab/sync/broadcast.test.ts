import { afterEach, describe, expect, it } from 'vitest'
import { BroadcastChannelTransport } from './broadcast'
import type { TransportHandlers } from './transport'
import { waitFor } from './testkit'

const open: BroadcastChannelTransport[] = []
afterEach(async () => {
  for (const t of open.splice(0)) await t.leave()
})

function tab(name: string, opts = {}) {
  const t = new BroadcastChannelTransport(name, opts)
  open.push(t)
  const peers = new Set<string>()
  const got: { from: string; data: number[] }[] = []
  const handlers: TransportHandlers = {
    onPeerJoin: (p) => peers.add(p),
    onPeerLeave: (p) => peers.delete(p),
    onMessage: (d, from) => got.push({ from, data: [...d] }),
    onBlobRequest: async () => null,
  }
  t.connect(handlers)
  return { t, peers, got }
}

describe('BroadcastChannelTransport', () => {
  it('discovers other tabs, delivers targeted data and notices tabs closing', async () => {
    const name = `noema:test:${Math.random()}`
    const a = tab(name)
    const b = tab(name)
    await waitFor(() => a.peers.has(b.t.selfId) && b.peers.has(a.t.selfId), 'tabs see each other')
    const c = tab(name)
    await waitFor(() => c.peers.size === 2 && a.peers.has(c.t.selfId), 'third tab joins')

    a.t.send(new Uint8Array([1, 2, 3]), [b.t.selfId])
    await waitFor(() => b.got.length === 1, 'delivery')
    expect(b.got[0]).toEqual({ from: a.t.selfId, data: [1, 2, 3] })
    expect(c.got).toHaveLength(0)

    await c.t.leave()
    await waitFor(() => !a.peers.has(c.t.selfId) && !b.peers.has(c.t.selfId), 'bye noticed')
  })

  it('drops tabs that stop sending heartbeats', async () => {
    const name = `noema:test:${Math.random()}`
    const a = tab(name, { pingMs: 10, timeoutMs: 40 })
    // A tab that vanished without saying goodbye: a raw channel that only says hello.
    const ghost = new BroadcastChannel(name)
    ghost.postMessage({ t: 'hello', from: 'tab:ghost' })
    await waitFor(() => a.peers.has('tab:ghost'), 'ghost seen')
    await waitFor(() => !a.peers.has('tab:ghost'), 'ghost timed out')
    // Malformed messages are ignored.
    ghost.postMessage({ t: 'data', from: 'not-a-tab', to: [a.t.selfId], data: new Uint8Array([1]) })
    ghost.postMessage('garbage')
    await new Promise((r) => setTimeout(r, 20))
    expect(a.got).toHaveLength(0)
    ghost.close()
  })
})
