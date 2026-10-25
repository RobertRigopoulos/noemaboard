import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { strToU8, zipSync } from 'fflate'
import { APP_NAME } from '../../config'
import { docs } from '../../collab/docs'
import { putBlob } from '../../collab/blobs'
import { useLibrary } from '../../collab/library'
import { createCard, getCards, initBoardDoc, isTrashed, LOCAL_ORIGIN } from '../../model/board'
import { newSecret } from '../../model/ids'
import {
  BACKUP_FORMAT,
  BackupError,
  backupFileName,
  exportBackup,
  HOME_NOTES_TITLE,
  homeBoards,
  importBackup,
  packBackup,
  safeFileName,
  unpackBackup,
  validateManifest,
  type BackupManifest,
} from './backup'

const SECRET = 'k'.repeat(43)
const HASH = 'b'.repeat(64)

function manifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: 1700000000000,
    boards: [
      { id: 'board_root_1', secret: SECRET, title: 'Root', parentId: 'home' },
      { id: 'board_child_1', secret: SECRET, title: 'Child', parentId: 'board_root_1' },
    ],
    rootIds: ['board_root_1'],
    blobs: [{ hash: HASH, mime: 'image/png' }],
    ...over,
  }
}

/**
 * Hand-built zip with one stored local entry at offset 0 and a central directory whose entries
 * all point at it, with whatever sizes the test declares (things fflate's writer never produces).
 */
function rawZip(data: Uint8Array, entries: { name: string; size: number; originalSize: number }[]): Uint8Array {
  const enc = new TextEncoder()
  const out: number[] = []
  const u16 = (...vs: number[]) => vs.forEach((v) => out.push(v & 0xff, (v >>> 8) & 0xff))
  const u32 = (...vs: number[]) => vs.forEach((v) => u16(v & 0xffff, (v >>> 16) & 0xffff))
  const put = (b: Uint8Array) => b.forEach((x) => out.push(x))
  const localName = enc.encode(entries[0].name)
  // Local file header
  u32(0x04034b50)
  u16(20, 0, 0, 0, 0) // version, flags, method (stored), time, date
  u32(0, data.length, data.length) // crc, compressed size, size
  u16(localName.length, 0) // name length, extra length
  put(localName)
  put(data)
  const cdStart = out.length
  for (const e of entries) {
    const name = enc.encode(e.name)
    // Central directory header
    u32(0x02014b50)
    u16(20, 20, 0, 0, 0, 0) // made by, needed, flags, method (stored), time, date
    u32(0, e.size, e.originalSize) // crc, compressed size, declared size
    u16(name.length, 0, 0, 0, 0) // name, extra, comment lengths, disk, internal attributes
    u32(0, 0) // external attributes, local header offset
    put(name)
  }
  const cdSize = out.length - cdStart
  // End of central directory
  u32(0x06054b50)
  u16(0, 0, entries.length, entries.length)
  u32(cdSize, cdStart)
  u16(0)
  return new Uint8Array(out)
}

const expectError = (raw: unknown, match: RegExp) => {
  const r = validateManifest(raw)
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toMatch(match)
}

