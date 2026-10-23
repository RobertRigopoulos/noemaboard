# NoemaBoard relay

An **optional**, self-hostable sync server for [NoemaBoard](../README.md) boards. NoemaBoard works
peer-to-peer without any server; a relay adds two things:

- **Always-on availability**: board changes, files and snapshots wait on the relay, so a teammate
  who opens a board while everyone else is offline still gets the latest version.
- **Strict networks**: everyone talks to the relay over a normal HTTPS/WebSocket connection, which
  works where direct peer-to-peer connections are blocked.

The relay is **blind**: everything it stores and forwards is end-to-end encrypted (AES-256-GCM)
with keys derived from board secrets it never sees. It has no Yjs dependency and cannot read,
search or modify boards. See [docs/RELAY.md](../docs/RELAY.md) for the security model and for
setting a relay on a board.

- Zero native dependencies: Node.js 22.13+ (built-in `node:sqlite`) and [`ws`](https://github.com/websockets/ws).
- One small SQLite database plus a folder of encrypted files.
- Or deploy the same protocol to the Cloudflare Workers free plan (see below).

## Run it

```sh
npx noema-relay                      # from npm, once published
# or from this folder:
npm install --omit=dev
npm start                                # listens on :8787, stores data in ./data
```

Check it: `curl http://localhost:8787/healthz`.

Then, in NoemaBoard, open a board → **Share** → **Advanced** → **Sync server**, enter the address
(for example `wss://relay.example.com`) and press **Test**. Everyone on the board (and on every
board nested in it) then syncs through it automatically.

Browsers only allow secure connections from the web app (`https://`), so a relay used by people in
the browser must be reachable over `wss://`/`https://` (put it behind a TLS proxy such as Caddy, or
use Cloudflare / Tailscale below). The desktop app can also use plain `ws://` on a local network
(for example `ws://192.168.1.5:8787`); everything it sends is end-to-end encrypted either way.

### Configuration

Environment variables (or `--flags` of the same name, e.g. `--port 9000 --data-dir /srv/relay`):

| Variable          | Default  | Meaning                                                                 |
| ----------------- | -------- | ----------------------------------------------------------------------- |
| `PORT`            | `8787`   | TCP port                                                                |
| `HOST`            | all      | Interface to bind, e.g. `127.0.0.1` behind a reverse proxy              |
| `DATA_DIR`        | `./data` | Database and encrypted files                                            |
| `ACCESS_KEY`      | (none)   | Key every client must present. **Recommended for public servers.**      |
| `MAX_BLOB_MB`     | `50`     | Largest single file                                                     |
| `MAX_ROOM_MB`     | `1024`   | Storage quota per board (changes + snapshots + files)                  |
| `MAX_MESSAGE_MB`  | `32`     | Largest single sync message (see below)                                 |
| `MAX_ROOMS`       | `0`      | Maximum number of boards (0 = unlimited)                                |
| `MAX_CONN_PER_IP` | `4096`   | Concurrent connections per client IP or IPv6 /64 (see below)           |
| `MSG_PER_SEC`     | `2000`   | WebSocket messages per second per IP (burst 4×)                         |
| `HTTP_PER_SEC`    | `200`    | HTTP requests and WebSocket handshakes per second per IP (burst 4×)    |
| `TRUST_PROXY`     | `0`      | Number of reverse proxies in front of the relay (see below)            |

**Per-IP limits cover a whole office.** Everyone behind one NAT address (an office, a school,
a mobile carrier) shares the per-IP limits, and each person's app keeps one connection per board
it syncs: every board open in a window or tab plus up to 16 recently opened ones (each nested
board is its own board), and boards with changes the relay has not confirmed yet. The defaults
leave room for large teams; lower them only if you know who connects. IPv6 clients are counted
per /64 network.

**`TRUST_PROXY`** is the number of reverse proxies between clients and the relay. Leave it unset
when clients connect directly. Behind one proxy (Caddy, nginx, a load balancer) set `1`: the
client is identified by the last `X-Forwarded-For` entry, the one the proxy added. Entries
further left were sent by the client and are ignored. With two proxies in a chain set `2`.
Only set it when the relay is reachable through the proxy alone (e.g. `HOST=127.0.0.1`).

**`MAX_MESSAGE_MB`** limits one sync message. The relay announces it to the app, which splits
larger changes into several messages. A board snapshot (used to compact the change log) is a
single message, so boards whose whole content is larger than this are not compacted. A
single item larger than the limit (for example one enormous pasted text) stays on the device that
made it, and the app shows an error until the limit is raised.

With an access key, people add it to the relay address: `wss://relay.example.com/?key=YOUR_KEY`.
The address (with the key) is stored on the board, so everyone invited to the board can use the
relay; clients send the key in the handshake, never in a URL the relay logs. Without a key, anyone
who knows your relay's address can store (encrypted) data on it.

### Docker

```sh
docker build -t noema-relay .
docker run -d --name noema-relay --restart unless-stopped \
  -p 8787:8787 -v noema-relay:/data -e ACCESS_KEY=change-me noema-relay
```

The image runs as the unprivileged `node` user, keeps all state in the `/data` volume and has a
health check. Stopping the container (`SIGTERM`) closes connections politely and flushes the
database.

### HTTPS with Caddy (any Linux server)

```sh
# relay listens on localhost only; Caddy gets a free certificate and terminates TLS
HOST=127.0.0.1 TRUST_PROXY=1 ACCESS_KEY=change-me npx noema-relay &
caddy reverse-proxy --from relay.example.com --to 127.0.0.1:8787
```

The relay also works under a path prefix (`https://example.com/relay` → `/relay/ws/...`).

### Embedding (desktop app, tests)

```js
import { createRelayServer } from 'noema-relay'

const relay = createRelayServer({ port: 8787, dataDir: '/path/to/data', accessKey: '' })
const { port } = await relay.listen()
// ...
await relay.close()
```

## Deploy to Cloudflare (free plan)

`cloudflare/` contains the same relay for Cloudflare Workers with SQLite-backed Durable Objects:
one object per board (WebSocket Hibernation API, so idle connections cost nothing) and one per
board for files (stored in ≤ 1.5 MB rows). No R2, KV, alarms or paid features.

```sh
cd cloudflare
npm install
npx wrangler login
npx wrangler deploy                      # prints https://noema-relay.<you>.workers.dev
npx wrangler secret put ACCESS_KEY       # optional but recommended
```

Use `wss://noema-relay.<you>.workers.dev` (plus `/?key=...` if you set a key) as the relay
address. Limits are in `wrangler.jsonc` (`MAX_BLOB_MB` 25, `MAX_ROOM_MB` 512, `MAX_MESSAGE_MB` 16).

**Capacity on the free plan** (daily, per Cloudflare account; check Cloudflare's current pricing):

- 100,000 SQLite rows written: about one row per saved batch of changes (each person sends at
  most one batch per second while editing). That is roughly 30 people each editing actively for
  about an hour every day.
- 13,000 GB-s of Durable Object time: a board's room is "awake" while people have it open and
  presence (cursors) is flowing, about 28 room-hours per day in total.
- 100,000 requests: one per connection plus one per 20 incoming messages.
- 5 GB of storage in total.

In practice this suits teams of about **10–40 people** with typical use. Heavier use needs the
Workers Paid plan or the Node relay. If a daily limit is reached, the relay stops answering until
the next day and NoemaBoard keeps syncing peer-to-peer.

Tests for the adapter's logic run under plain Node with a fake runtime: `npm test` (in
`cloudflare/`) or `npm run test:cloudflare` (here). Type-check with `npm run typecheck` after
`npm install`.

## Protocol

Binary WebSocket frames, `[u8 type][fields]`, lib0-style varUints. All payloads are ciphertext.

| Type | Name      | Direction | Fields                                                                          |
| ---- | --------- | --------- | ------------------------------------------------------------------------------- |
| 1    | HELLO     | c → s     | version, flags (1 = probe), roomId, token, accessKey, since                     |
| 2    | WELCOME   | s → c     | snapSeq, head, logBytes, peers, snapshot (empty = none), n × (seq, data), maxMessage (optional trailing field) |
| 3    | PUSH      | c → s     | clientMsgId, data                                                               |
| 4    | ACK       | s → c     | clientMsgId, seq                                                                |
| 5    | UPD       | s → c     | seq, data (to everyone else in the room)                                        |
| 6    | EPH       | both      | data (presence; broadcast, never stored)                                        |
| 7    | COMPACT   | c → s     | upto, snapshot (accepted only if `upto > snapSeq`; log rows ≤ upto are deleted) |
| 8    | COMPACTED | s → c     | snapSeq, logBytes                                                               |
| 9    | ERR       | s → c     | code, ref, message                                                              |
| 10   | PART      | both      | transferId, index, total, chunk (frames over 1 MiB are split into 512 KiB parts) |
| 11   | PEERS     | s → c     | number of other connections in the room                                         |

- WebSocket: `/ws/<roomId>`; text `ping` is answered with `pong` (keepalive).
- Rooms are claimed on first use: the relay stores SHA-256 of the board's write token and compares
  later tokens in constant time. Wrong token → close code 4401; wrong access key → 4403;
  bad frame → 4400; message over the limit → 4413 (the app then sends smaller pieces);
  rate limited → 4429. Nothing but a small HELLO is accepted before the handshake completes.
- Files: `PUT /blob/<roomId>/<sha256 of ciphertext>` with `Authorization: Bearer <token>` and
  `X-Blob-Alias` (a keyed hash of the file's real hash, so members can find it again); the relay
  re-hashes the body and rejects mismatches. `GET`/`HEAD /blob/<roomId>/<hash or alias>`.
  Responses are `immutable` and CORS-enabled. `GET /healthz` reports version and limits
  (`maxBlobMB`, `maxRoomMB`, `maxMessageMB`).

## Development

```sh
npm install
npm test               # integration tests: spawns the relay on a random port with a temp DATA_DIR
npm run typecheck      # JSDoc-typed JavaScript checked by TypeScript
```
