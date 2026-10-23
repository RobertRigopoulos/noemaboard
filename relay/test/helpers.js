// @ts-check
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Decoder, MSG, Reassembler, decodeFrame, encodeHello, splitFrame } from '../src/protocol.js'

const here = path.dirname(fileURLToPath(import.meta.url))
export const BIN = path.join(here, '..', 'bin', 'noema-relay.js')

export function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'noema-relay-test-'))
}

export const randomRoom = () => randomBytes(16).toString('base64url')
export const randomToken = () => randomBytes(32).toString('base64url')

/**
 * Spawns the CLI on a random port with a temporary data directory.
 * @param {Record<string, string>} [env]
 * @param {string} [dataDir]
 */
export async function spawnRelay(env = {}, dataDir = tempDir()) {
  const proc = spawn(process.execPath, [BIN], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  proc.stderr.on('data', (d) => (stderr += String(d)))
  const port = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${stderr}`)), 10_000)
    proc.stdout.on('data', (d) => {
      out += String(d)
      const m = out.match(/RELAY_PORT=(\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    proc.once('exit', (code) => reject(new Error(`relay exited with ${code}: ${stderr}`)))
  })
  return {
    proc,
    port,
    dataDir,
    http: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
    get stderr() {
      return stderr
    },
    async stop() {
      if (proc.exitCode !== null) return
      const exited = new Promise((r) => proc.once('exit', r))
      proc.kill()
      await exited
    },
  }
}

/** Minimal protocol client for tests. */
export class TestClient {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws
    /** @type {Record<string, any>[]} */
    this.frames = []
    /** @type {{ match: (f: Record<string, any>) => boolean, resolve: (f: Record<string, any>) => void }[]} */
    this.waiters = []
    this.parts = new Reassembler(256 * 1024 * 1024)
    this.transfer = 0
    /** @type {string[]} */
    this.texts = []
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    ws.on('message', (data, isBinary) => {
      const buf = /** @type {Buffer} */ (data)
      if (!isBinary) {
        this.texts.push(buf.toString())
        return
      }
      const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
      let frame = bytes
      if (bytes[0] === MSG.PART) {
        const d = new Decoder(bytes)
        d.u8()
        const full = this.parts.push(d)
        if (!full) return
        frame = full
      }
      const f = decodeFrame(frame)
      const i = this.waiters.findIndex((w) => w.match(f))
      if (i >= 0) this.waiters.splice(i, 1)[0].resolve(f)
      else this.frames.push(f)
    })
    ws.on('error', () => {})
  }

  /** @param {string} url */
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const c = new TestClient(ws)
      ws.once('open', () => resolve(c))
      ws.once('error', reject)
      ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    })
  }

  /**
   * Opens a socket for a room and completes the HELLO handshake.
   * @param {string} base ws://host:port
   * @param {{ roomId: string, token: string, accessKey?: string, since?: number, flags?: number }} hello
   * @returns {Promise<{ client: TestClient, welcome: Record<string, any> }>}
   */
  static async join(base, hello) {
    const client = /** @type {TestClient} */ (await TestClient.open(`${base}/ws/${hello.roomId}`))
    client.send(encodeHello(hello))
    const welcome = await client.next(MSG.WELCOME)
    return { client, welcome }
  }

  /** @param {Uint8Array} frame */
  send(frame) {
    for (const f of splitFrame(frame, ++this.transfer)) this.ws.send(f)
  }

  /**
   * Resolves with the next frame of `type` (and matching `pred`), waiting up to `ms`.
   * @param {number} type
   * @param {(f: Record<string, any>) => boolean} [pred]
   * @param {number} [ms]
   * @returns {Promise<Record<string, any>>}
   */
  next(type, pred = () => true, ms = 5000) {
    const match = (/** @type {Record<string, any>} */ f) => f.type === type && pred(f)
    const i = this.frames.findIndex(match)
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0])
    return new Promise((resolve, reject) => {
      const w = { match, resolve: (/** @type {Record<string, any>} */ f) => (clearTimeout(t), resolve(f)) }
      const t = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`timed out waiting for frame type ${type}`))
      }, ms)
      this.waiters.push(w)
    })
  }

  /** True if a frame of `type` arrives within `ms`. */
  async receives(/** @type {number} */ type, ms = 300) {
    try {
      await this.next(type, () => true, ms)
      return true
    } catch {
      return false
    }
  }

  close() {
    this.ws.close()
    return this.closed
  }
}

export const bytes = (/** @type {number} */ n, fill = 7) => new Uint8Array(n).fill(fill)
