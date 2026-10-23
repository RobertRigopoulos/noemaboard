/**
 * Board backups (".noema" files): a zip with
 *   manifest.json        { format, version, createdAt, boards: [{ id, secret, title, parentId }], rootIds, blobs }
 *   boards/<id>.bin      Y.encodeStateAsUpdate of each board doc
 *   blobs/<sha256>       raw bytes of every referenced image / file
 *
 * A backup contains board secrets (it grants full access, like an invite link). Importing
 * merges into existing boards (CRDT updates), so importing twice is harmless.
 * Backup files are untrusted input: the manifest and every entry are validated strictly.
 */
import * as Y from 'yjs'
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate'
import { APP_NAME, HOME_BOARD_ID } from '../../config'
import { docs } from '../../collab/docs'
import { isReachableFromHome } from '../../collab/boards'
import { getLocalBlob, MAX_BLOB_BYTES, putVerifiedBlob } from '../../collab/blobs'
import { isValidBlobHash } from '../../collab/crypto'
import { getUser } from '../../collab/identity'
import { getLibraryEntry, useLibrary } from '../../collab/library'
import { createCard, getCards, isTrashed, readCard, readMeta, SYSTEM_ORIGIN } from '../../model/board'
import { boardBlobHashes } from '../../model/blobRefs'
import { isValidId } from '../../model/ids'
import { moveToUnsorted } from '../../model/unsorted'

export const BACKUP_FORMAT = 'noema-backup'
export const BACKUP_VERSION = 1
export const BACKUP_EXTENSION = '.noema'

export const BACKUP_LIMITS = {
  boards: 5000,
  blobs: 50_000,
  titleLength: 500,
  manifestBytes: 8 * 1024 * 1024,
  boardBytes: 128 * 1024 * 1024,
  blobBytes: MAX_BLOB_BYTES,
  /**
   * Upper bound for everything extracted from one backup. Importing holds the file and everything
   * extracted from it in memory at once, so this stays well below what a browser tab can allocate.
   * Exports keep below it too, so every backup this app writes can be imported again.
   */
  totalBytes: 1024 * 1024 * 1024,
  /** Upper bound for the backup file itself (the data plus zip headers for every entry). */
  fileBytes: 1024 * 1024 * 1024 + 64 * 1024 * 1024,
}

export interface BackupBoard {
  id: string
  secret: string
  title: string
  /** Board this one was created in, or null / 'home' for top-level boards. */
  parentId: string | null
}

export interface BackupBlob {
  hash: string
  mime: string
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  createdAt: number
  app: string
  boards: BackupBoard[]
  /** Boards that were exported directly (the others are nested inside them). */
  rootIds: string[]
  blobs: BackupBlob[]
}

export class BackupError extends Error {}

const SECRET_RE = /^[A-Za-z0-9_-]{32,64}$/
const MIME_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type ManifestResult = { ok: true; manifest: BackupManifest } | { ok: false; error: string }

