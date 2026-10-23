# NoemaBoard

**Free, open-source visual boards for teams.** Collect notes, images, links, to-dos and ideas on an
endless canvas, organise them with columns and boards inside boards, and work on them **together
in real time**. No accounts, no subscriptions, no card limits, and no server you have to pay for.

> NoemaBoard is an independent open-source project inspired by visual board tools such as
> Milanote. It is not affiliated with, endorsed by, or connected to Milanote or its makers.

---

## What you can do

- **Endless canvas.** Pan and zoom freely. Snap-to-grid, multi-select, marquee selection, copy and
  paste between boards, duplicate, undo and redo.
- **Cards:**
  - **Notes** with rich text, headings, lists and checklists.
  - **To-do lists** with progress.
  - **Links** with previews, including YouTube, Vimeo and Spotify embeds.
  - **Images** with captions and a lightbox.
  - **Files** of any type, with audio and video players.
  - **Colour swatches**, **sketches** (freehand drawing), **documents** (long-form writing) and
    **comment threads**.
- **Structure.** **Columns** to stack cards, **boards inside boards** (with breadcrumbs), and
  **lines and arrows** with labels to connect cards.
- **Templates.** Start boards from project plan, weekly planner, brainstorm, moodboard,
  meeting notes, retrospective and storyboard templates.
- **Colours.** Card colours, board icons and colours, and light and dark mode.
- **Works on touch screens.** Pan with one finger, pinch to zoom, double-tap to add a note.
- **Real-time collaboration:**
  - Everyone sees edits instantly, including typing in the same note.
  - Live cursors, who-is-editing outlines, and an avatar list of who is on the board.
- **Your data:**
  - **Trash with restore**: deleted cards are kept for 90 days.
  - Search across boards.
  - **Export** to Markdown or plain text, plus full **backups** (`.noema` files) you can import
    again.
  - **Presentation mode.**

## How collaboration works without a server

Most collaboration apps send everything through the company's servers, which is why they charge
monthly fees. NoemaBoard works differently:

1. **Every board lives on the devices of the people who use it.** Your boards are saved on your
   computer, so the app works offline too.
2. **Teammates' apps talk to each other directly**, over an encrypted peer-to-peer connection
   (WebRTC, the same technology video-call apps use).
   - To *find* each other, the apps briefly use free public "matchmaking" services (Nostr relays and
     WebTorrent trackers).
   - These services only see an anonymous, encrypted handshake, never your content.
3. **Sharing is a link.** Click **Share → Copy invite link** and send it to your team.
   - Anyone with the link can open and edit that board and the boards inside it.
   - The secret key is in the part of the link after `#`, which browsers never send to any server.

### Things to know

- **Someone who has the board must be online for changes to reach others.**
  - If you edit while your teammates are offline, they get your changes the next time you are
    both online.
  - To keep boards always available, leave the desktop app running on one or two computers: turn
    on *Settings → Desktop → Keep boards online when the window is closed*.
  - Or set up the optional [sync server](docs/RELAY.md). It is free to self-host and end-to-end
    encrypted, so the server can't read your boards.
- **A few strict networks block direct connections.** Some company networks and mobile hotspots
  are like this.
  - If a teammate can't connect, add a free TURN server in *Settings → Network*, or use the
    optional sync server.
- **Access works like a key.** Anyone with the invite link can edit.
  - To remove someone, copy the content into a new board and share the new link.
  - People keep the copies already on their own devices.
- **Many people at once.** Large teams can share boards. A single board works best with up to
  about 25–30 people editing *at the same moment*. The sync server lifts this limit.

## Getting started with your team

1. **Install the desktop app** (Windows, macOS or Linux) from the
   [Releases page](../../releases/latest), or use the web version (see *Publish your own copy*).
   - Windows may warn about an "unrecognised app". Click **More info → Run anyway**: the app isn't
     code-signed yet.
   - macOS: open the app once, then go to **System Settings → Privacy & Security → Open Anyway**.
2. On first launch, choose the **name and colour** your teammates will see.
3. Click **Create a board**, add some cards, then click **Share → Copy invite link**.
4. Send the link to your teammates. They open it in their browser or in the desktop app (or paste
   it into **Home → Join a board**), and the board appears for them.
5. Work together. You'll see each other's cursors and edits live.

## Publish your own copy (free)

GitHub hosts the downloads and a web version for free. You only do this once:

1. Create a free account at [github.com](https://github.com). If you already have other GitHub
   Pages sites on your account, create a free *organization* for this app instead. Each web app
   should have its own address: browsers treat all Pages sites of one account as the same website.
2. Create a new **public** repository (for example `noema`) and upload this folder to it.
   [GitHub Desktop](https://desktop.github.com) is the easiest way.
3. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**. Every push
   to `main` now deploys the web app to `https://<your-name>.github.io/<repository>/`, and invite
   links point to it, so teammates can join from any browser without installing anything.
4. To build installers, create a tag such as `v0.1.0` (in GitHub: **Releases → Draft a new release
   → Choose a tag → v0.1.0 → Publish**). GitHub Actions then builds:
   - the Windows installer and portable `.exe`
   - macOS `.dmg` files (Intel and Apple Silicon)
   - Linux `AppImage` and `.deb` packages

   They are attached to that release. The version in `package.json` must match the tag (`0.1.0`
   for `v0.1.0`).
5. Optional: put your repository address in `src/config.ts` (`REPO_URL`) and `package.json`
   (`homepage`). The *Help* menu and *About* screen then link to it.

## Develop

Requirements: Node.js 24 LTS (or newer) and npm.

```bash
npm install
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Web app with hot reload at http://localhost:5173 |
| `npm run dev:desktop` | Desktop app in development mode |
| `npm test` | Unit tests (Vitest) |
| `npm run typecheck` | TypeScript checks for the web app and the desktop shell |
| `npm run build:web` | Production web build in `dist/` |
| `npm run dist:win` | Windows installer and portable `.exe` in `release/` |

Tip: open `http://localhost:5173/?profile=alice` and `http://localhost:5173/?profile=bob` in two tabs
to simulate two people. Each profile has its own name and storage and syncs peer-to-peer like real
teammates.

Further reading:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the app, data model and sync fit together.
- [src/collab/sync/README.md](src/collab/sync/README.md): the peer-to-peer protocol.
- [docs/RELAY.md](docs/RELAY.md): the optional sync server.
- [electron/README.md](electron/README.md): the desktop shell, packaging and security model.

### Project layout

```
src/model        board data model (Yjs documents, cards, soft-delete trash)
src/board        canvas: pan/zoom, selection, drag & drop, lines, shortcuts
src/cards        card types (text, media, structure, creative)
src/editor       rich-text editing (TipTap)
src/collab       local storage, invite links, presence, peer-to-peer sync, optional relay client
src/ui           header, toolbar, menus, dialogs, export/backup, search
electron         desktop app shell
relay            optional self-hosted sync server (Node.js, Docker, Cloudflare Workers)
```

## Privacy & security

- No accounts, no tracking, no analytics.
- Board content travels only between your team's devices, over DTLS-encrypted WebRTC channels.
  The optional relay stores only AES-GCM ciphertext.
- Matchmaking services see that *someone* is looking for peers under a random, derived room id,
  plus your IP address. Peers also see each other's IP addresses, as in any peer-to-peer app.
- Link previews are fetched only by the desktop app of the person who added the link, with
  protections against requests to private networks.

## License

[MIT](LICENSE): free to use, modify and share, including in commercial teams.
