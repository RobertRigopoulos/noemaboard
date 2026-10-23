// @ts-check
/**
 * Persistent storage for the relay: SQLite (node:sqlite, WAL) for rooms, the encrypted update log
 * and snapshots; plain files for encrypted blobs (streamed, so large files never sit in memory).
 *
 * Layout inside DATA_DIR:
 *   relay.db (+ -wal, -shm)
 *   blobs/<roomId>/<sha256 of ciphertext>
 *   tmp/   (uploads in progress, renamed into blobs/ when verified)
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

/** @param {string | Uint8Array} v */
const sha256 = (v) => createHash('sha256').update(v).digest()

/**
 * @typedef {{ id: string, token_hash: Uint8Array, head: number, snap_seq: number, snap: Uint8Array | null,
 *   prev_snap_seq: number, log_bytes: number, snap_bytes: number, prev_snap_bytes: number, blob_bytes: number }} RoomRow
 */

export class QuotaError extends Error {}

export class RelayStore {
  /**
   * @param {{ dataDir: string, maxRoomBytes: number, maxRooms?: number }} opts
   */
  constructor(opts) {
    this.dataDir = path.resolve(opts.dataDir)
    this.maxRoomBytes = opts.maxRoomBytes
    this.maxRooms = opts.maxRooms ?? 0
    this.blobDir = path.join(this.dataDir, 'blobs')
    this.tmpDir = path.join(this.dataDir, 'tmp')
    fs.mkdirSync(this.blobDir, { recursive: true })
    fs.mkdirSync(this.tmpDir, { recursive: true })
    // Leftovers from uploads interrupted by a crash.
    for (const f of fs.readdirSync(this.tmpDir)) fs.rmSync(path.join(this.tmpDir, f), { force: true })

    this.db = new DatabaseSync(path.join(this.dataDir, 'relay.db'))
    this.db.exec(`
      pragma journal_mode = wal;
      pragma synchronous = normal;
      pragma busy_timeout = 5000;
      create table if not exists rooms (
        id text primary key,
        token_hash blob not null,
        head integer not null default 0,
        snap_seq integer not null default 0,
        snap blob,
        prev_snap_seq integer not null default 0,
        prev_snap blob,
        log_bytes integer not null default 0,
        snap_bytes integer not null default 0,
        prev_snap_bytes integer not null default 0,
        blob_bytes integer not null default 0,
        created_at integer not null,
        last_active integer not null
      );
      create table if not exists updates (
        room text not null,
        seq integer not null,
        data blob not null,
        primary key (room, seq)
      ) without rowid;
      create table if not exists blobs (
        room text not null,
        hash text not null,
        alias text,
        size integer not null,
        created_at integer not null,
        primary key (room, hash)
      ) without rowid;
      create unique index if not exists blobs_alias on blobs (room, alias) where alias is not null;
    `)
    const db = this.db
    this.q = {
      room: db.prepare(
        'select id, token_hash, head, snap_seq, prev_snap_seq, log_bytes, snap_bytes, prev_snap_bytes, blob_bytes from rooms where id = ?',
      ),
      snapshot: db.prepare('select snap from rooms where id = ?'),
      countRooms: db.prepare('select count(*) as n from rooms'),
      newRoom: db.prepare('insert into rooms (id, token_hash, created_at, last_active) values (?, ?, ?, ?)'),
      touch: db.prepare('update rooms set last_active = ? where id = ?'),
      bump: db.prepare('update rooms set head = head + 1, log_bytes = log_bytes + ? where id = ? returning head'),
      insertUpdate: db.prepare('insert into updates (room, seq, data) values (?, ?, ?)'),
      since: db.prepare('select seq, data from updates where room = ? and seq > ? order by seq'),
      setSnap: db.prepare(
        `update rooms set prev_snap = snap, prev_snap_seq = snap_seq, prev_snap_bytes = snap_bytes,
           snap = ?, snap_seq = ?, snap_bytes = ? where id = ?`,
      ),
      trim: db.prepare('delete from updates where room = ? and seq <= ?'),
      logBytes: db.prepare('select coalesce(sum(length(data)), 0) as n from updates where room = ?'),
      setLogBytes: db.prepare('update rooms set log_bytes = ? where id = ?'),
      blobByHash: db.prepare('select hash, size from blobs where room = ? and hash = ?'),
      blobByAlias: db.prepare('select hash, size from blobs where room = ? and alias = ?'),
      insertBlob: db.prepare('insert into blobs (room, hash, alias, size, created_at) values (?, ?, ?, ?, ?)'),
      addBlobBytes: db.prepare('update rooms set blob_bytes = blob_bytes + ? where id = ?'),
    }
    this.roomCount = Number(/** @type {any} */ (this.q.countRooms.get()).n)
  }

  /** @param {string} roomId @returns {RoomRow | undefined} */
  room(roomId) {
    return /** @type {RoomRow | undefined} */ (this.q.room.get(roomId))
  }

  /**
   * Checks a write token against the room's stored hash. The first token presented for an unknown
   * room claims it (trust on first use) when `create` is true.
   * @param {string} roomId
   * @param {string} token
   * @param {boolean} create
   * @returns {'ok' | 'unauthorized' | 'missing' | 'room_limit'}
   */
  authorize(roomId, token, create) {
    if (typeof token !== 'string' || token.length < 22 || token.length > 128) return 'unauthorized'
    const th = sha256(token)
    const r = this.room(roomId)
    if (!r) {
      if (!create) return 'missing'
      if (this.maxRooms > 0 && this.roomCount >= this.maxRooms) return 'room_limit'
      const now = Date.now()
      this.q.newRoom.run(roomId, th, now, now)
      this.roomCount++
      return 'ok'
    }
    const stored = Buffer.from(r.token_hash)
    if (stored.length !== th.length || !timingSafeEqual(stored, th)) return 'unauthorized'
    return 'ok'
  }

