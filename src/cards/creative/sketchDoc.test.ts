import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, getCards, LOCAL_ORIGIN } from '../../model/board'
import type { SketchStroke } from '../../model/types'
import { clearStrokes, getStrokesArray, pushStroke, removeStrokes } from './sketchDoc'
import { readStrokes } from './sketchMath'

const stroke = (id: string, x = 0): SketchStroke => ({ id, points: [x, 0, 0.5, x + 10, 10, 0.5], color: '#1f2328', size: 4 })

function setup() {
  const doc = new Y.Doc()
  const id = createCard(doc, 'sketch', { x: 0, y: 0 }, 'u1')
  const map = getCards(doc).get(id)!
  const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 })
  return { doc, id, map, undo }
}

const ids = (map: Y.Map<unknown>) => readStrokes(getStrokesArray(map)?.toArray() ?? []).map((s) => s.id)

describe('sketch stroke mutations', () => {
  it('creates sketch cards with a drawing space and an empty strokes array', () => {
    const { map } = setup()
    expect(map.get('vw')).toBe(400)
    expect(map.get('vh')).toBe(300)
    expect(getStrokesArray(map)?.length).toBe(0)
  })

  it('pushes finished strokes as plain objects', () => {
    const { doc, map } = setup()
    pushStroke(doc, map, stroke('a'))
    pushStroke(doc, map, stroke('b', 20))
    expect(ids(map)).toEqual(['a', 'b'])
    expect(getStrokesArray(map)!.get(0)).toEqual(stroke('a'))
  })

  it('creates the array for malformed cards that lack it', () => {
    const { doc, map } = setup()
    doc.transact(() => map.set('strokes', 'not an array'))
    expect(getStrokesArray(map)).toBeNull()
    pushStroke(doc, map, stroke('a'))
    expect(ids(map)).toEqual(['a'])
  })

  it('removes strokes by id and clears', () => {
    const { doc, map } = setup()
    for (const s of ['a', 'b', 'c', 'd']) pushStroke(doc, map, stroke(s))
    expect(removeStrokes(doc, map, ['b', 'd', 'zzz'])).toBe(2)
    expect(ids(map)).toEqual(['a', 'c'])
    expect(removeStrokes(doc, map, [])).toBe(0)
    clearStrokes(doc, map)
    expect(ids(map)).toEqual([])
    clearStrokes(doc, map) // no-op on empty
  })

  it('is undoable through the board UndoManager, one stroke per step', () => {
    const { doc, map, undo } = setup()
    undo.clear()
    pushStroke(doc, map, stroke('a'))
    undo.stopCapturing()
    pushStroke(doc, map, stroke('b'))
    undo.undo()
    expect(ids(map)).toEqual(['a'])
    undo.redo()
    expect(ids(map)).toEqual(['a', 'b'])
    undo.stopCapturing()
    clearStrokes(doc, map)
    undo.undo()
    expect(ids(map)).toEqual(['a', 'b'])
  })

  it('syncs strokes to peers, and remote strokes are not in the local undo stack', () => {
    const a = setup()
    const b = new Y.Doc()
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.doc))
    const bMap = getCards(b).get(a.id)!
    // Simulate the network: forward updates both ways with a remote origin.
    a.doc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'))
    b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a.doc, u, 'remote'))

    a.undo.clear()
    pushStroke(b, bMap, stroke('from-peer'))
    expect(ids(a.map)).toEqual(['from-peer'])
    expect(a.undo.undoStack.length).toBe(0)

    // Concurrent strokes from both sides are all kept.
    pushStroke(a.doc, a.map, stroke('mine'))
    pushStroke(b, bMap, stroke('theirs'))
    expect(new Set(ids(a.map))).toEqual(new Set(['from-peer', 'mine', 'theirs']))
    expect(ids(a.map)).toEqual(ids(bMap))

    // Erasing a peer's stroke propagates back.
    removeStrokes(a.doc, a.map, ['theirs'])
    expect(ids(bMap)).not.toContain('theirs')
  })

  it('ignores malformed peer items when reading', () => {
    const { doc, map } = setup()
    const arr = getStrokesArray(map)!
    doc.transact(() => arr.push([{ id: 'ok', points: [0, 0, 0.5, 1, 1, 0.5], color: '#e5484d', size: 3 }, { id: 5 }, 'junk', new Y.Map()]), 'remote')
    expect(ids(map)).toEqual(['ok'])
    // Even malformed items can still be cleared.
    clearStrokes(doc, map)
    expect(arr.length).toBe(0)
  })
})