/** Strictly validates a parsed manifest.json and returns a normalised copy. */
export function validateManifest(raw: unknown): ManifestResult {
  const fail = (error: string): ManifestResult => ({ ok: false, error })
  if (!isObj(raw)) return fail('The backup manifest is not an object.')
  if (raw.format !== BACKUP_FORMAT) return fail(`This is not a ${APP_NAME} backup.`)
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version)) return fail('The backup version is missing.')
  if (raw.version > BACKUP_VERSION) return fail(`This backup was made by a newer version of ${APP_NAME}. Update the app to import it.`)
  if (raw.version < 1) return fail('The backup version is not supported.')
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) && raw.createdAt >= 0 ? raw.createdAt : 0

  if (!Array.isArray(raw.boards)) return fail('The backup does not list any boards.')
  if (raw.boards.length === 0) return fail('The backup does not contain any boards.')
  if (raw.boards.length > BACKUP_LIMITS.boards) return fail(`The backup contains more than ${BACKUP_LIMITS.boards} boards.`)
  const boards: BackupBoard[] = []
  const ids = new Set<string>()
  for (const b of raw.boards) {
    if (!isObj(b)) return fail('A board entry in the backup is malformed.')
    if (!isValidId(b.id)) return fail('A board in the backup has an invalid id.')
    if (ids.has(b.id)) return fail('The backup lists the same board twice.')
    if (typeof b.secret !== 'string' || !SECRET_RE.test(b.secret)) return fail('A board in the backup has an invalid key.')
    if (b.title !== undefined && typeof b.title !== 'string') return fail('A board in the backup has an invalid title.')
    const parentId = b.parentId === HOME_BOARD_ID || isValidId(b.parentId) ? (b.parentId as string) : null
    if (b.parentId !== undefined && b.parentId !== null && parentId === null) return fail('A board in the backup has an invalid parent.')
    ids.add(b.id)
    boards.push({
      id: b.id,
      secret: b.secret,
      title: (typeof b.title === 'string' ? b.title : '').slice(0, BACKUP_LIMITS.titleLength) || 'Untitled board',
      parentId,
    })
  }

  let rootIds: string[]
  if (raw.rootIds === undefined) {
    rootIds = boards.filter((b) => !b.parentId || !ids.has(b.parentId)).map((b) => b.id)
  } else {
    if (!Array.isArray(raw.rootIds)) return fail('The backup root list is malformed.')
    rootIds = []
    for (const r of raw.rootIds) {
      if (typeof r !== 'string' || !ids.has(r)) return fail('The backup root list refers to a missing board.')
      if (!rootIds.includes(r)) rootIds.push(r)
    }
  }
  if (!rootIds.length) return fail('The backup has no top-level board.')

  const blobs: BackupBlob[] = []
  if (raw.blobs !== undefined) {
    if (!Array.isArray(raw.blobs)) return fail('The backup file list is malformed.')
    if (raw.blobs.length > BACKUP_LIMITS.blobs) return fail('The backup contains too many files.')
    const seen = new Set<string>()
    for (const b of raw.blobs) {
      if (!isObj(b) || !isValidBlobHash(b.hash)) return fail('A file entry in the backup is malformed.')
      if (seen.has(b.hash)) continue
      seen.add(b.hash)
      blobs.push({ hash: b.hash, mime: typeof b.mime === 'string' && MIME_RE.test(b.mime) ? b.mime : '' })
    }
  }

  return {
    ok: true,
    manifest: { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt, app: APP_NAME, boards, rootIds, blobs },
  }
}

// ---------------------------------------------------------------------------
// Zip packing (pure)

export function packBackup(manifest: BackupManifest, updates: Map<string, Uint8Array>, blobs: Map<string, Uint8Array>): Uint8Array {
  const files: Zippable = { 'manifest.json': [strToU8(JSON.stringify(manifest, null, 2)), { level: 6 }] }
  for (const b of manifest.boards) {
    const u = updates.get(b.id)
    if (u) files[`boards/${b.id}.bin`] = [u, { level: 6 }]
  }
  // Images and files are usually compressed already: store them as-is (much faster).
  for (const [hash, bytes] of blobs) files[`blobs/${hash}`] = [bytes, { level: 0 }]
  return zipSync(files, { mtime: new Date() })
}

export interface UnpackedBackup {
  manifest: BackupManifest
  updates: Map<string, Uint8Array>
  blobs: Map<string, Uint8Array>
}

const DAMAGED = 'This backup file is damaged and cannot be imported.'

/**
 * Reads and validates a backup zip. Throws BackupError with a user-facing message.
 *
 * Every limit is checked before an entry is extracted, against sizes the zip declares, so the
 * declared sizes must be what extraction really allocates:
 *  - a deflated entry is inflated into a buffer of exactly its declared size;
 *  - a stored entry is copied using its *compressed* size, so it must equal the declared size;
 *  - the central directory may list many entries pointing at the same data. Real entries never
 *    overlap, so together their compressed data cannot be larger than the file.
 */