  /** @param {string} roomId */
  touch(roomId) {
    this.q.touch.run(Date.now(), roomId)
  }

  /** @param {RoomRow} r */
  usedBytes(r) {
    return r.log_bytes + r.snap_bytes + r.prev_snap_bytes + r.blob_bytes
  }

  /**
   * Everything a client needs to catch up from `since`. A `since` beyond the head means the room
   * was reset (or this is a different server), so the client gets the full state.
   * @param {string} roomId
   * @param {number} since
   */
  welcome(roomId, since) {
    const r = this.room(roomId)
    if (!r) throw new Error('unknown room')
    const from = since > r.head ? 0 : since
    let snapshot = null
    if (r.snap_seq > 0 && from < r.snap_seq) {
      const row = /** @type {{ snap: Uint8Array | null } | undefined} */ (this.q.snapshot.get(roomId))
      snapshot = row?.snap ?? null
    }
    const rows = /** @type {{ seq: number, data: Uint8Array }[]} */ (this.q.since.all(roomId, Math.max(from, r.snap_seq)))
    return { snapSeq: r.snap_seq, head: r.head, logBytes: r.log_bytes, snapshot, updates: rows }
  }

  /**
   * Appends an encrypted update and returns its sequence number.
   * @param {string} roomId
   * @param {Uint8Array} data
   */
  append(roomId, data) {
    const r = this.room(roomId)
    if (!r) throw new Error('unknown room')
    if (this.usedBytes(r) + data.length > this.maxRoomBytes) throw new QuotaError('room storage quota exceeded')
    this.db.exec('begin immediate')
    try {
      const { head } = /** @type {{ head: number }} */ (this.q.bump.get(data.length, roomId))
      this.q.insertUpdate.run(roomId, head, data)
      this.db.exec('commit')
      return head
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  /**
   * Replaces the log up to `upto` with an encrypted snapshot. Only moves forward; the previous
   * snapshot generation is kept as a fallback for operators.
   * @param {string} roomId
   * @param {number} upto
   * @param {Uint8Array} snapshot
   * @returns {{ ok: boolean, snapSeq: number, logBytes: number }}
   */
  compact(roomId, upto, snapshot) {
    const r = this.room(roomId)
    if (!r) throw new Error('unknown room')
    if (upto <= r.snap_seq || upto > r.head || snapshot.length === 0) {
      return { ok: false, snapSeq: r.snap_seq, logBytes: r.log_bytes }
    }
    this.db.exec('begin immediate')
    try {
      this.q.setSnap.run(snapshot, upto, snapshot.length, roomId)
      this.q.trim.run(roomId, upto)
      const { n } = /** @type {{ n: number }} */ (this.q.logBytes.get(roomId))
      this.q.setLogBytes.run(Number(n), roomId)
      this.db.exec('commit')
      return { ok: true, snapSeq: upto, logBytes: Number(n) }
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
  }

  // -------------------------------------------------------------------------
  // Blobs

  /** @param {string} roomId @param {string} hash */
  blobPath(roomId, hash) {
    return path.join(this.blobDir, roomId, hash)
  }

  /**
   * Looks a blob up by the SHA-256 of its ciphertext or by its client-chosen alias.
   * @param {string} roomId
   * @param {string} key
   * @returns {{ hash: string, size: number, path: string } | null}
   */
  findBlob(roomId, key) {
    const row = /** @type {{ hash: string, size: number } | undefined} */ (
      this.q.blobByHash.get(roomId, key) ?? this.q.blobByAlias.get(roomId, key)
    )
    if (!row) return null
    const p = this.blobPath(roomId, row.hash)
    if (!fs.existsSync(p)) return null
    return { hash: row.hash, size: Number(row.size), path: p }
  }

  /** Remaining quota for blobs in a room. @param {string} roomId */
  freeBytes(roomId) {
    const r = this.room(roomId)
    return r ? Math.max(0, this.maxRoomBytes - this.usedBytes(r)) : 0
  }

  newTempPath() {
    return path.join(this.tmpDir, `${Date.now()}-${randomBytes(8).toString('hex')}`)
  }

  /**
   * Moves a verified upload into place.
   * @param {string} roomId
   * @param {string} hash
   * @param {string | null} alias
   * @param {number} size
   * @param {string} tmpPath
   * @returns {'created' | 'exists' | 'quota'}
   */
  commitBlob(roomId, hash, alias, size, tmpPath) {
    const existing = this.q.blobByHash.get(roomId, hash) ?? (alias ? this.q.blobByAlias.get(roomId, alias) : undefined)
    if (existing) {
      fs.rmSync(tmpPath, { force: true })
      return 'exists'
    }
    if (size > this.freeBytes(roomId)) {
      fs.rmSync(tmpPath, { force: true })
      return 'quota'
    }
    fs.mkdirSync(path.join(this.blobDir, roomId), { recursive: true })
    fs.renameSync(tmpPath, this.blobPath(roomId, hash))
    this.db.exec('begin immediate')
    try {
      this.q.insertBlob.run(roomId, hash, alias, size, Date.now())
      this.q.addBlobBytes.run(size, roomId)
      this.db.exec('commit')
    } catch (e) {
      this.db.exec('rollback')
      throw e
    }
    return 'created'
  }

  close() {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }
}
