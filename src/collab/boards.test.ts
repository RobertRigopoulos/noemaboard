import { beforeAll, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCards, initBoardDoc, isTrashed, SYSTEM_ORIGIN } from '../model/board'
import { unsortedIds } from '../model/unsorted'
import { newBoardId, newSecret } from '../model/ids'
import { BoardKeyMismatchError, ensureHome, isReachableFromHome, joinBoard, leaveBoard } from './boards'
import { docs } from './docs'
import { useLibrary } from './library'

beforeAll(async () => {
  docs.memoryOnly = true
  await ensureHome()
})

const lib = () => useLibrary.getState()

async function homeCardsFor(boardId: string): Promise<{ active: number; trashed: number }> {
  return docs.withDoc('home', (home) => {
    let active = 0
    let trashed = 0
    getCards(home).forEach((m) => {
      if (!(m instanceof Y.Map) || m.get('boardId') !== boardId) return
      if (isTrashed(m)) trashed++
      else active++
    })
    return { active, trashed }
  })
}

async function makeBoard(id: string, cards: { boardId: string; secret: string }[] = []) {
  await docs.withDoc(id, (doc) => {
    initBoardDoc(doc, { id, title: id }, 'me')
    for (const c of cards) createCard(doc, 'board', { ...c, title: 'Child' }, 'me')
  })
}

/** Home board cards for a board id that sit in Home's Unsorted drawer. */
async function homeDrawerCardsFor(boardId: string): Promise<string[]> {
  return docs.withDoc('home', (home) => unsortedIds(home).filter((id) => getCards(home).get(id)!.get('boardId') === boardId))
}

describe('joinBoard', () => {
  it("puts a joined board into Home's Unsorted drawer, automatically (not undoable)", async () => {
    const before = await docs.withDoc('home', (home) => unsortedIds(home))
    const origins: unknown[] = []
    const stop = await docs.withDoc('home', (home) => {
      const listen = (tr: Y.Transaction) => {
        if (tr.changed.size) origins.push(tr.origin)
      }
      home.on('afterTransaction', listen)
      return () => home.off('afterTransaction', listen)
    })
    const x = newBoardId()
    const y = newBoardId()
    await joinBoard({ b: x, k: newSecret(), t: 'First' })
    await joinBoard({ b: y, k: newSecret(), t: 'Second' })
    stop()
    expect(origins.length).toBeGreaterThan(0)
    expect(origins.every((o) => o === SYSTEM_ORIGIN)).toBe(true)
    const drawer = await docs.withDoc('home', (home) => unsortedIds(home))
    expect(drawer.slice(0, before.length)).toEqual(before)
    const added = drawer.slice(before.length)
    expect(added).toHaveLength(2)
    const boards = await docs.withDoc('home', (home) => added.map((id) => getCards(home).get(id)!.get('boardId')))
    expect(boards).toEqual([x, y])
    // still at a free spot on the canvas for versions without the drawer
    const xs = await docs.withDoc('home', (home) => added.map((id) => getCards(home).get(id)!.get('x') as number))
    expect(xs[1]).toBeGreaterThan(xs[0])
  })

  it('never re-keys a board this device already has', async () => {
    const x = newBoardId()
    const real = newSecret()
    await makeBoard(x)
    lib().upsert({ id: x, secret: real, title: 'Private', parentId: 'home', relay: null })
    const evil = { b: x, k: newSecret(), t: 'Team plan', r: 'wss://attacker.example' }
    expect(await joinBoard(evil)).toBe(x)
    expect(lib().entries[x]).toMatchObject({ secret: real, shared: false, relay: null })
    await expect(joinBoard(evil, { onMismatch: 'throw' })).rejects.toBeInstanceOf(BoardKeyMismatchError)

    // Nor may an invite reuse the key of another board under a new id.
    const fresh = newBoardId()
    expect(await joinBoard({ b: fresh, k: real, t: 'Copy' })).toBe('home')
    expect(lib().entries[fresh]).toBeUndefined()
  })

  it('replaces a key only learned from a card when the user confirms, for a board without content', async () => {
    const x = newBoardId()
    lib().upsert({ id: x, secret: newSecret(), secretFrom: 'card', title: 'Child' })
    const invite = { b: x, k: newSecret(), t: 'Real board' }
    await expect(joinBoard(invite, { onMismatch: 'throw' })).rejects.toMatchObject({ replaceable: true })
    expect(await joinBoard(invite, { replaceUnverifiedKey: true })).toBe(x)
    expect(lib().entries[x]).toMatchObject({ secret: invite.k, secretFrom: 'invite', shared: true, parentId: 'home' })
    expect((await homeCardsFor(x)).active).toBe(1)
  })

  it('puts a board on Home when its remembered parent no longer leads to it', async () => {
    const parent = newBoardId()
    const x = newBoardId()
    const k = newSecret()
    // The parent was left / its card is gone, but the library still remembers the link.
    await makeBoard(parent)
    lib().upsert({ id: parent, secret: newSecret(), title: 'Old parent', parentId: 'home' })
    lib().upsert({ id: x, secret: k, secretFrom: 'card', parentId: parent })
    await joinBoard({ b: x, k, t: 'X' })
    expect(lib().entries[x].parentId).toBe('home')
    expect((await homeCardsFor(x)).active).toBe(1)
  })

  it('keeps a board off Home when it is really nested in a board on Home', async () => {
    const parent = newBoardId()
    const x = newBoardId()
    const kp = newSecret()
    const kx = newSecret()
    await makeBoard(parent, [{ boardId: x, secret: kx }])
    await docs.withDoc('home', (home) => createCard(home, 'board', { boardId: parent, secret: kp }, 'me'))
    lib().upsert({ id: parent, secret: kp, parentId: 'home' })
    lib().upsert({ id: x, secret: kx, secretFrom: 'card', parentId: parent })
    expect(await isReachableFromHome(x)).toBe(true)
    await joinBoard({ b: x, k: kx, t: 'X' })
    expect(lib().entries[x]).toMatchObject({ parentId: parent, shared: true, secretFrom: 'invite' })
    expect((await homeCardsFor(x)).active).toBe(0)
  })

  it('brings back only the joined board\'s card from a deleted group', async () => {
    const x = newBoardId()
    const k = newSecret()
    let noteId = ''
    await docs.withDoc('home', (home) => {
      const card = createCard(home, 'board', { boardId: x, secret: k, title: 'X' }, 'me')
      noteId = createCard(home, 'note', {}, 'me')
      deleteCards(home, [card, noteId], 'me')
    })
    lib().upsert({ id: x, secret: k, parentId: 'home' })
    await joinBoard({ b: x, k, t: 'X' })
    expect(await homeCardsFor(x)).toEqual({ active: 1, trashed: 0 })
    const noteTrashed = await docs.withDoc('home', (home) => isTrashed(getCards(home).get(noteId)!))
    expect(noteTrashed).toBe(true)
  })
})

