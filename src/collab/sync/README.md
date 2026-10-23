# Peer-to-peer sync engine

Keeps every board shared with teammates in sync directly between their devices (WebRTC through
[Trystero](https://github.com/dmotz/trystero)), and keeps tabs/windows of one profile in sync
through a `BroadcastChannel`. No server stores or relays board content.

| File           | Role                                                                           |
| -------------- | ------------------------------------------------------------------------------ |
| `index.ts`     | `startSync()`: wires the engine to the app singletons, settings and watchdogs  |
| `engine.ts`    | `SyncEngine`: rooms, scope (access control), seeding, routing, presence, blobs |
| `protocol.ts`  | Wire format (pure, unit tested)                                                |
| `scope.ts`     | Board links, scope walk, link-change detection                                 |
| `transport.ts` | `RoomTransport` interface every network implements                             |
| `trystero.ts`  | WebRTC transport (Nostr + BitTorrent signaling), loaded lazily                 |
| `broadcast.ts` | Same-device transport (`BroadcastChannel`)                                     |
| `memory.ts`    | In-memory network for tests                                                    |
| `network.ts`   | Default relays/trackers, settings validation, RTC config                       |
| `status.ts`    | `useSyncStatus` store and problem messages for the UI                          |
| `settings.ts`  | `useNetworkSettings` (TURN servers, extra relays, P2P on/off)                  |

## Rooms and scope

- One room per library entry with `shared: true`. `roomId = deriveRoomId(secret)` is the public
  rendezvous id; `password = deriveRoomPassword(secret)` encrypts signaling. The secret never
  leaves the device.
- **Scope** of a room = its root board plus every board reachable through board cards
  (`type: 'board'`, `boardId`, `secret`) in local docs. All of them are multiplexed over the
  room. Scope is the access control: a peer may only read or write docs in the room's scope;
  everything else is dropped silently.
- A board card is only followed when its `secret` matches the secret we already know for that
  board (or we know none). A member of a nested board therefore cannot pull the parent (or any
  unrelated board of ours) into their room by naming its id.
- A card naming an unknown board with a secret that belongs to *another* board we know is not
  followed either (and never opens a room): two boards with one secret would share one room.
  When two shared library entries still have the same secret, only one gets the room: the one
  whose secret came from creating the board or from an invite (`trusted`) rather than from a
  card; the other gets it once the first is gone.
- Home (`home`) is never in a P2P scope.
- Docs in any scope are **seeded**: kept open (`docs.open`) so they stay synced and available to
  teammates even when not on screen. Released when they leave every scope.
- A seeded doc whose `meta.shared` is true is marked shared in the library, so this device also
  joins that board's own room and serves people invited directly to the nested board.
- At most 1000 boards per scope, at most 200 child boards per board (boards we already know
  first, so fake board cards cannot crowd real ones out) and 30 peers per room (extra peers wait
  for a free slot).
- A room that cannot be joined (e.g. the lazily loaded WebRTC code is gone after a new deploy) is
  retried with backoff (2 s doubling to 60 s), and the `start` problem tells the user to reload.

## Wire format

One binary Trystero action `y`. Every message:

```
[varUint type][varString docId][payload]
```

| type | name      | payload                                                             |
| ---- | --------- | ------------------------------------------------------------------- |
| 0    | SYNC      | y-protocols sync message (SyncStep1 / SyncStep2 / Update)           |
| 1    | AWARENESS | varUint8Array: y-protocols awareness update for board `docId`       |
| 2    | WANT      | none. "I have/opened docId": answer with SyncStep1 (+ your presence) |
| 3    | HELLO     | varString JSON `{ v: 1, m: 1, app: "0.1.0" }`, `docId` is empty     |
| 4    | PEERS     | varUint n + n × varString: peers the sender exchanges data with in this room, `docId` is empty (minor 1) |
| 5    | AWARENESS_RELAY | like AWARENESS, but states of peers the sender relays for, not its own clients (minor 1) |

Rules for receivers:

- Unknown types are ignored (newer minor versions may add some). Malformed messages are dropped.
- Messages are capped at 64 MB (awareness 256 KB, HELLO 4 KB, docId 64 chars).
- `docId` must be a valid board id inside the room's scope, and the doc must be loaded; messages
  for a doc that is still loading from disk are dropped (it announces itself once loaded).
- HELLO with a different `v` (major) → the peer is ignored and the UI says to update.
- A peer that keeps sending invalid data is ignored after 50 errors.

## Flow

1. **Peer joins** → send HELLO, SyncStep1 for every in-scope doc we hold, and our presence for
   open boards. Both sides do this, so both pull what they miss.
2. **SyncStep1 received** → reply SyncStep2 to that peer.
3. **Local edit** (any transaction origin that is not a remote one and not y-indexeddb replay)
   → Update to every peer sharing the doc, once per peer, plus other tabs.
4. **Remote edit** → applied with origin `RemoteOrigin { room, peerId }` (never `LOCAL_ORIGIN`,
   so it is not undoable). Relayed to other tabs, to peers of other rooms that are not in the
   source room (bridges people who share a nested board through different rooms), and to peers
   of the source room that are **not connected to the sender** according to the PEERS lists
   (partial mesh: NATs without TURN, full rooms). Peers that never sent a list (older versions)
   count as connected to everyone. Duplicates are harmless: a Yjs update that changes nothing
   emits no new update, so relaying stops by itself. When a PEERS list shows two peers newly
   apart, we resync both through us (SyncStep1 + WANT).
   Edits from another tab of ours are sent by that tab; we only relay them to peers whose list
   does not contain that tab's P2P id.
5. **Doc enters scope** (new board card, or it finished loading) → SyncStep1 + WANT to the room.
6. **Anti-entropy**: SyncStep1 for every doc to every peer every ~60 s (±20 % jitter), when the
   network comes back and when the tab becomes visible. Rooms left empty are rejoined on `online`.

## Presence (awareness)

`presence.ts` creates one `Awareness` per open board. Only our own client state is sent,
throttled to one message per 50 ms per board; closing a board sends the removal immediately.
Opening a board sends our state plus WANT, answered with each peer's state. Remote states for
boards not open here are not shown (but are still relayed). The engine remembers which client
ids each peer spoke for and removes them (and their clocks) when the peer leaves every room.

Presence is self-asserted, but a peer cannot speak for our own client (such entries are dropped
before applying), nor push a client that another connected peer speaks for directly more than a
few clocks ahead (which would freeze the real presence). New entries (higher clock than seen) are
relayed as AWARENESS_RELAY to peers of the room that are not connected to the sender.

## Blobs

Trystero request action `blob`: request = 64-char hex SHA-256; reply = `null` or
`[varUint 1][varString mime][bytes]` (sent as a Blob, so big files stream from disk).
A peer only gets files that some board in its room's scope refers to (any top-level field of a
card or of the board meta holding a SHA-256 hex string, except `secret` and `boardId`; see
`model/blobRefs.ts`), never other files on this device. Four reads per peer run at a time; more
requests wait for a slot instead of being answered "don't have it".
The requester asks peers of rooms covering the board in turn (for an unknown board: rooms whose
boards refer to the file; never unrelated rooms), keeps only bytes whose SHA-256 matches, gives
up on a peer after 120 s without progress, and downgrades any peer-provided mime type that could
render as a page (HTML, XML, JS…) to `application/octet-stream`. `maxReceiveBytes` ≥
`MAX_BLOB_BYTES`.

## Same device

`BroadcastChannel(STORAGE_PREFIX + 'sync')` carries the same messages between tabs of one
profile for **every** loaded doc (Home included) plus presence. Tabs announce themselves
(`hello`/`here`), heartbeat every 10 s, say `bye` on `pagehide` and are dropped after 75 s of
silence. Edits that came from another tab are not re-sent to P2P peers (that tab sends its own).

## Transports

`RoomTransport` is the only network interface the engine uses:
`connect(handlers)`, `send(bytes, targets)`, `requestBlob(hash, peer)`, `leave()`.

The Trystero transport joins each room through **both** the Nostr strategy (`trystero`) and the
BitTorrent tracker strategy (`@trystero-p2p/torrent`). The same peer has the same `selfId` in
both; peers are merged by id and each send goes through the connection that came up first.
Relay lists are fixed for the whole app (defaults + user extras): Trystero initialises a
strategy's relays once, so a change of network settings leaves every room and joins again.
Handlers are cleared before `room.leave()`.

DTLS encrypts data channels end to end and the room password encrypts signaling, so there is no
extra application-level crypto on this path.

## Status

`useSyncStatus.boards[boardId]` exists for every board in a P2P scope: `peers` (distinct
devices across rooms covering it), `active` (a room for it is joined) and `lastSyncAt`
(second resolution). `problem` shows the most important of: different app version, tab needs
reload, no WebRTC, no signaling relay reachable for 25 s, teammates found but not connectable
(suggests TURN), room full.

## Tests

`npx vitest run src/collab/sync` runs engines against `MemoryHub` with separate doc registries,
libraries and presence per simulated device (see `testkit.ts`).
