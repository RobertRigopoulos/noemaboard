import { beforeEach, describe, expect, it, vi } from 'vitest'
import { newBoardId, newSecret } from '../model/ids'
import { storageKey } from './profile'
import { dedupeSecrets, flushLibrary, mergeEntry, mergeLibraries, sanitizeEntries, secretOwner, useLibrary, type LibraryEntry } from './library'

const entry = (id: string, patch: Partial<LibraryEntry> = {}): LibraryEntry => ({
  id,
  secret: newSecret(),
  title: 'Board',
  icon: null,
  color: null,
  parentId: 'home',
  shared: false,
  relay: null,
  lastOpened: 0,
  ...patch,
})

beforeEach(() => {
  flushLibrary()
  useLibrary.setState({ entries: {} })
})

describe('library secrets', () => {
  it('never lets a board card replace a known secret, nor reuse another board\'s secret', () => {
    const lib = useLibrary.getState()
    const a = newBoardId()
    const b = newBoardId()
    const sa = newSecret()
    lib.upsert({ id: a, secret: sa, title: 'Mine' })
    expect(useLibrary.getState().entries[a].secretFrom).toBe('created')
    lib.upsert({ id: a, secret: newSecret(), secretFrom: 'card' })
    expect(useLibrary.getState().entries[a].secret).toBe(sa)
    lib.upsert({ id: b, secret: sa, secretFrom: 'card' })
    expect(useLibrary.getState().entries[b]?.secret ?? '').toBe('')
    expect(secretOwner(useLibrary.getState().entries, sa)).toBe(a)
  })

  it('lets an invite replace a secret only learned from a card, never a trusted one', () => {
    const lib = useLibrary.getState()
    const x = newBoardId()
    const fromCard = newSecret()
    const real = newSecret()
    lib.upsert({ id: x, secret: fromCard, secretFrom: 'card' })
    lib.upsert({ id: x, secret: real, secretFrom: 'invite' })
    expect(useLibrary.getState().entries[x]).toMatchObject({ secret: real, secretFrom: 'invite' })
    lib.upsert({ id: x, secret: newSecret(), secretFrom: 'invite' })
    expect(useLibrary.getState().entries[x].secret).toBe(real)
    // A card confirming the same secret does not lower its trust.
    lib.upsert({ id: x, secret: real, secretFrom: 'card' })
    expect(useLibrary.getState().entries[x].secretFrom).toBe('invite')
  })
})

describe('merging copies written by several tabs', () => {
  it('keeps the shared flag, the newest fields and the most trusted secret', () => {
    const id = newBoardId()
    const secret = newSecret()
    // Tab A joined the board; tab B learned it from a card a moment later (stale: not shared).
    const a = entry(id, { secret, secretFrom: 'invite', shared: true, title: 'Plan', updatedAt: 100, lastOpened: 100 })
    const b = entry(id, { secret, secretFrom: 'card', shared: false, title: 'Plan v2', updatedAt: 260 })
    const m = mergeEntry(a, b)
    expect(m).toMatchObject({ shared: true, secretFrom: 'invite', title: 'Plan v2', lastOpened: 100, updatedAt: 260 })
    const other = entry(id, { secretFrom: 'card', updatedAt: 999 })
    expect(mergeEntry(a, other).secret).toBe(secret)
  })

  it('does not bring back an entry removed after its last change, and keeps unrelated entries', () => {
    const left = newBoardId()
    const mine = newBoardId()
    const theirs = newBoardId()
    const now = 10_000
    const merged = mergeLibraries(
      { entries: { [mine]: entry(mine, { updatedAt: 50 }) }, removed: { [left]: 500 } },
      { entries: { [left]: entry(left, { updatedAt: 400 }), [theirs]: entry(theirs, { updatedAt: 60 }) }, removed: {} },
      now,
    )
    expect(Object.keys(merged.entries).sort()).toEqual([mine, theirs].sort())
    expect(merged.removed).toEqual({ [left]: 500 })
    // Joined again later: the newer entry wins over the tombstone, which is dropped.
    const again = mergeLibraries(merged, { entries: { [left]: entry(left, { updatedAt: 700 }) }, removed: {} }, now)
    expect(again.entries[left]).toBeDefined()
    expect(again.removed).toEqual({})
  })

  it('re-adding a removed board survives a merge with a stale copy', () => {
    const lib = useLibrary.getState()
    const id = newBoardId()
    lib.upsert({ id, secret: newSecret(), shared: true })
    lib.remove(id)
    expect(useLibrary.getState().entries[id]).toBeUndefined()
    lib.upsert({ id, secret: newSecret(), secretFrom: 'invite', shared: true })
    flushLibrary()
    expect(useLibrary.getState().entries[id]?.shared).toBe(true)
  })

  it('a pending save never overwrites what another tab stored meanwhile', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    try {
      const x = newBoardId()
      const y = newBoardId()
      const secret = newSecret()
      // This tab learned X from a card (not shared) and has a save pending...
      useLibrary.getState().upsert({ id: x, secret, secretFrom: 'card', title: 'X' })
      // ...while the other tab joined X by invite and stored it, plus another board.
      const other = {
        [x]: entry(x, { secret, secretFrom: 'invite', shared: true, title: 'X', updatedAt: Date.now() - 10 }),
        [y]: entry(y, { updatedAt: Date.now() - 10 }),
      }
      store.set(storageKey('library'), JSON.stringify(other))
      flushLibrary()
      const saved = JSON.parse(store.get(storageKey('library'))!) as Record<string, LibraryEntry>
      expect(saved[x]).toMatchObject({ shared: true, secretFrom: 'invite' })
      expect(saved[y]).toBeDefined()
      expect(useLibrary.getState().entries[x].shared).toBe(true)
      expect(useLibrary.getState().entries[y]).toBeDefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('takes the secret away from a board that reused its parent\'s secret (saved by older versions)', () => {
    const parent = newBoardId()
    const secret = newSecret()
    const fake = entry('000000', { secret, shared: true, parentId: parent })
    const real = entry(parent, { secret, shared: true, lastOpened: 5 })
    const out = dedupeSecrets({ [fake.id]: fake, [parent]: real })
    expect(out[parent]).toBe(real)
    expect(out[fake.id]).toMatchObject({ secret: '', shared: false })
    expect(secretOwner({ [fake.id]: fake, [parent]: real }, secret)).toBe(parent)
  })

  it('reads damaged storage safely', () => {
    expect(sanitizeEntries(null)).toEqual({})
    expect(sanitizeEntries({ a: 5, b: { secret: 7, title: 'T', shared: 'yes', secretFrom: 'hacker' } })).toEqual({
      b: { id: 'b', secret: '', title: 'T', icon: null, color: null, parentId: null, shared: false, relay: null, lastOpened: 0 },
    })
  })
})