export function unpackBackup(bytes: Uint8Array): UnpackedBackup {
  let total = 0
  let compressed = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (f.compression !== 0 && f.compression !== 8) return false
        let limit = 0
        if (f.name === 'manifest.json') limit = BACKUP_LIMITS.manifestBytes
        else if (/^boards\/[0-9a-zA-Z_-]{6,64}\.bin$/.test(f.name)) limit = BACKUP_LIMITS.boardBytes
        else if (/^blobs\/[0-9a-f]{64}$/.test(f.name)) limit = BACKUP_LIMITS.blobBytes
        else return false // ignore anything we did not write
        if (f.compression === 0 && f.size !== f.originalSize) throw new BackupError(DAMAGED)
        compressed += f.size
        if (compressed > bytes.length) throw new BackupError(DAMAGED)
        if (f.originalSize > limit) throw new BackupError(`"${f.name}" in the backup is too large.`)
        total += f.originalSize
        if (total > BACKUP_LIMITS.totalBytes) throw new BackupError('The backup is too large to import.')
        return true
      },
    })
  } catch (e) {
    if (e instanceof BackupError) throw e
    throw new BackupError(`This file is not a valid ${APP_NAME} backup (it could not be unzipped).`)
  }
  const manifestBytes = files['manifest.json']
  if (!manifestBytes) throw new BackupError(`This file is not a ${APP_NAME} backup (manifest.json is missing).`)
  let raw: unknown
  try {
    raw = JSON.parse(strFromU8(manifestBytes))
  } catch {
    throw new BackupError('The backup manifest is not valid JSON.')
  }
  const res = validateManifest(raw)
  if (!res.ok) throw new BackupError(res.error)
  const { manifest } = res

  const updates = new Map<string, Uint8Array>()
  for (const b of manifest.boards) {
    const u = files[`boards/${b.id}.bin`]
    if (!u) throw new BackupError(`The backup is incomplete: the data for "${b.title}" is missing.`)
    updates.set(b.id, u)
  }
  const blobs = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(files)) {
    if (name.startsWith('blobs/')) blobs.set(name.slice(6), data)
  }
  return { manifest, updates, blobs }
}

// ---------------------------------------------------------------------------
// Export

/** Top-level boards on Home (what a full backup starts from), with the keys stored on their cards. */
export async function homeBoards(): Promise<{ ids: string[]; secrets: Map<string, string> }> {
  return docs.withDoc(HOME_BOARD_ID, (home) => {
    const ids: string[] = []
    const secrets = new Map<string, string>()
    getCards(home).forEach((m) => {
      if (!(m instanceof Y.Map) || isTrashed(m) || m.get('type') !== 'board') return
      const id = m.get('boardId')
      const secret = m.get('secret')
      if (!isValidId(id) || ids.includes(id)) return
      ids.push(id)
      if (typeof secret === 'string' && SECRET_RE.test(secret)) secrets.set(id, secret)
    })
    return { ids, secrets }
  })
}

export interface ExportResult {
  bytes: Uint8Array
  boards: number
  blobs: number
  /** Images/files that are not on this device (never downloaded from a teammate). */
  missingBlobs: number
}

export interface ExportOptions {
  /** Keys already known from board cards (used when the library has not indexed them yet). */
  secrets?: Map<string, string>
  /** Reports the number of boards collected so far. */
  onProgress?: (boards: number) => void
}

