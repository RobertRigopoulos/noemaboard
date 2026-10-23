import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { LOCAL_ORIGIN, SYSTEM_ORIGIN } from './board'
import {
  DEFAULT_MEMBER_COLOR,
  getMembers,
  MAX_MEMBERS,
  MEMBER_REFRESH_MS,
  memberName,
  mentionCandidates,
  readMembers,
  upsertMember,
} from './members'

const board = (guid = 'board1') => new Y.Doc({ guid })
const T0 = 1_700_000_000_000
const me = { id: 'me', name: 'Robin', color: '#0090ff' }

describe('member roster', () => {
  it('skips or repairs hostile entries', () => {
    const doc = board()
    const members = getMembers(doc)
    members.set('ok', { name: '  Ana\u0007 ', color: '#ABCDEF', seenAt: T0 })
    members.set('bad id!', { name: 'Bad id', color: '#000000', seenAt: T0 })
    members.set('x'.repeat(65), { name: 'Too long id', color: '#000000', seenAt: T0 })
    members.set('long', { name: 'n'.repeat(500), color: '#000000', seenAt: T0 })
    members.set('blank', { name: ' \u0000 ', color: '#000000', seenAt: T0 })
    members.set('nested', { name: { first: 'Eve' }, color: '#000000', seenAt: T0 })
    members.set('array', ['Mallory'])
    members.set('string', 'Trent')
    members.set('ymap', new Y.Map())
    members.set('colour', { name: 'Bo', color: 'red; background: url(x)', seenAt: 'yesterday' })
    members.set('time', { name: 'Cy', color: '#123456', seenAt: Infinity })
    expect(readMembers(doc)).toEqual([
      { id: 'ok', name: 'Ana', color: '#ABCDEF', seenAt: T0 },
      { id: 'colour', name: 'Bo', color: DEFAULT_MEMBER_COLOR, seenAt: 0 },
      { id: 'time', name: 'Cy', color: '#123456', seenAt: 0 },
    ])
    expect(memberName(doc, 'ok')).toBe('Ana')
    expect(memberName(doc, 'long')).toBeNull()
    expect(memberName(doc, 'missing')).toBeNull()
    expect(memberName(doc, 'bad id!')).toBeNull()
  })

  it(`keeps the ${MAX_MEMBERS} most recently seen, sorted by name`, () => {
    const doc = board()
    doc.transact(() => {
      for (let i = 0; i < MAX_MEMBERS + 20; i++) {
        getMembers(doc).set(`u${i}`, { name: `Person ${String(i).padStart(3, '0')}`, color: '#000000', seenAt: T0 + i })
      }
    })
    const list = readMembers(doc)
    expect(list).toHaveLength(MAX_MEMBERS)
    // the 20 oldest are dropped
    expect(list.some((m) => m.id === 'u19')).toBe(false)
    expect(list[0].id).toBe('u20')
    expect(list[list.length - 1].id).toBe(`u${MAX_MEMBERS + 19}`)
  })

  it('writes only when needed, outside the undo history', () => {
    const doc = board()
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.size) origins.push(tr.origin)
    })
    expect(upsertMember(doc, me, T0)).toBe(true)
    expect(upsertMember(doc, me, T0 + 1000)).toBe(false)
    expect(upsertMember(doc, me, T0 + MEMBER_REFRESH_MS)).toBe(false)
    expect(upsertMember(doc, { ...me, name: 'Robin B' }, T0 + 2000)).toBe(true)
    expect(upsertMember(doc, { ...me, name: 'Robin B', color: '#e5484d' }, T0 + 3000)).toBe(true)
    expect(upsertMember(doc, { ...me, name: 'Robin B', color: '#e5484d' }, T0 + 3000 + MEMBER_REFRESH_MS + 1)).toBe(true)
    expect(origins).toEqual([SYSTEM_ORIGIN, SYSTEM_ORIGIN, SYSTEM_ORIGIN, SYSTEM_ORIGIN])
    expect(origins).not.toContain(LOCAL_ORIGIN)
    expect(readMembers(doc)).toEqual([{ id: 'me', name: 'Robin B', color: '#e5484d', seenAt: T0 + 3000 + MEMBER_REFRESH_MS + 1 }])
  })

  it('treats far-future seenAt as unknown, so it cannot push real members out', () => {
    const doc = board()
    doc.transact(() => {
      for (let i = 0; i < MAX_MEMBERS; i++) getMembers(doc).set('h' + i, { name: 'Hostile ' + i, color: '#000000', seenAt: 1e15 })
      getMembers(doc).set('real', { name: 'Real person', color: '#000000', seenAt: T0 })
      // a little ahead: clock skew, kept
      getMembers(doc).set('ahead', { name: 'Ahead', color: '#000000', seenAt: T0 + 3600_000 })
    })
    const list = readMembers(doc, T0)
    expect(list).toHaveLength(MAX_MEMBERS)
    expect(list.find((m) => m.id === 'real')?.seenAt).toBe(T0)
    expect(list.find((m) => m.id === 'ahead')?.seenAt).toBe(T0 + 3600_000)
    expect(list.filter((m) => m.id.startsWith('h')).every((m) => m.seenAt === 0)).toBe(true)
  })

  it('rewrites its own entry when it is dated in the future', () => {
    const doc = board()
    getMembers(doc).set('me', { name: me.name, color: me.color, seenAt: T0 + 10 * MEMBER_REFRESH_MS })
    expect(upsertMember(doc, me, T0)).toBe(true)
    expect(readMembers(doc, T0)[0].seenAt).toBe(T0)
    getMembers(doc).set('me', { name: me.name, color: me.color, seenAt: T0 + 3600_000 })
    expect(upsertMember(doc, me, T0)).toBe(true)
    expect(upsertMember(doc, me, T0 + 1000)).toBe(false)
  })

  it('never writes on Home, nor an unusable profile', () => {
    const home = board('home')
    expect(upsertMember(home, me, T0)).toBe(false)
    expect(getMembers(home).size).toBe(0)
    const doc = board()
    expect(upsertMember(doc, { ...me, name: '   ' }, T0)).toBe(false)
    expect(upsertMember(doc, { ...me, id: 'no spaces allowed' }, T0)).toBe(false)
    expect(upsertMember(doc, me, NaN)).toBe(false)
    expect(getMembers(doc).size).toBe(0)
    // a malformed colour is stored as the neutral default
    expect(upsertMember(doc, { ...me, color: 'blue' }, T0)).toBe(true)
    expect(readMembers(doc)[0].color).toBe(DEFAULT_MEMBER_COLOR)
  })

  it('merges extras into mention candidates: me first, then by name, deduplicated', () => {
    const doc = board()
    upsertMember(doc, { id: 'zed', name: 'Zed', color: '#111111' }, T0)
    upsertMember(doc, { id: 'me', name: 'Robin', color: '#222222' }, T0)
    upsertMember(doc, { id: 'amy', name: 'amy', color: '#333333' }, T0)
    const list = mentionCandidates(
      doc,
      [
        { id: 'zed', name: 'Zed (live)', color: '#444444' },
        { id: 'bob', name: 'Bob', color: '#555555' },
        { id: 'bob', name: 'Bob again', color: '#666666' },
        { id: 'bad id', name: 'Nope', color: '#777777' },
        { id: 'eve', name: '', color: '#888888' },
      ],
      'me',
    )
    expect(list.map((m) => [m.id, m.name])).toEqual([
      ['me', 'Robin'],
      ['amy', 'amy'],
      ['bob', 'Bob'],
      ['zed', 'Zed'],
    ])
    expect(list.find((m) => m.id === 'bob')!.seenAt).toBe(0)
  })
})