describe('validateManifest', () => {
  it('accepts a well-formed manifest and normalises it', () => {
    const r = validateManifest(manifest({ extra: 'ignored', boards: [{ id: 'board_root_1', secret: SECRET, title: 'x'.repeat(900) }] }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.boards[0].title).toHaveLength(500)
    expect(r.manifest.boards[0].parentId).toBeNull()
    expect(r.manifest.rootIds).toEqual(['board_root_1'])
    expect(r.manifest.blobs).toEqual([{ hash: HASH, mime: 'image/png' }])
  })

  it('derives roots when rootIds is missing', () => {
    const r = validateManifest(manifest({ rootIds: undefined }))
    expect(r.ok && r.manifest.rootIds).toEqual(['board_root_1'])
  })

  it('rejects wrong format, versions and shapes', () => {
    expectError(null, /not an object/)
    expectError([], /not an object/)
    expectError(manifest({ format: 'zip' }), new RegExp(`not a ${APP_NAME} backup`))
    expectError(manifest({ version: 2 }), /newer version/)
    expectError(manifest({ version: '1' }), /version/)
    expectError(manifest({ boards: [] }), /any boards/)
    expectError(manifest({ boards: 'x' }), /does not list/)
  })

  it('rejects invalid board ids, secrets, titles, parents and duplicates', () => {
    expectError(manifest({ boards: [{ id: '../../etc', secret: SECRET, title: 'a' }] }), /invalid id/)
    expectError(manifest({ boards: [{ id: 'short', secret: SECRET, title: 'a' }] }), /invalid id/)
    expectError(manifest({ boards: [{ id: 'board_root_1', secret: 'tooshort', title: 'a' }] }), /invalid key/)
    expectError(manifest({ boards: [{ id: 'board_root_1', secret: SECRET, title: 42 }] }), /invalid title/)
    expectError(manifest({ boards: [{ id: 'board_root_1', secret: SECRET, title: 'a', parentId: 'bad parent!' }] }), /invalid parent/)
    expectError(
      manifest({
        boards: [
          { id: 'board_root_1', secret: SECRET, title: 'a' },
          { id: 'board_root_1', secret: SECRET, title: 'b' },
        ],
      }),
      /same board twice/,
    )
  })

  it('rejects roots that are not in the backup and malformed blob entries', () => {
    expectError(manifest({ rootIds: ['board_other_1'] }), /missing board/)
    expectError(manifest({ rootIds: [] }), /no top-level board/)
    expectError(manifest({ blobs: [{ hash: 'nothex' }] }), /file entry/)
    const r = validateManifest(manifest({ blobs: [{ hash: HASH, mime: '<script>' }] }))
    expect(r.ok && r.manifest.blobs[0].mime).toBe('')
  })
})

describe('pack / unpack', () => {
  const valid = validateManifest(manifest())
  const m = (valid.ok ? valid.manifest : null) as BackupManifest

  it('round-trips boards and blobs', () => {
    const updates = new Map([
      ['board_root_1', new Uint8Array([1, 2, 3])],
      ['board_child_1', new Uint8Array([4])],
    ])
    const blobs = new Map([[HASH, new Uint8Array([9, 9])]])
    const out = unpackBackup(packBackup(m, updates, blobs))
    expect(out.manifest.boards.map((b) => b.id)).toEqual(['board_root_1', 'board_child_1'])
    expect(Array.from(out.updates.get('board_child_1')!)).toEqual([4])
    expect(Array.from(out.blobs.get(HASH)!)).toEqual([9, 9])
  })

  it('fails clearly on missing data, bad JSON and non-zip files', () => {
    const missing = packBackup(m, new Map([['board_root_1', new Uint8Array([1])]]), new Map())
    expect(() => unpackBackup(missing)).toThrow(/incomplete/)
    const badJson = zipSync({ 'manifest.json': strToU8('{nope') })
    expect(() => unpackBackup(badJson)).toThrow(/not valid JSON/)
    expect(() => unpackBackup(zipSync({ 'other.txt': strToU8('hi') }))).toThrow(/manifest.json is missing/)
    expect(() => unpackBackup(new Uint8Array([1, 2, 3, 4]))).toThrow(BackupError)
  })

  it('rejects stored entries whose declared size does not match their data', () => {
    // fflate copies a stored entry by its compressed size; the limits only see the declared size.
    const data = new Uint8Array(1000)
    const lying = rawZip(data, [{ name: `blobs/${'c'.repeat(64)}`, size: 1000, originalSize: 1 }])
    expect(() => unpackBackup(lying)).toThrow(/damaged/)
    // The same zip with honest sizes is readable (it only lacks a manifest).
    const honest = rawZip(data, [{ name: `blobs/${'c'.repeat(64)}`, size: 1000, originalSize: 1000 }])
    expect(() => unpackBackup(honest)).toThrow(/manifest.json is missing/)
  })

  it('rejects zips whose entries all point at the same data (zip bomb)', () => {
    const data = new Uint8Array(1000)
    const entries = Array.from({ length: 40 }, (_, i) => ({ name: `blobs/${i.toString(16).padStart(64, '0')}`, size: 1000, originalSize: 1000 }))
    const bomb = rawZip(data, entries)
    expect(bomb.length).toBeLessThan(40 * 1000)
    expect(() => unpackBackup(bomb)).toThrow(/damaged/)
  })

  it('ignores unexpected entries such as path traversal names', () => {
    const files = {
      'manifest.json': strToU8(JSON.stringify(manifest({ blobs: [] }))),
      'boards/board_root_1.bin': new Uint8Array([1]),
      'boards/board_child_1.bin': new Uint8Array([2]),
      '../evil.bin': new Uint8Array([3]),
      'blobs/not-a-hash': new Uint8Array([4]),
    }
    const out = unpackBackup(zipSync(files))
    expect(out.blobs.size).toBe(0)
    expect(out.updates.size).toBe(2)
  })
})

describe('file names', () => {
  it('strips characters that are invalid in file names', () => {
    expect(safeFileName('a/b:c*d?"e<f>g|h')).toBe('a b c d e f g h')
    expect(safeFileName('...')).toBe('board')
    expect(backupFileName('Q3 / plan', new Date(2026, 0, 5))).toBe(`${APP_NAME} backup - Q3 plan - 2026-01-05.noema`)
  })
})

describe('exportBackup / importBackup', () => {
  it('backs up a board with nested boards and blobs, and imports it again', async () => {
    const user = 'tester'
    const rootId = 'rootBoard0001'
    const childId = 'childBoard0001'
    const rootSecret = newSecret()
    const childSecret = newSecret()
    const image = await putBlob(new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }))

    await docs.withDoc('home', (d) => initBoardDoc(d, { id: 'home', title: 'Home' }, user))
    await docs.withDoc(rootId, (d) => {
      initBoardDoc(d, { id: rootId, title: 'Root board', parentId: 'home' }, user)
      createCard(d, 'note', { x: 0, y: 0 }, user)
      createCard(d, 'board', { x: 400, y: 0, boardId: childId, secret: childSecret, title: 'Child' }, user)
    })
    await docs.withDoc(childId, (d) => {
      initBoardDoc(d, { id: childId, title: 'Child', parentId: rootId }, user)
      createCard(d, 'image', { blob: image.hash, name: 'a.png', mime: 'image/png' }, user)
    })
    // The child's key is only known from the board card (library not yet indexed).
    useLibrary.getState().upsert({ id: rootId, secret: rootSecret, title: 'Root board', parentId: 'home' })

    const res = await exportBackup([rootId])
    expect(res).toMatchObject({ boards: 2, blobs: 1, missingBlobs: 0 })
    const unpacked = unpackBackup(res.bytes)
    expect(unpacked.manifest.boards.map((b) => [b.id, b.secret])).toEqual([
      [rootId, rootSecret],
      [childId, childSecret],
    ])
    expect(unpacked.manifest.rootIds).toEqual([rootId])

    // Simulate another device: forget the boards.
    await docs.destroyLocal(rootId)
    await docs.destroyLocal(childId)
    useLibrary.getState().remove(rootId)
    useLibrary.getState().remove(childId)

    const summary = await importBackup(new Blob([res.bytes as Uint8Array<ArrayBuffer>]))
    expect(summary).toMatchObject({ boards: 2, blobs: 1, addedToHome: 1, skipped: 0, badBlobs: 0, firstRootId: rootId })
    const notes = await docs.withDoc(rootId, (d) => Array.from(getCards(d).values()).filter((m) => m.get('type') === 'note').length)
    expect(notes).toBe(1)
    expect(useLibrary.getState().entries[childId]).toMatchObject({ secret: childSecret, parentId: rootId })
    expect(useLibrary.getState().entries[rootId]).toMatchObject({ secret: rootSecret, parentId: 'home' })
    const homeCards = await docs.withDoc('home', (d) =>
      Array.from(getCards(d).values()).filter((m) => !isTrashed(m) && m.get('boardId') === rootId).length,
    )
    expect(homeCards).toBe(1)

    // Importing again merges without duplicating the Home card.
    const again = await importBackup(new Blob([res.bytes as Uint8Array<ArrayBuffer>]))
    expect(again).toMatchObject({ boards: 2, addedToHome: 0 })

    // A board with the same id but a different key is never merged.
    useLibrary.getState().upsert({ id: rootId, secret: newSecret() })
    const conflict = await importBackup(new Blob([res.bytes as Uint8Array<ArrayBuffer>]))
    expect(conflict.skipped).toBe(1)
  })

  it('keeps every file a card refers to (thumbnails, favicons) and parks new Home boards in Unsorted', async () => {
    const user = 'tester'
    const id = 'thumbBoard_01'
    const secret = newSecret()
    const original = await putBlob(new Blob([new Uint8Array([9, 8, 7, 6, 5])], { type: 'image/png' }))
    const thumb = await putBlob(new Blob([new Uint8Array([5, 6])], { type: 'image/webp' }))
    const favicon = await putBlob(new Blob([new Uint8Array([1, 1, 2, 3])], { type: 'image/png' }))
    await docs.withDoc(id, (d) => {
      initBoardDoc(d, { id, title: 'Thumbs', parentId: 'home' }, user)
      createCard(d, 'image', { blob: original.hash, thumb: thumb.hash, name: 'a.png', mime: 'image/png', iw: 10, ih: 10 }, user)
      createCard(d, 'link', { url: 'https://example.com', favicon: favicon.hash }, user)
    })
    useLibrary.getState().upsert({ id, secret, title: 'Thumbs', parentId: 'home' })

    const res = await exportBackup([id])
    expect(res).toMatchObject({ boards: 1, blobs: 3, missingBlobs: 0 })
    const unpacked = unpackBackup(res.bytes)
    expect(new Set(unpacked.manifest.blobs.map((b) => b.hash))).toEqual(new Set([original.hash, thumb.hash, favicon.hash]))
    expect(new Set(unpacked.blobs.keys())).toEqual(new Set([original.hash, thumb.hash, favicon.hash]))

    await docs.destroyLocal(id)
    useLibrary.getState().remove(id)
    const summary = await importBackup(new Blob([res.bytes as Uint8Array<ArrayBuffer>]))
    expect(summary).toMatchObject({ boards: 1, blobs: 3, addedToHome: 1, badBlobs: 0 })
    const back = await docs.withDoc(id, (d) =>
      Array.from(getCards(d).values()).map((m) => ({ type: m.get('type'), thumb: m.get('thumb'), favicon: m.get('favicon') })),
    )
    expect(back).toContainEqual({ type: 'image', thumb: thumb.hash, favicon: undefined })
    expect(back).toContainEqual({ type: 'link', thumb: undefined, favicon: favicon.hash })
    const homeCard = await docs.withDoc('home', (d) => Array.from(getCards(d).values()).find((m) => !isTrashed(m) && m.get('boardId') === id))
    expect(homeCard?.get('unsorted')).toBe(true)
    expect(typeof homeCard?.get('order')).toBe('string')
  })

  it('carries the cards placed directly on Home as an extra board in a full backup', async () => {
    const user = 'tester'
    const boardId = 'homeNotesPlans1'
    const boardSecret = newSecret()
    const pic = await putBlob(new Blob([new Uint8Array([4, 4, 4, 2])], { type: 'image/png' }))
    await docs.withDoc(boardId, (d) => initBoardDoc(d, { id: boardId, title: 'Plans', parentId: 'home' }, user))
    useLibrary.getState().upsert({ id: boardId, secret: boardSecret, title: 'Plans', parentId: 'home' })
    await docs.withDoc('home', (d) => initBoardDoc(d, { id: 'home', title: 'Home' }, user))

    // Home with only boards on it: nothing extra.
    const onlyBoards = await homeBoards()
    const before = unpackBackup((await exportBackup(onlyBoards.ids, { secrets: onlyBoards.secrets, homeNotes: true })).bytes)
    expect(before.manifest.boards.some((b) => b.title === HOME_NOTES_TITLE)).toBe(false)

    let noteId = ''
    await docs.withDoc('home', (d) => {
      noteId = createCard(d, 'note', { x: 9100, y: 9100, color: 'yellow' }, user)
      createCard(d, 'image', { x: 9500, y: 9100, blob: pic.hash, name: 'p.png', mime: 'image/png' }, user)
      createCard(d, 'note', { x: 9100, y: 9500, unsorted: true, order: 'a0' }, user)
      const boardCard = createCard(d, 'board', { x: 9900, y: 9100, boardId, secret: boardSecret, title: 'Plans' }, user)
      createCard(d, 'line', { from: { card: noteId, x: 9100, y: 9100 }, to: { card: boardCard, x: 9900, y: 9100 } }, user)
    })

    const { ids, secrets } = await homeBoards()
    expect(ids).toContain(boardId)
    const res = await exportBackup(ids, { secrets, homeNotes: true })
    const unpacked = unpackBackup(res.bytes)
    const notesBoard = unpacked.manifest.boards.find((b) => b.title === HOME_NOTES_TITLE)
    if (!notesBoard) throw new Error('no notes board')
    expect(notesBoard.parentId).toBe('home')
    expect(unpacked.manifest.rootIds).toEqual(expect.arrayContaining([boardId, notesBoard.id]))
    expect(unpacked.manifest.blobs.map((b) => b.hash)).toContain(pic.hash)

    const scratch = new Y.Doc({ guid: notesBoard.id })
    Y.applyUpdate(scratch, unpacked.updates.get(notesBoard.id)!)
    const copied = Array.from(getCards(scratch).values()).filter((m) => !isTrashed(m))
    expect(copied.some((m) => m.get('type') === 'board')).toBe(false)
    const notes = copied.filter((m) => m.get('type') === 'note')
    expect(notes.map((m) => [m.get('x'), m.get('y')])).toEqual(expect.arrayContaining([[9100, 9100], [9100, 9500]]))
    expect(notes.find((m) => m.get('y') === 9500)?.get('unsorted')).toBe(true)
    expect(copied.some((m) => m.get('type') === 'image' && m.get('blob') === pic.hash)).toBe(true)
    // Fresh card ids; the line keeps its note end and lets go of the board it pointed at.
    const copiedNote = notes.find((m) => m.get('y') === 9100)!
    expect(copiedNote.get('id')).not.toBe(noteId)
    const line = copied.find((m) => m.get('type') === 'line')!
    expect(line.get('from')).toMatchObject({ card: copiedNote.get('id') })
    expect(line.get('to')).toMatchObject({ card: null, x: 9900, y: 9100 })
    scratch.destroy()

    // On another device the notes arrive as a board in Home's Unsorted drawer.
    await docs.destroyLocal(notesBoard.id)
    const summary = await importBackup(new Blob([res.bytes as Uint8Array<ArrayBuffer>]))
    expect(summary.skipped).toBe(0)
    expect(useLibrary.getState().entries[notesBoard.id]).toMatchObject({ secret: notesBoard.secret, parentId: 'home', title: HOME_NOTES_TITLE })
    const homeCard = await docs.withDoc('home', (d) =>
      Array.from(getCards(d).values()).find((m) => !isTrashed(m) && m.get('boardId') === notesBoard.id),
    )
    expect(homeCard?.get('unsorted')).toBe(true)
    const arrived = await docs.withDoc(notesBoard.id, (d) => Array.from(getCards(d).values()).filter((m) => m.get('type') === 'note').length)
    expect(arrived).toBeGreaterThanOrEqual(2)
  })

  it('skips damaged board data', async () => {
    const valid = validateManifest(manifest({ blobs: [], boards: [{ id: 'damaged_0001', secret: SECRET, title: 'Bad' }], rootIds: ['damaged_0001'] }))
    if (!valid.ok) throw new Error(valid.error)
    const bytes = packBackup(valid.manifest, new Map([['damaged_0001', new Uint8Array([255, 255, 255, 1, 2])]]), new Map())
    const summary = await importBackup(new Blob([bytes as Uint8Array<ArrayBuffer>]))
    expect(summary.boards).toBe(0)
    expect(summary.skipped).toBe(1)
  })

  it('puts imported boards on Home outside the undo history', async () => {
    const id = 'undoImport_01'
    const valid = validateManifest(manifest({ blobs: [], boards: [{ id, secret: SECRET, title: 'Imported' }], rootIds: [id] }))
    if (!valid.ok) throw new Error(valid.error)
    const doc = new Y.Doc({ guid: id })
    initBoardDoc(doc, { id, title: 'Imported' }, 'u')
    const bytes = packBackup(valid.manifest, new Map([[id, Y.encodeStateAsUpdate(doc)]]), new Map())

    // Home is open with its canvas undo history, as when importing from Home's Export menu.
    const home = docs.open('home')
    await home.ready
    initBoardDoc(home.doc, { id: 'home', title: 'Home' }, 'u')
    const undo = new Y.UndoManager([getCards(home.doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    try {
      const summary = await importBackup(new Blob([bytes as Uint8Array<ArrayBuffer>]))
      expect(summary.addedToHome).toBe(1)
      expect(undo.undoStack).toHaveLength(0)
      undo.undo()
      const onHome = Array.from(getCards(home.doc).values()).filter((m) => !isTrashed(m) && m.get('boardId') === id).length
      expect(onHome).toBe(1)
    } finally {
      undo.destroy()
      home.release()
    }
  })

  it('rejects a blob whose content does not match its hash', async () => {
    const valid = validateManifest(manifest({ boards: [{ id: 'blobtest_001', secret: SECRET, title: 'B' }], rootIds: ['blobtest_001'] }))
    if (!valid.ok) throw new Error(valid.error)
    const doc = new Y.Doc({ guid: 'blobtest_001' })
    initBoardDoc(doc, { id: 'blobtest_001', title: 'B' }, 'u')
    const bytes = packBackup(valid.manifest, new Map([['blobtest_001', Y.encodeStateAsUpdate(doc)]]), new Map([[HASH, new Uint8Array([1])]]))
    const summary = await importBackup(new Blob([bytes as Uint8Array<ArrayBuffer>]))
    expect(summary).toMatchObject({ boards: 1, blobs: 0, badBlobs: 1 })
  })
})