/** Builds a backup of the given boards and every board nested inside them. */
export async function exportBackup(boardIds: string[], opts: ExportOptions = {}): Promise<ExportResult> {
  const { onProgress } = opts
  const roots = boardIds.filter((id) => isValidId(id))
  if (!roots.length) throw new BackupError('There are no boards to back up.')
  const boards: BackupBoard[] = []
  const updates = new Map<string, Uint8Array>()
  const hashes = new Set<string>()
  const cardSecrets = new Map<string, string>(opts.secrets)
  const seen = new Set<string>()
  const queue = [...roots]

  while (queue.length && boards.length < BACKUP_LIMITS.boards) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const entry = getLibraryEntry(id)
    const secret = entry?.secret || cardSecrets.get(id) || ''
    // Without its key a board could never be shared or synced again; skip it.
    if (!SECRET_RE.test(secret)) continue
    await docs.withDoc(id, (doc) => {
      const meta = readMeta(doc)
      const hasMeta = getMetaId(doc) === id
      updates.set(id, Y.encodeStateAsUpdate(doc))
      boards.push({
        id,
        secret,
        title: (hasMeta ? meta.title : entry?.title || 'Untitled board').slice(0, BACKUP_LIMITS.titleLength),
        parentId: (hasMeta ? meta.parentId : null) ?? entry?.parentId ?? null,
      })
      // Every file the board refers to (thumbnails, favicons, card covers and the board's own cover),
      // trashed cards included: they can be restored.
      for (const h of boardBlobHashes(doc)) hashes.add(h)
      getCards(doc).forEach((m) => {
        if (!(m instanceof Y.Map) || m.get('type') !== 'board') return
        const child = m.get('boardId')
        const childSecret = m.get('secret')
        if (!isValidId(child) || seen.has(child)) return
        if (typeof childSecret === 'string' && SECRET_RE.test(childSecret) && !cardSecrets.has(child)) cardSecrets.set(child, childSecret)
        queue.push(child)
      })
    })
    onProgress?.(boards.length)
  }
  if (!boards.length) throw new BackupError('These boards could not be read.')

  const blobData = new Map<string, Uint8Array>()
  const blobMeta: BackupBlob[] = []
  let missing = 0
  // Keep the whole backup importable (see unpackBackup): boards + manifest + files <= totalBytes.
  let boardBytes = 0
  for (const u of updates.values()) boardBytes += u.byteLength
  const budget = BACKUP_LIMITS.totalBytes - boardBytes - BACKUP_LIMITS.manifestBytes
  let total = 0
  for (const hash of hashes) {
    const blob = await getLocalBlob(hash)
    if (!blob) {
      missing++
      continue
    }
    if (total + blob.size > budget) {
      missing++
      continue
    }
    total += blob.size
    blobData.set(hash, new Uint8Array(await blob.arrayBuffer()))
    blobMeta.push({ hash, mime: MIME_RE.test(blob.type) ? blob.type : '' })
  }

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: Date.now(),
    app: APP_NAME,
    boards,
    rootIds: roots.filter((id) => boards.some((b) => b.id === id)),
    blobs: blobMeta,
  }
  return { bytes: packBackup(manifest, updates, blobData), boards: boards.length, blobs: blobData.size, missingBlobs: missing }
}

function getMetaId(doc: Y.Doc): unknown {
  return doc.getMap<unknown>('meta').get('id')
}

// ---------------------------------------------------------------------------
// Import

export interface ImportSummary {
  boards: number
  blobs: number
  /** Boards placed on Home. */
  addedToHome: number
  /** Boards skipped because their data was damaged or conflicted with a board on this device. */
  skipped: number
  /** Files whose content did not match their hash. */
  badBlobs: number
  /** First imported root board (to open after importing). */
  firstRootId: string | null
}

/** Finds a free spot on a board to the right of existing free cards. */
function freeSpot(doc: Y.Doc): { x: number; y: number } {
  let maxX = 0
  let minY = Infinity
  getCards(doc).forEach((m) => {
    if (!(m instanceof Y.Map) || isTrashed(m) || m.get('parent')) return
    const c = readCard(m)
    if (c.type === 'line') return
    maxX = Math.max(maxX, c.x + c.w)
    minY = Math.min(minY, c.y)
  })
  if (!Number.isFinite(minY)) return { x: 80, y: 80 }
  return { x: Math.round((maxX + 40) / 10) * 10, y: Math.round(minY / 10) * 10 }
}

