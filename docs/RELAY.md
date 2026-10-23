# Relay servers (optional)

NoemaBoard works without a server: teammates' apps sync directly with each other (peer-to-peer), and
free public signaling relays only help them find each other. The public NoemaBoard (the hosted web
app and the release downloads) also comes with an always-on relay for shared boards, so this page is
for your own copy or your own relay. A **relay server** is an optional extra you can run yourself,
for free, when you need one of these:

| Problem                                                                             | A relay helps because…                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Someone opens a board while nobody else who has the latest changes is online        | the relay keeps an encrypted copy of every change and file, available around the clock    |
| A company network, hotel Wi-Fi or mobile carrier blocks direct connections          | everyone connects to the relay over a normal HTTPS/WebSocket connection                    |
| You don't want to leave a teammate's computer running (desktop app in the tray)     | the relay is the always-on member of the team                                              |

Peer-to-peer sync keeps working alongside the relay; the two complement each other.

## Choosing where to run it

All options run the same open-source relay (`relay/` in this repository). Pick one:

### 1. Any always-on computer with Node.js (simplest)

On a spare PC, a NAS, a Raspberry Pi or a server with Node.js 22.13 or newer:

```sh
npx noema-relay            # or: cd relay && npm install --omit=dev && npm start
```

It listens on port 8787 and stores everything in `./data`. Configure it with environment
variables (`PORT`, `DATA_DIR`, `ACCESS_KEY`, `MAX_BLOB_MB`, `MAX_ROOM_MB`, … see
[relay/README.md](../relay/README.md)).

People using the **web app** need a secure address (`wss://` / `https://`), so put the relay
behind a TLS proxy (for example `caddy reverse-proxy --from relay.example.com --to localhost:8787`
gets a free certificate automatically) or use option 4. Desktop-app users on the same local network
can also use `ws://192.168.x.x:8787`.

### 2. Docker on a free cloud VM (e.g. Oracle Cloud "Always Free")

Oracle Cloud's Always Free tier includes small Arm and AMD virtual machines that are plenty for a
relay. On the VM:

```sh
git clone <this repository> && cd NoemaBoard/relay
docker build -t noema-relay .
docker run -d --name noema-relay --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v noema-relay:/data -e ACCESS_KEY=pick-a-long-random-key noema-relay
```

Then point a domain (or a free dynamic-DNS name) at the VM, open ports 80/443 in the VM's security
list and firewall, and run Caddy in front of it for HTTPS. Any other provider's free or cheap VM
works the same way.

### 3. Cloudflare Workers free plan (no server to maintain)

`relay/cloudflare/` is the same relay built on Cloudflare Workers and SQLite-backed Durable
Objects. It needs a free Cloudflare account and no credit card:

```sh
cd relay/cloudflare && npm install && npx wrangler login && npx wrangler deploy
npx wrangler secret put ACCESS_KEY      # optional, recommended
```

Use the printed address with `wss://`, e.g. `wss://noema-relay.yourname.workers.dev`.

Capacity: the free plan's daily quotas (about 100,000 saved change batches, ~28 hours of "awake"
board rooms, 100,000 requests and 5 GB of storage in total) suit teams of roughly **10–40 people**
with typical use. If a daily quota runs out, the relay pauses until the next day and boards keep
syncing peer-to-peer. Details are in [relay/README.md](../relay/README.md#deploy-to-cloudflare-free-plan).

### 4. A home PC + Tailscale (private, nothing exposed to the internet)

Run the relay on an always-on home computer (option 1) and share it with your team through
[Tailscale](https://tailscale.com):

```sh
npx noema-relay &
tailscale serve --bg 8787        # https://<computer>.<your-tailnet>.ts.net, tailnet members only
```

Use `wss://<computer>.<your-tailnet>.ts.net` as the relay address. Only people in your tailnet can
reach it, and Tailscale provides the HTTPS certificate.

## Setting the relay on a board

1. Open the board, then **Share → Advanced → Sync server**.
2. Enter the relay address, for example `wss://relay.example.com` (an `https://` address works too).
   If the relay uses an access key, add it: `wss://relay.example.com/?key=YOUR_KEY`.
3. Press **Test**: it checks that the relay is reachable, is a NoemaBoard relay, accepts the access
   key and that WebSockets get through.
4. Save. The address is stored in the board itself, so everyone on the board (and everyone you
   invite later; it is part of invite links) uses the same relay automatically.

Boards nested inside that board use the same relay unless they set their own. Clearing the field
makes the board use the relay of the board it sits in again. If there is none, a shared board falls
back to the app's built-in sync service, when your copy of NoemaBoard has one (the public web app
and release downloads do). Only when there is neither does relay sync stop for the board. A relay
the board no longer uses keeps its encrypted copy until its operator deletes it.

The connection status for each board (connecting, connected, offline, error with a reason) is shown
in the app. When the relay is unreachable, boards keep syncing peer-to-peer and catch up with the
relay automatically when it is back, including changes made while offline.

## Security model

The relay is **blind**: it stores and forwards data it cannot read.

- Each board has a random 256-bit secret that only exists on members' devices and in invite links
  (in the part of the link after `#`, which browsers never send to any server).
- From that secret every device derives, with HKDF-SHA256: a public **room id** for the board on
  the relay, a **write token**, and an **AES-256-GCM content key**. The relay only ever sees the
  room id and the token; it stores just a SHA-256 hash of the token (the first device to use a room
  claims it, and later devices must present the same token).
- Every change, board snapshot, presence update (cursors, names) and file is encrypted on the
  device with a fresh random IV before it leaves; the board's room id is bound into each message, so
  ciphertext cannot be moved to another board. Files are stored under a hash of their ciphertext and
  found through a keyed alias, so the relay cannot even tell which files are on a board.
- The relay operator therefore **cannot read boards, files or names**, cannot forge or alter
  changes (they would fail authentication and be ignored), and cannot learn the board secret.

What a relay operator **can** see or do: the number of boards, their encrypted size and activity
over time, how many devices are connected and their IP addresses. They can also delete data or
refuse service; members' devices still hold full copies and keep syncing peer-to-peer, and
re-upload everything if a relay loses its data.

Notes:

- Use `wss://` (TLS). Over plain `ws://` the content is still end-to-end encrypted, but network
  observers can see room ids, tokens and the access key.
- An `ACCESS_KEY` decides who may use your relay at all (it protects your storage from strangers);
  it does not change who can read a board. Anyone with a board's invite link can read and edit
  it, with or without a relay.
- To lock someone out of a board, make a copy of the board (a new secret) and share the new one.
