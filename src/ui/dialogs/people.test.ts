import { describe, expect, it } from 'vitest'
import { invitationText, mergePeople } from './people'

const me = { id: 'me', name: 'Robin', color: '#111111' }

describe('mergePeople', () => {
  it('puts you first, then people online by name, then the roster by last visit', () => {
    const rows = mergePeople(
      [
        { id: 'zoe', name: 'Zoe', color: '#222222', seenAt: 100 },
        { id: 'ann', name: 'Ann', color: '#333333', seenAt: 300 },
        { id: 'bob', name: 'Bob', color: '#444444', seenAt: 200 },
        { id: 'me', name: 'Robin (old)', color: '#555555', seenAt: 50 },
        { id: 'cy', name: 'Cy', color: '#666666', seenAt: 0 },
      ],
      [
        { id: 'zoe', name: 'Zoe K', color: '#999999', editing: true },
        { id: 'eve', name: 'Eve', color: '#777777', editing: false },
      ],
      me,
    )
    expect(rows.map((r) => r.id)).toEqual(['me', 'eve', 'zoe', 'ann', 'bob', 'cy'])
    expect(rows[0]).toMatchObject({ isMe: true, online: true, name: 'Robin', seenAt: 50 })
    // Live presence wins for the name and colour, and keeps the roster's last visit.
    expect(rows.find((r) => r.id === 'zoe')).toMatchObject({ online: true, editing: true, name: 'Zoe K', color: '#999999', seenAt: 100 })
    expect(rows.find((r) => r.id === 'ann')).toMatchObject({ online: false, editing: false })
  })

  it('lists you even when the roster is empty, and deduplicates', () => {
    const rows = mergePeople([], [{ id: 'me', name: 'Other tab', color: '', editing: true }, { id: 'a', name: 'A', color: '', editing: false }, { id: 'a', name: 'A2', color: '', editing: true }], me)
    expect(rows.map((r) => r.id)).toEqual(['me', 'a'])
    expect(rows[0].name).toBe('Robin')
    expect(rows[1]).toMatchObject({ name: 'A2', editing: true })
  })

  it('sorts offline people with the same visit time by name', () => {
    const rows = mergePeople(
      [
        { id: 'b', name: 'beth', color: '', seenAt: 5 },
        { id: 'a', name: 'Adam', color: '', seenAt: 5 },
      ],
      [],
      me,
    )
    expect(rows.map((r) => r.id)).toEqual(['me', 'a', 'b'])
  })
})

describe('invitationText', () => {
  it('names the board and the app', () => {
    expect(invitationText('App', '  Q3\n plan ', 'https://x/#/join/abc')).toBe('Join “Q3 plan” in App: https://x/#/join/abc')
    expect(invitationText('App', '', 'l')).toBe('Join “Untitled board” in App: l')
  })
})
