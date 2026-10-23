/**
 * A tiny fake of the Durable Objects runtime, enough to run relay/cloudflare/src/index.ts under Node
 * for logic tests: SQL storage on node:sqlite, hibernatable WebSockets as plain objects.
 * Requires Node >= 22.18 (TypeScript type stripping) — no Cloudflare tooling needed.
 */
import { registerHooks } from 'node:module'
import { timingSafeEqual } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: new URL('./fake-workers.mjs', import.meta.url).href, shortCircuit: true }
    if (specifier.startsWith('.') && context.parentURL?.endsWith('.ts') && !/\.[cm]?[jt]s$/.test(specifier)) {
      return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  },
})

if (!crypto.subtle.timingSafeEqual) {
  crypto.subtle.timingSafeEqual = (a, b) =>
    timingSafeEqual(Buffer.from(a.buffer ?? a, a.byteOffset ?? 0, a.byteLength), Buffer.from(b.buffer ?? b, b.byteOffset ?? 0, b.byteLength))
}
globalThis.WebSocketRequestResponsePair ??= class {
  constructor(request, response) {
    this.request = request
    this.response = response
  }
}

const toParam = (v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)

/** SqlStorage-like wrapper around node:sqlite. */
export function fakeSql(db) {
  return {
    exec(query, ...bindings) {
      if (!bindings.length && query.split(';').filter((s) => s.trim()).length > 1) {
        db.exec(query)
        return cursor([])
      }
      const stmt = db.prepare(query)
      const rows = stmt.columns().length ? stmt.all(...bindings.map(toParam)) : (stmt.run(...bindings.map(toParam)), [])
      return cursor(rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.slice().buffer : v]))))
    },
  }
}

function cursor(rows) {
  return {
    toArray: () => rows,
    one: () => {
      if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`)
      return rows[0]
    },
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  }
}

export class FakeSocket {
  readyState = 1
  sent = []
  closed = null
  #att = null
  send(data) {
    if (this.readyState !== 1) throw new Error('closed')
    this.sent.push(data instanceof Uint8Array ? data.slice() : data)
  }
  close(code, reason) {
    if (this.closed) return
    this.readyState = 3
    this.closed = { code, reason }
  }
  serializeAttachment(v) {
    this.#att = structuredClone(v)
  }
  deserializeAttachment() {
    return structuredClone(this.#att)
  }
}

/** DurableObjectState-like context sharing one database across "wake-ups". */
export function fakeCtx(db = new DatabaseSync(':memory:')) {
  const sockets = []
  return {
    db,
    sockets,
    storage: {
      sql: fakeSql(db),
      transactionSync(fn) {
        db.exec('begin')
        try {
          const r = fn()
          db.exec('commit')
          return r
        } catch (e) {
          db.exec('rollback')
          throw e
        }
      },
    },
    acceptWebSocket(ws) {
      sockets.push(ws)
    },
    getWebSockets() {
      return sockets.filter((s) => s.readyState === 1)
    },
    setWebSocketAutoResponse() {},
  }
}
