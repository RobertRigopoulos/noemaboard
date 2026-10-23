import { describe, expect, it } from 'vitest'
import { create } from 'zustand'
import { SYNC_PROBLEMS, createStoreSink, type SyncStatusState } from './status'

describe('status sink', () => {
  it('shows the most important active problem', () => {
    const store = create<SyncStatusState>(() => ({ online: true, boards: {}, problem: null }))
    const sink = createStoreSink(store)
    sink.setProblem('turn', true)
    expect(store.getState().problem).toBe(SYNC_PROBLEMS.turn)
    sink.setProblem('version', true)
    expect(store.getState().problem).toBe(SYNC_PROBLEMS.version)
    sink.setProblem('version', false)
    expect(store.getState().problem).toBe(SYNC_PROBLEMS.turn)
    sink.setProblem('turn', false)
    expect(store.getState().problem).toBeNull()
  })

  it('does not notify subscribers when nothing changed', () => {
    const store = create<SyncStatusState>(() => ({ online: true, boards: {}, problem: null }))
    const sink = createStoreSink(store)
    let calls = 0
    store.subscribe(() => calls++)
    sink.setBoards({ a: { peers: 1, active: true, lastSyncAt: 5 } })
    sink.setBoards({ a: { peers: 1, active: true, lastSyncAt: 5 } })
    sink.setProblem('full', false)
    expect(calls).toBe(1)
    sink.setBoards({ a: { peers: 2, active: true, lastSyncAt: 5 } })
    expect(calls).toBe(2)
  })
})
