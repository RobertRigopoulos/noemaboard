import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { createCard, deleteCards, getCardMap } from '../../model/board'
import { getStaticSchema } from '../../editor/extensions'
import { dueReminders, MAX_SEEN, pickFresh, readSeen, reminderMessage } from './reminders'

const task = (text: string, attrs: Record<string, unknown>) => ({
  type: 'taskItem',
  attrs: { checked: false, ...attrs },
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

function board() {
  const doc = new Y.Doc()
  const todo = createCard(doc, 'todo', { title: 'Launch' }, 'me')
  const frag = getCardMap(doc, todo)!.get('content') as Y.XmlFragment
  prosemirrorJSONToYXmlFragment(
    getStaticSchema(),
    {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          content: [
            task('overdue for me', { due: '2026-10-20', assignee: 'me' }),
            task('today for me', { due: '2026-10-22T15:00', assignee: 'me' }),
            task('tomorrow for me', { due: '2026-10-23', assignee: 'me' }),
            task('done already', { due: '2026-10-01', assignee: 'me', checked: true }),
            task('someone else', { due: '2026-10-22', assignee: 'ada' }),
            task('unassigned', { due: '2026-10-22' }),
          ],
        },
      ],
    },
    frag,
  )
  return { doc, todo }
}

describe('dueReminders with a fixed day', () => {
  it('lists my unchecked tasks due today or overdue', () => {
    const { doc, todo } = board()
    const list = dueReminders(doc, 'me', '2026-10-22')
    expect(list.map((r) => [r.text, r.state, r.index])).toEqual([
      ['overdue for me', 'overdue', 0],
      ['today for me', 'today', 1],
    ])
    expect(list[0].key).toMatch(new RegExp(`^${todo}:[0-9a-z]+:2026-10-20$`))
  })

  it('ignores to-dos in the trash and other people', () => {
    const { doc, todo } = board()
    expect(dueReminders(doc, 'ada', '2026-10-22').map((r) => r.text)).toEqual(['someone else'])
    deleteCards(doc, [todo], 'me')
    expect(dueReminders(doc, 'me', '2026-10-22')).toEqual([])
  })

  it('keeps a task’s key when other tasks are deleted or added above it', () => {
    const { doc, todo } = board()
    const keys = dueReminders(doc, 'me', '2026-10-22').map((r) => r.key)
    const frag = getCardMap(doc, todo)!.get('content') as Y.XmlFragment
    const list = frag.get(0) as Y.XmlElement
    // The overdue task goes (deleted as completed, say), and a new one appears at the top.
    list.delete(0, 1)
    const fresh = new Y.XmlElement('taskItem')
    fresh.setAttribute('checked', false as unknown as string)
    fresh.insert(0, [new Y.XmlElement('paragraph')])
    list.insert(0, [fresh])
    const after = dueReminders(doc, 'me', '2026-10-22')
    expect(after.map((r) => r.text)).toEqual(['today for me'])
    expect(after[0].index).toBe(1)
    expect(after[0].key).toBe(keys[1])
  })

  it('tells identical tasks apart, and a rescheduled task is new', () => {
    const doc = new Y.Doc()
    const id = createCard(doc, 'todo', {}, 'me')
    const frag = getCardMap(doc, id)!.get('content') as Y.XmlFragment
    const same = () => task('Call the printer', { due: '2026-10-22', assignee: 'me' })
    prosemirrorJSONToYXmlFragment(getStaticSchema(), { type: 'doc', content: [{ type: 'taskList', content: [same(), same()] }] }, frag)
    const [first, second] = dueReminders(doc, 'me', '2026-10-22')
    expect(first.key).not.toBe(second.key)
    ;((frag.get(0) as Y.XmlElement).get(0) as Y.XmlElement).setAttribute('due', '2026-10-21')
    const [rescheduled] = dueReminders(doc, 'me', '2026-10-22')
    expect(rescheduled.key).not.toBe(first.key)
    expect(rescheduled.key).toMatch(/:2026-10-21$/)
  })

  it('looks at notes and documents too, but not other cards', () => {
    const doc = new Y.Doc()
    const content = { type: 'doc', content: [{ type: 'taskList', content: [task('in text', { due: '2026-10-21', assignee: 'me' })] }] }
    for (const type of ['note', 'document', 'todo'] as const) {
      const id = createCard(doc, type, {}, 'me')
      prosemirrorJSONToYXmlFragment(getStaticSchema(), content, getCardMap(doc, id)!.get('content') as Y.XmlFragment)
    }
    // A card type that does not hold tasks, even with a task-shaped fragment written by a peer.
    const image = createCard(doc, 'image', {}, 'me')
    const stray = new Y.XmlFragment()
    getCardMap(doc, image)!.set('content', stray)
    prosemirrorJSONToYXmlFragment(getStaticSchema(), content, stray)
    expect(dueReminders(doc, 'me', '2026-10-22')).toHaveLength(3)
  })
})

describe('pickFresh', () => {
  const reminders = [
    { cardId: 'c', index: 0, text: 'a', state: 'overdue' as const, key: 'c:0:h1' },
    { cardId: 'c', index: 1, text: 'b', state: 'today' as const, key: 'c:1:h2' },
  ]

  it('shows each task once per day', () => {
    const first = pickFresh(reminders, [], '2026-10-22')
    expect(first.fresh).toHaveLength(2)
    const again = pickFresh(reminders, first.seen, '2026-10-22')
    expect(again.fresh).toHaveLength(0)
    const nextDay = pickFresh(reminders, again.seen, '2026-10-23')
    expect(nextDay.fresh).toHaveLength(2)
    // Yesterday's entries are dropped.
    expect(nextDay.seen.every((e) => e.startsWith('2026-10-23|'))).toBe(true)
  })

  it('treats a rewritten task as new', () => {
    const { seen } = pickFresh(reminders, [], '2026-10-22')
    const rewritten = [{ ...reminders[0], key: 'c:0:other' }]
    expect(pickFresh(rewritten, seen, '2026-10-22').fresh).toHaveLength(1)
  })

  it('keeps at most the newest entries', () => {
    const many = Array.from({ length: MAX_SEEN + 20 }, (_, i) => ({ ...reminders[0], key: `c:${i}:h` }))
    const { seen } = pickFresh(many, [], '2026-10-22')
    expect(seen).toHaveLength(MAX_SEEN)
    expect(seen[seen.length - 1]).toBe(`2026-10-22|c:${MAX_SEEN + 19}:h`)
  })
})

describe('stored entries and messages', () => {
  it('validates what comes back from storage', () => {
    expect(readSeen(null)).toEqual([])
    expect(readSeen({ a: 1 })).toEqual([])
    expect(readSeen(['2026-10-22|c:0:h', 42, 'junk', '2026-10-22|' + 'x'.repeat(400)])).toEqual(['2026-10-22|c:0:h'])
  })

  it('words reminders and cuts long task text', () => {
    expect(reminderMessage({ state: 'today', text: 'Call the printer' })).toBe('Due today: Call the printer')
    expect(reminderMessage({ state: 'overdue', text: '' })).toBe('Overdue: Untitled task')
    const long = reminderMessage({ state: 'overdue', text: 'x'.repeat(100) })
    expect(long).toBe(`Overdue: ${'x'.repeat(59)}…`)
  })
})
