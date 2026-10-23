import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  createCard,
  createTextNote,
  deleteCards,
  getCards,
  insertIntoColumn,
  removeCards,
  restoreTrashEntry,
  setFragmentText,
} from '../../model/board'
import { affectsTrash, countTrashEntries, entryLabel, firstLine, relativeTime, summarizeTrash } from './trashSummary'

const U = 'me'
const doc = () => new Y.Doc({ guid: 't1' })

describe('summarizeTrash', () => {
  it('summarises a deleted note with its first line of text', () => {
    const d = doc()
    const n = createTextNote(d, '\n  Groceries  for   the week \nmilk', {}, U)
    const entry = deleteCards(d, [n], U)
    const list = summarizeTrash(d)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: entry, count: 1, total: 1, title: 'Groceries for the week', deletedBy: U })
    expect(list[0].types).toEqual([{ type: 'note', count: 1 }])
    expect(list[0].deletedAt).toBeGreaterThan(0)
  })

  it('counts a column as one card and uses its title', () => {
    const d = doc()
    const col = createCard(d, 'column', { title: 'Ideas' }, U)
    const a = createTextNote(d, 'first', {}, U)
    const b = createTextNote(d, 'second', {}, U)
    insertIntoColumn(d, [a, b], col, 0, U)
    deleteCards(d, [col], U)
    const [s] = summarizeTrash(d)
    expect(s).toMatchObject({ count: 1, total: 3, title: 'Ideas' })
    expect(s.types).toEqual([{ type: 'column', count: 1 }])
  })

  it('falls back to other cards for text and does not count attached lines', () => {
    const d = doc()
    const sketch = createCard(d, 'sketch', {}, U)
    const note = createTextNote(d, 'hello', {}, U)
    createCard(d, 'line', { from: { card: sketch, x: 0, y: 0 }, to: { card: note, x: 0, y: 0 } }, U)
    deleteCards(d, [sketch, note], U)
    const [s] = summarizeTrash(d)
    expect(s.count).toBe(2)
    expect(s.total).toBe(3)
    expect(s.types.map((t) => t.type).sort()).toEqual(['note', 'sketch'])
    expect(s.title).toBe('hello')
  })

  it('reads titles of to-dos, documents, links and comment threads', () => {
    const d = doc()
    const todo = createCard(d, 'todo', { title: 'Launch list' }, U)
    const docCard = createCard(d, 'document', {}, U)
    d.transact(() => setFragmentText(getCards(d).get(docCard)!.get('content') as Y.XmlFragment, 'Spec draft\nmore'))
    const link = createCard(d, 'link', { url: 'https://example.com/page' }, U)
    const comment = createCard(d, 'comment', {}, U)
    d.transact(() => {
      const msg = new Y.Map<unknown>()
      msg.set('text', 'Looks good')
      ;(getCards(d).get(comment)!.get('thread') as Y.Array<Y.Map<unknown>>).push([msg])
    })
    const entries = [todo, docCard, link, comment].map((id) => deleteCards(d, [id], U)!)
    const byId = new Map(summarizeTrash(d).map((s) => [s.id, s.title]))
    expect(entries.map((e) => byId.get(e))).toEqual(['Launch list', 'Spec draft', 'https://example.com/page', 'Looks good'])
  })

  it('sorts newest first, hides moved-away cards and tolerates malformed peer data', () => {
    const d = doc()
    const a = createTextNote(d, 'a', {}, U)
    const b = createTextNote(d, 'b', {}, U)
    const moved = createTextNote(d, 'moved', {}, U)
    const weird = createTextNote(d, 'weird', {}, U)
    const ea = deleteCards(d, [a], U)!
    const eb = deleteCards(d, [b], U)!
    removeCards(d, [moved], U, 'other-board')
    d.transact(() => {
      getCards(d).get(a)!.set('trashedAt', 1000)
      getCards(d).get(b)!.set('trashedAt', 2000)
      const w = getCards(d).get(weird)!
      w.set('trashedAt', 1500)
      w.set('trashGroup', 42)
      w.set('trashedBy', { evil: true })
    })
    const list = summarizeTrash(d)
    expect(list.map((s) => s.id)).toEqual([eb, weird, ea])
    expect(list[1]).toMatchObject({ deletedBy: '', title: 'weird', count: 1 })
    expect(countTrashEntries(d)).toBe(3)
  })

  it('restored entries disappear', () => {
    const d = doc()
    const entry = deleteCards(d, [createTextNote(d, 'x', {}, U)], U)!
    expect(countTrashEntries(d)).toBe(1)
    restoreTrashEntry(d, entry, U)
    expect(summarizeTrash(d)).toEqual([])
    expect(countTrashEntries(d)).toBe(0)
  })
})

describe('affectsTrash', () => {
  it('ignores edits to cards on the board but reacts to trash changes', () => {
    const d = doc()
    const cards = getCards(d)
    const calls: boolean[] = []
    cards.observeDeep((events) => calls.push(affectsTrash(events, cards)))
    const n = createTextNote(d, 'text', {}, U) // add -> relevant (cards map changed)
    d.transact(() => setFragmentText(cards.get(n)!.get('content') as Y.XmlFragment, 'typing'))
    d.transact(() => cards.get(n)!.set('x', 50))
    deleteCards(d, [n], U)
    d.transact(() => setFragmentText(cards.get(n)!.get('content') as Y.XmlFragment, 'edit in trash'))
    expect(calls).toEqual([true, false, false, true, true])
  })
})

describe('text helpers', () => {
  it('firstLine skips blanks, strips task markers and clips', () => {
    expect(firstLine('\n\n[x] done thing\nnext')).toBe('done thing')
    expect(firstLine('a'.repeat(200), 10)).toBe(`${'a'.repeat(9)}…`)
    expect(firstLine('   ')).toBe('')
  })

  it('relativeTime formats recent times', () => {
    const now = 10 * 24 * 3600_000
    expect(relativeTime(now - 5_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago')
    expect(relativeTime(now - 3600_000, now)).toBe('1 hour ago')
    expect(relativeTime(now - 5 * 3600_000, now)).toBe('5 hours ago')
    expect(relativeTime(now - 30 * 3600_000, now)).toBe('yesterday')
    expect(relativeTime(now - 3 * 24 * 3600_000, now)).toBe('3 days ago')
    expect(relativeTime(now + 60_000, now)).toBe('just now')
    expect(relativeTime(0, now)).toBe('some time ago')
  })

  it('entryLabel names single types and pluralises', () => {
    const labels = { note: 'Note', todo: 'To-do', sketch: 'Sketch' } as const
    expect(entryLabel([{ type: 'note', count: 1 }], 1, labels)).toBe('Note')
    expect(entryLabel([{ type: 'note', count: 3 }], 3, labels)).toBe('3 notes')
    expect(entryLabel([{ type: 'todo', count: 2 }], 2, labels)).toBe('2 to-dos')
    expect(entryLabel([{ type: 'sketch', count: 2 }], 2, labels)).toBe('2 sketches')
    expect(
      entryLabel(
        [
          { type: 'note', count: 1 },
          { type: 'sketch', count: 1 },
        ],
        2,
        labels,
      ),
    ).toBe('2 cards')
  })
})
