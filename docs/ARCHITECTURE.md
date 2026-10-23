# Architecture

NoemaBoard is a local-first visual board app (infinite canvas with notes, images, links, to-dos,
columns, nested boards, lines, comments, sketches) with real-time collaboration. Teammates' apps
talk to each other directly (WebRTC); free public relays are only used so peers can find each
other. Shared boards can also sync through an end-to-end encrypted relay (the "sync service"),
which keeps them available while nobody else is online and only stores encrypted copies it can't
read. Builds with `VITE_DEFAULT_RELAY` set, such as the hosted web app and release builds, have one
built in for shared boards (`src/config.ts`), and any board can name its own.

```
┌──────────────── one app instance (browser tab or desktop app) ────────────────┐
│ React UI  ── board/ (canvas, CardShell, interactions) ── cards/ (card bodies)  │
│     │                                                                         │
│ model/board.ts  (pure Y.Doc operations, LOCAL_ORIGIN transactions)            │
│     │                                                                         │
│ collab/docs.ts  DocRegistry: Y.Doc per board, persisted with y-indexeddb      │
│ collab/library.ts  keyring: boardId -> secret, title, parent, shared flag     │
│ collab/presence.ts  Awareness per open board (pointer, selection, drag)      │
│ collab/blobs.ts  content-addressed blob store (IndexedDB) + peer fetch        │
│ collab/sync/  P2P engine: Trystero rooms, multi-doc Yjs sync, blobs          │
│ collab/relay/ optional relay provider (WebSocket, end-to-end encrypted)      │
└───────────────────────────────────────────────────────────────────────────────┘
```

## Boards, secrets and sharing

* Every board is its own `Y.Doc` (guid = board id) with maps `meta` and `cards`
  (see `src/model/types.ts`). Deletion is **soft**: a deleted card keeps living in `cards` with
  `trashedAt` / `trashGroup` (or `movedTo` when moved to another board), so a teammate's
  concurrent edit to it is never lost; trash older than 90 days is purged by any peer.
* Every board has a random 32-byte **secret** (capability). A board card in a parent board stores
  the child's `boardId` + `secret`, so access to a board grants access to everything nested in it
  (like Milanote's inherited sharing). The Home board (`id = "home"`) is local-only, never synced.
* `collab/library.ts` remembers every known board's secret (learned from board cards and invite links).
* **Invite link** = `https://<web-host>/#/join/<base64url(JSON{b,k,t,r?})>` or
  `noema://join/<payload>`. The secret is in the URL *fragment*, which is never sent to any
  server. Opening it calls `joinBoard()` → board appears on Home → board opens.
* Derived values (`collab/crypto.ts`): `roomId` (public rendezvous id), `roomPassword`
  (encrypts WebRTC signaling), `relayToken`. The secret itself never leaves the device.
* Anyone with the link can edit (like Milanote's "anyone with the link can edit").
  Revocation = create a new board copy with a new secret (documented limitation).

## Peer-to-peer sync (`src/collab/sync/`)

* Transport: **Trystero 0.26** (`trystero` = Nostr strategy, `@trystero-p2p/torrent` = BitTorrent
  tracker strategy). Both are joined for redundancy; peers are merged by peer id.
  Relay config is global (one fixed list per strategy). STUN defaults; optional user TURN.
* **Rooms**: one room per *shared* board (library entry `shared: true`, i.e. invite created or
  joined, or `meta.shared` seen on a loaded doc). All boards nested inside it are multiplexed over
  that room (scope = boards reachable through board cards). Peers only serve docs inside the
  room's scope (capability check) and only accept updates for docs in scope.
* Wire protocol (one binary Trystero action `y`): `[varUint type][varString docId][payload]`
  * `0 SYNC`  y-protocols sync message (step1 / step2 / update) for board `docId`
  * `1 AWARENESS` y-protocols awareness update for board `docId`
  * `2 WANT` "I have/opened docId, sync me" → reply with SyncStep1
  * `3 HELLO` protocol version + list of docIds I hold in this room's scope
* Blobs: Trystero request action `blob` by SHA-256 hash; receiver verifies the hash.
* Anti-entropy every ~60 s and on `online`, plus SyncStep1 on every peer join; peers relay
  updates to members they are not directly connected to (partial meshes).
* Same-device tabs/windows sync via `BroadcastChannel`.
* Limits: a full mesh works well up to ~25–30 people active on the same shared board at once.

## Relay / sync service (`relay/` server, `src/collab/relay/` client)

`effectiveRelay()` in src/collab/relay/manager.ts picks the relay a board syncs through: the relay
set on the board itself, else the nearest parent's. If neither is set and the board or one of its
parents is shared, it uses the build's `DEFAULT_RELAY` (`VITE_DEFAULT_RELAY`: `same-origin` on the
hosted web app, the `DEFAULT_RELAY` repository variable for release builds). Home never uses a
relay; a board that isn't shared only uses one if a relay was set on it or on a board it sits in.
The relay keeps boards available while nobody else is online and works where strict NATs block
P2P. A "blind" relay stores an append-only log of AES-GCM encrypted Yjs updates + encrypted
snapshots and encrypted blobs; it cannot read boards. Runs with `node` (no native deps,
`node:sqlite`), Docker, or on Cloudflare Workers with Durable Objects (`relay/cloudflare/`).

## Local persistence

* Board docs: y-indexeddb, one database per board (`noema:board:<id>`; `noema:<profile>:` prefix
  in dev when `?profile=alice` is used to simulate several people in one browser).
* Blobs (images/files): IndexedDB store keyed by SHA-256 hex. Only the hash goes into the doc.
* `navigator.storage.persist()` is requested on start.

## UI (`src/board/`, `src/cards/`, `src/ui/`)

* `BoardView` opens a doc, creates `CardIndex`, `Y.UndoManager` (tracks `LOCAL_ORIGIN` only),
  and Awareness; renders `Canvas` + chrome.
* `Canvas`: CSS-transform pan/zoom, culling, marquee, double-click to add note, file drops.
* `CardShell`: frame, selection, drag (with drop targets: column insert, move into board card,
  trash), resize, remote outlines. Drag previews are local + broadcast through awareness; the doc
  is written once on drop.
* Card bodies are registered in `src/cards/registry.ts` (`CardProps` in `src/cards/types.ts`).
* Rich text: TipTap v3 bound to the card's `Y.XmlFragment`; non-edited cards render static HTML.
* Undo: one board UndoManager tracks canvas actions (`LOCAL_ORIGIN`) and, once a text card has
  been edited, its rich-text changes too, so Ctrl+Z after leaving a note undoes the typing rather
  than the card. Remote changes are never undone.

## Desktop app (`electron/`)

Electron shell that loads the same web build over a privileged `app://` scheme, registers the
`noema://` protocol for invite links, fetches link previews in the main process (SSRF-guarded),
can keep running in the tray so a teammate's computer keeps boards available, and is packaged by
electron-builder (Windows NSIS, macOS dmg, Linux AppImage) in GitHub Actions.

## Web app

The web build (made with `--mode cloudflare`, so shared boards use the built-in end-to-end
encrypted sync service at `/relay`) is deployed for free to Cloudflare Workers together with that
sync service (`npm run deploy:cloudflare`, see docs/HOSTING.md), so invitees can join from a
browser without installing anything. GitHub Pages can optionally host a copy of the front page only
(`.github/workflows/pages.yml`, off unless the repository variable `PAGES_ENABLED` is `true`).