export async function importBackup(file: Blob, onProgress?: (done: number, total: number) => void): Promise<ImportSummary> {
  if (file.size > BACKUP_LIMITS.fileBytes) throw new BackupError('The backup is too large to import.')
  const { manifest, updates, blobs } = unpackBackup(new Uint8Array(await file.arrayBuffer()))
  const summary: ImportSummary = { boards: 0, blobs: 0, addedToHome: 0, skipped: 0, badBlobs: 0, firstRootId: null }
  const roots = new Set(manifest.rootIds)
  const knownBefore = new Map(manifest.boards.map((b) => [b.id, getLibraryEntry(b.id)]))
  const imported = new Set<string>()
  const lib = useLibrary.getState()

  // Files first, so images are there when the boards appear.
  const mimes = new Map(manifest.blobs.map((b) => [b.hash, b.mime]))
  for (const [hash, bytes] of blobs) {
    const ok = await putVerifiedBlob(hash, new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimes.get(hash) || '' })).catch(() => false)
    if (ok) summary.blobs++
    else summary.badBlobs++
    // One file at a time: let each stored file's bytes be freed instead of holding all of them.
    blobs.delete(hash)
  }

  let done = 0
  for (const b of manifest.boards) {
    onProgress?.(done++, manifest.boards.length)
    const existing = knownBefore.get(b.id)
    // Same id with a different key is not the same board: never merge it.
    if (existing?.secret && existing.secret !== b.secret) {
      summary.skipped++
      continue
    }
    // Decode into a scratch doc first so a damaged update can never reach a real board.
    const scratch = new Y.Doc({ guid: b.id })
    let clean: Uint8Array
    try {
      Y.applyUpdate(scratch, updates.get(b.id)!)
      const metaId = getMetaId(scratch)
      if (metaId !== undefined && metaId !== b.id) throw new Error('board id mismatch')
      clean = Y.encodeStateAsUpdate(scratch)
    } catch {
      summary.skipped++
      continue
    } finally {
      scratch.destroy()
    }
    await docs.withDoc(b.id, (doc) => Y.applyUpdate(doc, clean, SYSTEM_ORIGIN))
    const isRoot = roots.has(b.id)
    lib.upsert({
      id: b.id,
      secret: b.secret,
      title: existing?.title && existing.title !== 'Untitled board' ? existing.title : b.title,
      parentId: existing?.parentId ?? (isRoot ? HOME_BOARD_ID : b.parentId),
    })
    imported.add(b.id)
    summary.boards++
  }
  onProgress?.(done, manifest.boards.length)

  // Top-level boards that this device cannot reach through a parent it still has go onto Home.
  const reachableBefore = new Set<string>()
  for (const id of manifest.rootIds) {
    const before = knownBefore.get(id)
    if (before?.parentId && before.parentId !== HOME_BOARD_ID && (await isReachableFromHome(id))) reachableBefore.add(id)
  }
  const user = getUser()
  await docs.withDoc(HOME_BOARD_ID, (home) => {
    const onHome = new Set<string>()
    getCards(home).forEach((m) => {
      if (m instanceof Y.Map && !isTrashed(m) && m.get('type') === 'board' && typeof m.get('boardId') === 'string') onHome.add(m.get('boardId') as string)
    })
    // One SYSTEM_ORIGIN transaction (createCard's own transactions join it): these cards are not a
    // canvas action, so Home's undo history must not track them (Ctrl+Z would make the boards vanish).
    home.transact(() => {
      for (const id of manifest.rootIds) {
        if (!imported.has(id)) continue
        summary.firstRootId ??= id
        if (onHome.has(id) || reachableBefore.has(id)) continue
        const b = manifest.boards.find((x) => x.id === id)!
        const at = freeSpot(home)
        const cardId = createCard(home, 'board', { boardId: id, secret: b.secret, title: b.title, x: at.x, y: at.y }, user.id)
        // Lands in Home's Unsorted drawer, to be placed by the person (x/y stay for older versions).
        moveToUnsorted(home, [cardId], user.id, SYSTEM_ORIGIN)
        onHome.add(id)
        summary.addedToHome++
      }
    }, SYSTEM_ORIGIN)
  })
  return summary
}

/** "NoemaBoard backup – Board name – 2026-10-22.noema" */
export function backupFileName(label: string, date = new Date()): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  return `${safeFileName(`${APP_NAME} backup - ${label} - ${day}`)}${BACKUP_EXTENSION}`
}

/** Removes characters that are not allowed in file names on Windows/macOS/Linux. */
export function safeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return cleaned || 'board'
}
