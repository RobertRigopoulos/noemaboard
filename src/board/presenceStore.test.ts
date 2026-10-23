import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness'
import { CardPresenceStore, computeCardPresence, NO_PRESENCE } from './presenceStore'

const user = (name: string, color: string) => ({ id: name, name, color })

describe('computeCardPresence', () => {
  it('derives outlines and drag previews per card, excluding ourselves', () => {
    const states = new Map<number, unknown>([
      [1, { user: user('me', '#000000'), selection: ['a'], editing: null }],
      [2, { user: user('Ann', '#ff0000'), selection: ['a', 'b'], editing: 'b', drag: { ids: ['a'], dx: 5, dy: 6 } }],
      [3, { user: user('Bob', '#00ff00'), selection: ['a', 'c'], editing: null }],
      [4, { garbage: true }],
    ])
    const out = computeCardPresence(states, 1)
    expect(out.get('a')).toEqual({ outline: { name: 'Ann', color: '#ff0000', editing: false }, drag: { dx: 5, dy: 6 } })
    expect(out.get('b')).toEqual({ outline: { name: 'Ann', color: '#ff0000', editing: true }, drag: null })
    expect(out.get('c')?.outline?.name).toBe('Bob')
    expect(out.has('x')).toBe(false)
  })
})

describe('CardPresenceStore', () => {
  function setup() {
    const local = new Awareness(new Y.Doc())
    const remote = new Awareness(new Y.Doc())
    const push = () => applyAwarenessUpdate(local, encodeAwarenessUpdate(remote, [remote.clientID]), 'peer')
    return { local, remote, push }
  }

  it('notifies only the cards whose presence changed, never for pointer moves or our own state', () => {
    const { local, remote, push } = setup()
    const store = new CardPresenceStore(local)
    const calls: string[] = []
    const unsubs = ['a', 'b'].map((id) => store.subscribe(id, () => calls.push(id)))

    remote.setLocalState({ user: user('Ann', '#ff0000'), pointer: { x: 1, y: 1 }, selection: ['a'], editing: null })
    push()
    expect(calls).toEqual(['a'])
    expect(store.get('a').outline?.name).toBe('Ann')
    const snapshot = store.get('a')

    // teammate's pointer moves: nothing to re-render
    remote.setLocalState({ ...remote.getLocalState(), pointer: { x: 50, y: 60 } })
    push()
    expect(calls).toEqual(['a'])
    expect(store.get('a')).toBe(snapshot) // stable identity

    // our own presence changes: ignored
    local.setLocalState({ user: user('me', '#000000'), pointer: { x: 9, y: 9 }, selection: ['b'], editing: null })
    expect(calls).toEqual(['a'])

    // drag preview of b
    remote.setLocalState({ ...remote.getLocalState(), drag: { ids: ['b'], dx: 10, dy: 0 } })
    push()
    expect(calls).toEqual(['a', 'b'])
    expect(store.get('b').drag).toEqual({ dx: 10, dy: 0 })

    unsubs.forEach((u) => u())
    expect(store.get('zzz')).toBe(NO_PRESENCE)
  })
})
