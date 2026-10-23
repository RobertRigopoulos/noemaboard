import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { docs } from '../collab/docs'
import { useLibrary } from '../collab/library'
import { forEachActiveCard, getCards, initBoardDoc, LOCAL_ORIGIN, readCard, readMeta } from '../model/board'
import { newBoardId } from '../model/ids'
import type { BoardCard } from '../model/types'
import { createBoardFromTemplate } from './create'

beforeAll(() => {
  docs.memoryOnly = true
})

function parentBoard(): Y.Doc {
  const doc = new Y.Doc({ guid: newBoardId() })
  initBoardDoc(doc, { id: doc.guid, title: 'Parent' }, 'me')
  return doc
}

function boardCards(doc: Y.Doc): BoardCard[] {
  const out: BoardCard[] = []
  forEachActiveCard(doc, (m) => {
    const c = readCard(m)
    if (c.type === 'board') out.push(c)
  })
  return out
}

describe('createBoardFromTemplate', () => {
  it('adds a board card, a library entry and a child board filled from the template', async () => {
    const parent = parentBoard()
    const undo = new Y.UndoManager([getCards(parent)], { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const boardId = createBoardFromTemplate(parent, 'project-plan', { x: 400, y: 300 }, 'me')

    const [card] = boardCards(parent)
    expect(card.boardId).toBe(boardId)
    expect(card.title).toBe('Project plan')
    expect(card.icon).toBe('kanban')
    expect(card.color).toBe('blue')
    // Centred on the requested point, on the grid.
    expect(card.x).toBe(340)
    expect(card.y).toBe(260)
    expect(undo.undoStack.length).toBe(1)

    const entry = useLibrary.getState().entries[boardId]
    expect(entry.secret).toBe(card.secret)
    expect(entry.secretFrom).toBe('created')
    expect(entry.parentId).toBe(parent.guid)
    expect(entry.title).toBe('Project plan')

    await docs.withDoc(boardId, (child) => {
      const meta = readMeta(child)
      expect(meta.id).toBe(boardId)
      expect(meta.title).toBe('Project plan')
      expect(meta.icon).toBe('kanban')
      expect(meta.color).toBe('blue')
      expect(meta.parentId).toBe(parent.guid)
      expect(meta.shared).toBe(false)
      const types = new Set<string>()
      forEachActiveCard(child, (m) => types.add(String(m.get('type'))))
      expect(types).toEqual(new Set(['note', 'column', 'todo']))
    })
  })

  it('does not drop a second board on top of the first one', () => {
    const parent = parentBoard()
    createBoardFromTemplate(parent, 'brainstorm', { x: 0, y: 0 }, 'me')
    createBoardFromTemplate(parent, 'moodboard', { x: 0, y: 0 }, 'me')
    const [a, b] = boardCards(parent)
    expect(a.boardId).not.toBe(b.boardId)
    expect(a.secret).not.toBe(b.secret)
    expect(`${a.x},${a.y}`).not.toBe(`${b.x},${b.y}`)
  })

  it('creates an empty, untitled-style board for the blank choice', async () => {
    const parent = parentBoard()
    const boardId = createBoardFromTemplate(parent, 'blank', { x: 0, y: 0 }, 'me')
    const [card] = boardCards(parent)
    expect(card.title).toBe('New board')
    expect(card.icon).toBeNull()
    expect(card.color).toBeNull()
    await docs.withDoc(boardId, (child) => {
      expect(readMeta(child).title).toBe('New board')
      expect(getCards(child).size).toBe(0)
    })
  })
})
