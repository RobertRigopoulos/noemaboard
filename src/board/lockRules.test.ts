import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, updateCard } from '../model/board'
import { splitLocked } from './lockRules'

function board() {
  const doc = new Y.Doc()
  const add = (type: Parameters<typeof createCard>[1], fields: Record<string, unknown> = {}) => {
    const id = createCard(doc, type, {}, 'u1')
    if (Object.keys(fields).length) updateCard(doc, id, fields, 'u1')
    return id
  }
  return { doc, add }
}

describe('splitLocked', () => {
  it('keeps top-level locked cards and deletes the rest', () => {
    const { doc, add } = board()
    const locked = add('note', { locked: true })
    const free = add('note')
    expect(splitLocked(doc, [locked, free])).toEqual({ deletable: [free], kept: [locked] })
  })

  it('deletes a locked child together with its deleted column', () => {
    const { doc, add } = board()
    const col = add('column')
    const child = add('note', { parent: col, order: 'a0', locked: true })
    expect(splitLocked(doc, [col, child])).toEqual({ deletable: [col, child], kept: [] })
    // Selected on its own, the locked child stays.
    expect(splitLocked(doc, [child])).toEqual({ deletable: [], kept: [child] })
  })

  it('keeps a locked column; its unlocked children may still go', () => {
    const { doc, add } = board()
    const col = add('column', { locked: true })
    const child = add('note', { parent: col, order: 'a0' })
    expect(splitLocked(doc, [col, child])).toEqual({ deletable: [child], kept: [col] })
  })

  it('applies to lines too', () => {
    const { doc, add } = board()
    const lockedLine = add('line', { locked: true })
    const line = add('line')
    expect(splitLocked(doc, [lockedLine, line])).toEqual({ deletable: [line], kept: [lockedLine] })
  })

  it('only counts locked === true, and skips unknown ids and duplicates', () => {
    const { doc, add } = board()
    const odd = add('note', { locked: 'yes' })
    expect(splitLocked(doc, [odd, odd, 'missing'])).toEqual({ deletable: [odd], kept: [] })
  })
})