describe('leaveBoard', () => {
  it('removes the boards only reachable through the left board, and keeps the rest', async () => {
    const p = newBoardId()
    const k = newBoardId()
    const onlyInP = newBoardId()
    const alsoInK = newBoardId()
    const joined = newBoardId()
    const s = Object.fromEntries([p, k, onlyInP, alsoInK, joined].map((id) => [id, newSecret()]))
    await makeBoard(onlyInP)
    await makeBoard(alsoInK)
    await makeBoard(joined)
    await makeBoard(p, [onlyInP, alsoInK, joined].map((id) => ({ boardId: id, secret: s[id] })))
    await makeBoard(k, [{ boardId: alsoInK, secret: s[alsoInK] }])
    await docs.withDoc('home', (home) => {
      createCard(home, 'board', { boardId: p, secret: s[p] }, 'me')
      createCard(home, 'board', { boardId: k, secret: s[k] }, 'me')
    })
    lib().upsert({ id: p, secret: s[p], secretFrom: 'invite', shared: true, parentId: 'home' })
    lib().upsert({ id: k, secret: s[k], parentId: 'home' })
    // Shared directly by its own meta (markShared): its room must close too.
    lib().upsert({ id: onlyInP, secret: s[onlyInP], secretFrom: 'card', shared: true, parentId: p })
    lib().upsert({ id: alsoInK, secret: s[alsoInK], secretFrom: 'card', parentId: p })
    lib().upsert({ id: joined, secret: s[joined], secretFrom: 'invite', shared: true, parentId: p })

    await leaveBoard(p)
    const e = lib().entries
    expect(e[p]).toBeUndefined()
    expect(e[onlyInP]).toBeUndefined()
    expect(docs.peek(onlyInP)).toBeUndefined()
    expect(e[alsoInK]).toBeDefined()
    // Joined with its own invite: stays, now on Home (in the Unsorted drawer).
    expect(e[joined]).toMatchObject({ shared: true, parentId: 'home' })
    expect((await homeCardsFor(joined)).active).toBe(1)
    expect(await homeDrawerCardsFor(joined)).toHaveLength(1)
    expect((await homeCardsFor(p)).active).toBe(0)
  })

  it('never deletes a board of ours that someone named in the left board with a made-up key', async () => {
    const p = newBoardId()
    const mine = newBoardId()
    const sp = newSecret()
    await makeBoard(mine)
    // Not on Home (e.g. only found through search), so nothing else keeps it.
    lib().upsert({ id: mine, secret: newSecret(), title: 'Diary', parentId: null })
    await makeBoard(p, [{ boardId: mine, secret: newSecret() }])
    await docs.withDoc('home', (home) => createCard(home, 'board', { boardId: p, secret: sp }, 'me'))
    lib().upsert({ id: p, secret: sp, secretFrom: 'invite', shared: true, parentId: 'home' })
    await leaveBoard(p)
    expect(lib().entries[p]).toBeUndefined()
    expect(lib().entries[mine]).toMatchObject({ title: 'Diary' })
    expect(docs.peek(mine) ?? null).not.toBeNull()
  })
})
