#!/usr/bin/env node
// @ts-check
/**
 * CLI entry point: `npx noema-relay` or `node bin/noema-relay.js`.
 * Configuration comes from environment variables (see README.md) or --flags of the same name.
 */

// node:sqlite prints an ExperimentalWarning on some Node versions; it is stable enough for us and
// the warning only confuses operators. Other warnings still show.
const emitWarning = process.emitWarning
process.emitWarning = /** @type {typeof process.emitWarning} */ (
  function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : warning?.message
    const type = typeof rest[0] === 'string' ? rest[0] : /** @type {any} */ (rest[0])?.type
    if ((type === 'ExperimentalWarning' || /** @type {any} */ (warning)?.name === 'ExperimentalWarning') && /SQLite/i.test(String(text))) return
    return emitWarning.call(process, /** @type {any} */ (warning), .../** @type {any[]} */ (rest))
  }
)

const HELP = `Noema relay - optional always-on, end-to-end encrypted sync server

Usage: noema-relay [--port 8787] [--data-dir ./data] [--access-key KEY] ...

Environment variables (flags take precedence):
  PORT                  TCP port (default 8787)
  HOST                  Interface to bind (default: all)
  DATA_DIR              Database + files directory (default ./data)
  ACCESS_KEY            Optional key every client must present (recommended on public servers)
  MAX_BLOB_MB           Largest file upload in MB (default 50)
  MAX_ROOM_MB           Storage quota per board in MB (default 1024)
  MAX_MESSAGE_MB        Largest single sync message in MB (default 32)
  MAX_ROOMS             Maximum number of boards, 0 = unlimited (default 0)
  MAX_CONN_PER_IP       Concurrent connections per IP or IPv6 /64 (default 4096)
  MSG_PER_SEC           WebSocket messages per second per IP (default 2000)
  HTTP_PER_SEC          HTTP requests + WebSocket handshakes per second per IP (default 200)
  TRUST_PROXY           Number of reverse proxies in front of the relay (1 = one proxy, e.g.
                        Caddy or nginx): clients are identified by the X-Forwarded-For entry
                        that many places from the right. Leave unset when clients connect directly.
`

/** @param {string} name */
function flag(name) {
  const args = process.argv.slice(2)
  const i = args.indexOf(`--${name}`)
  if (i >= 0 && i + 1 < args.length) return args[i + 1]
  const eq = args.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : undefined
}

/** @param {string} name @param {string} env */
function value(name, env) {
  return flag(name) ?? process.env[env]
}

/** @param {string | undefined} v */
function num(v) {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) {
    console.error(`Invalid number: ${v}`)
    process.exit(2)
  }
  return n
}

/** TRUST_PROXY: true/yes = one proxy, a number = that many proxies, empty/0/false = none. @param {string | undefined} v */
function proxyHops(v) {
  if (v === undefined || v === '' || /^(0|false|no)$/i.test(v)) return 0
  if (/^(true|yes)$/i.test(v)) return 1
  const n = num(v) ?? 0
  if (!Number.isInteger(n)) {
    console.error(`Invalid TRUST_PROXY: ${v} (use the number of proxies, e.g. 1)`)
    process.exit(2)
  }
  return n
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const major = Number(process.versions.node.split('.')[0])
if (major < 22) {
  console.error(`Noema relay needs Node.js 22.13 or newer (you have ${process.versions.node}).`)
  process.exit(1)
}

const { createRelayServer } = await import('../src/server.js')

const relay = createRelayServer({
  port: num(value('port', 'PORT')) ?? 8787,
  host: value('host', 'HOST'),
  dataDir: value('data-dir', 'DATA_DIR') ?? './data',
  accessKey: value('access-key', 'ACCESS_KEY') ?? '',
  maxBlobMB: num(value('max-blob-mb', 'MAX_BLOB_MB')),
  maxRoomMB: num(value('max-room-mb', 'MAX_ROOM_MB')),
  maxMessageMB: num(value('max-message-mb', 'MAX_MESSAGE_MB')),
  maxRooms: num(value('max-rooms', 'MAX_ROOMS')),
  maxConnectionsPerIp: num(value('max-conn-per-ip', 'MAX_CONN_PER_IP')),
  messagesPerSecond: num(value('msg-per-sec', 'MSG_PER_SEC')),
  httpPerSecond: num(value('http-per-sec', 'HTTP_PER_SEC')),
  trustProxy: proxyHops(value('trust-proxy', 'TRUST_PROXY')),
})

try {
  const { port } = await relay.listen()
  // Machine-readable line used by tests and supervisors.
  console.log(`RELAY_PORT=${port}`)
} catch (e) {
  console.error(`Could not start the relay: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

let stopping = false
async function shutdown(/** @type {string} */ signal) {
  if (stopping) return
  stopping = true
  console.log(`${signal} received, shutting down...`)
  const force = setTimeout(() => process.exit(1), 10_000)
  force.unref()
  await relay.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
