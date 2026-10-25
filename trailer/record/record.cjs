/**
 * Records the trailer's footage from the real app. It starts the app's dev server and a local sync
 * relay, opens off-screen windows (one per person), sets up demo boards with seed.js and drives
 * the mouse and keyboard, saving each window as public/clips/<shot>.mp4 plus <shot>.json: where
 * the pointer was in every frame, and when it clicked (the edit draws the pointer from that).
 *
 *   npm run record                 every shot
 *   npm run record -- add share    only these shots (add, organise, together, share)
 *
 * Needs ffmpeg on the PATH. Nothing is saved outside public/clips: every window uses throwaway
 * storage, the relay keeps its data in a temporary folder, and no public service is contacted.
 */
const { app, BrowserWindow } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const OUT = path.resolve(__dirname, '../public/clips')
const APP_PORT = 5179
const RELAY_PORT = 8797
const APP_URL = `http://127.0.0.1:${APP_PORT}/`
/**
 * The page is laid out at VIEW (CSS pixels) and rendered at SCALE times that (1920 x 1080 frames):
 * a 1920 x 1080 window at 150% zoom, since off-screen rendering ignores display scaling.
 */
const VIEW = { w: 1280, h: 720 }
const SCALE = 1.5
const FPS = 30
const FRAME_MS = 1000 / FPS

/** Where every demo board sits: its cards start at 345 CSS pixels, so they are centred in the window. */
const BOARD_VIEW = { x: 272, y: 40, zoom: 1 }

const ADA = { name: 'Ada', color: '#0090ff' }
const BEN = { name: 'Ben', color: '#f76b15' }

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[record]', ...a)

// ---------------------------------------------------------------------------
// The app and the relay

function launch(name, args, opts) {
  const child = spawn(process.platform === 'win32' ? 'node.exe' : 'node', args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  let output = ''
  const keep = (d) => (output = (output + d).slice(-4000))
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.on('exit', (code) => code && log(`${name} stopped (${code}):\n${output}`))
  return child
}

async function waitForHttp(url, what, ms = 90_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await sleep(300)
  }
  throw new Error(`${what} did not start`)
}

async function startServers() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'noema-trailer-relay-'))
  const relay = launch('relay', [path.join(ROOT, 'relay/bin/noema-relay.js')], {
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: '127.0.0.1', DATA_DIR: dataDir },
  })
  const vite = launch('app', [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(APP_PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Invite links read like the real ones; shared boards sync through the local relay.
      VITE_PUBLIC_URL: 'https://noemaboard.app/app/',
      VITE_DEFAULT_RELAY: `ws://127.0.0.1:${RELAY_PORT}`,
    },
  })
  await waitForHttp(`http://127.0.0.1:${RELAY_PORT}/healthz`, 'the relay')
  await waitForHttp(APP_URL, 'the app')
  return async () => {
    const exited = (p) => (p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once('exit', r)))
    vite.kill()
    relay.kill()
    await Promise.race([Promise.all([exited(vite), exited(relay)]), sleep(5000)])
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // still locked: the OS cleans its temp folder eventually
    }
  }
}

// ---------------------------------------------------------------------------
// Windows

let partitions = 0

/** An off-screen app window for one person, named and ready. */
async function openWindow(person) {
  const win = new BrowserWindow({
    width: VIEW.w * SCALE,
    height: VIEW.h * SCALE,
    useContentSize: true,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      zoomFactor: SCALE,
      partition: `trailer-${process.pid}-${partitions++}`,
    },
  })
  win.webContents.setFrameRate(60)
  const v = { person, win, wc: win.webContents, image: null, cursor: { x: VIEW.w * 0.7, y: VIEW.h * 0.75, down: false }, carry: false, rec: null }
  v.wc.on('paint', (_e, _dirty, image) => {
    v.image = image
  })
  v.wc.on('console-message', (e) => {
    if (e.level === 'error') log(`${person.name}: ${e.message.slice(0, 300)}`)
  })
  await win.loadURL(APP_URL)
  await until(v, `!!document.querySelector('.app-header')`, 'the app to start')
  await call(v, 'setup', person.name, person.color)
  await sleep(500)
  return v
}

/** Calls a function from seed.js inside the window. */
function call(v, fn, ...args) {
  return v.wc.executeJavaScript(`import('/trailer/record/seed.js').then((m) => m[${JSON.stringify(fn)}](...${JSON.stringify(args)}))`)
}

async function until(v, expression, what, ms = 20_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await v.wc.executeJavaScript(expression).catch(() => false)) return
    await sleep(100)
  }
  throw new Error(`${v.person.name}: timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------
// Mouse and keyboard

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Window pixels for a point in CSS pixels (input events use window pixels). */
const px = (n) => Math.round(n * SCALE)

function sendMove(v) {
  const { x, y, down } = v.cursor
  v.wc.sendInputEvent({ type: 'mouseMove', x: px(x), y: px(y), ...(down ? { button: 'left', modifiers: ['leftButtonDown'] } : {}) })
}

/** Glides the pointer to (x, y) on a gentle curve, like a hand on a mouse. */
async function moveTo(v, x, y, ms = 700) {
  const from = { x: v.cursor.x, y: v.cursor.y }
  const dist = Math.hypot(x - from.x, y - from.y)
  const steps = Math.max(1, Math.round(ms / 16))
  const bow = Math.min(36, dist * 0.08)
  const nx = dist ? -(y - from.y) / dist : 0
  const ny = dist ? (x - from.x) / dist : 0
  for (let i = 1; i <= steps; i++) {
    const t = easeInOut(i / steps)
    const arc = Math.sin(Math.PI * t) * bow
    v.cursor.x = from.x + (x - from.x) * t + nx * arc
    v.cursor.y = from.y + (y - from.y) * t + ny * arc
    sendMove(v)
    await sleep(16)
  }
}

function mark(v, type) {
  if (v.rec) v.rec.events.push({ t: performance.now(), type })
}

async function click(v, count = 1) {
  const { x, y } = v.cursor
  mark(v, 'click')
  for (let n = 1; n <= count; n++) {
    v.wc.sendInputEvent({ type: 'mouseDown', x: px(x), y: px(y), button: 'left', clickCount: n })
    await sleep(45)
    v.wc.sendInputEvent({ type: 'mouseUp', x: px(x), y: px(y), button: 'left', clickCount: n })
    if (n < count) await sleep(70)
  }
}

async function press(v) {
  mark(v, 'click')
  v.cursor.down = true
  v.wc.sendInputEvent({ type: 'mouseDown', x: px(v.cursor.x), y: px(v.cursor.y), button: 'left', clickCount: 1 })
  await sleep(120)
}

async function release(v) {
  v.cursor.down = false
  v.wc.sendInputEvent({ type: 'mouseUp', x: px(v.cursor.x), y: px(v.cursor.y), button: 'left', clickCount: 1 })
  await sleep(80)
}

async function key(v, keyCode) {
  v.wc.sendInputEvent({ type: 'keyDown', keyCode })
  v.wc.sendInputEvent({ type: 'keyUp', keyCode })
  await sleep(60)
}

/** Types like a person: about 14 characters a second, a little uneven. */
async function type(v, text, cps = 16) {
  let i = 0
  for (const ch of text) {
    if (ch === '\n') await key(v, 'Enter')
    else v.wc.sendInputEvent({ type: 'char', keyCode: ch })
    await sleep((1000 / cps) * (0.6 + ((i++ * 37) % 10) / 12))
  }
}

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 })

/** The smallest rectangle around all the given ones (CSS pixels). */
function union(...rects) {
  const rs = rects.filter(Boolean)
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y }
}

/** A rectangle in CSS pixels grown by a margin, inside the window, in video pixels. */
function videoBox(r, pad) {
  const x = Math.max(0, r.x - pad)
  const y = Math.max(0, r.y - pad)
  const w = Math.min(VIEW.w - x, r.w + 2 * pad)
  const h = Math.min(VIEW.h - y, r.h + 2 * pad)
  return { x: x * SCALE, y: y * SCALE, w: w * SCALE, h: h * SCALE }
}

/**
 * Marks where the action is from now on, and the area around it worth showing too (CSS pixels):
 * the edit frames the surroundings when its format has room, else the action itself.
 */
function focus(v, action, context = action, pad = 30, at = frameNow(v)) {
  const rec = v.rec
  if (!rec || !action) return
  // The surroundings get a slim margin, so a whole board still fits a phone-shaped frame.
  rec.focus.push({ f: at, a: videoBox(action, pad), c: videoBox(union(action, context), Math.min(pad, 20)) })
}

/** The frame being recorded now. */
function frameNow(v) {
  return v.rec ? Math.round((performance.now() - v.rec.t0) / FRAME_MS) : 0
}

// ---------------------------------------------------------------------------
// Recording

/** Starts saving the window's frames at a steady FPS (repeating the last frame when nothing changes). */
function startRecording(v, name, t0 = performance.now()) {
  fs.mkdirSync(OUT, { recursive: true })
  const file = path.join(OUT, `${name}.mp4`)
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    file,
  ])
  ff.stderr.on('data', (d) => log(`ffmpeg ${name}: ${String(d).trim()}`))
  const rec = { name, file, ff, t0, frames: [], events: [], focus: [], lastImage: null, lastJpeg: null, timer: null }
  v.wc.invalidate()
  rec.timer = setInterval(() => writeDue(v, rec), 4)
  v.rec = rec
  return rec
}

function writeDue(v, rec) {
  const due = Math.floor((performance.now() - rec.t0) / FRAME_MS) + 1
  if (rec.frames.length >= due) return
  if (v.image && v.image !== rec.lastImage) {
    rec.lastImage = v.image
    rec.lastJpeg = v.image.toJPEG(94)
  }
  if (!rec.lastJpeg) return
  while (rec.frames.length < due) {
    rec.ff.stdin.write(rec.lastJpeg)
    const { x, y, down } = v.cursor
    rec.frames.push([Math.round(x * SCALE * 10) / 10, Math.round(y * SCALE * 10) / 10, down ? 1 : 0, v.carry ? 1 : 0])
  }
}

async function stopRecording(v) {
  const rec = v.rec
  v.rec = null
  writeDue(v, rec)
  clearInterval(rec.timer)
  const done = new Promise((r) => rec.ff.on('close', r))
  rec.ff.stdin.end()
  await done
  const timeline = {
    fps: FPS,
    width: VIEW.w * SCALE,
    height: VIEW.h * SCALE,
    // [x, y, button down, carrying a file] per frame, in video pixels.
    frames: rec.frames,
    clicks: rec.events.filter((e) => e.type === 'click').map((e) => Math.round((e.t - rec.t0) / FRAME_MS)),
    // { f, x, y, w, h }: from frame f on, the action is in this rectangle (video pixels).
    focus: rec.focus,
  }
  fs.writeFileSync(path.join(OUT, `${rec.name}.json`), JSON.stringify(timeline))
  log(`${rec.name}: ${rec.frames.length} frames (${(rec.frames.length / FPS).toFixed(1)} s)`)
}

/** Puts the pointer somewhere without recording a move (before a shot starts). */
function placeCursor(v, x, y) {
  v.cursor.x = x
  v.cursor.y = y
  sendMove(v)
}

// ---------------------------------------------------------------------------
// Shots

const SHOTS = {
  /** Add anything: a double-click makes a note, a picture drops in, tasks get ticked. */
  async add() {
    const ada = await openWindow(ADA)
    const board = await call(ada, 'launchBoard')
    await call(ada, 'show', board.id, BOARD_VIEW)
    const title = await call(ada, 'cardRect', board.ids.title)
    const todo = await call(ada, 'cardRect', board.ids.todo)
    const link = await call(ada, 'cardRect', board.ids.link)
    // New cards go in a second column, right of the first.
    const note = { x: title.x + 310, y: title.y, w: 300, h: 70 }
    const picture = { x: title.x + 310, y: title.y + 120, w: 300, h: 200 }
    const all = union(title, todo, link, note, picture)
    placeCursor(ada, 1040, 640)
    await sleep(600)
    startRecording(ada, 'add')
    focus(ada, all)
    await sleep(500)

    focus(ada, note, all, 50)
    await moveTo(ada, note.x + 20, note.y + 20, 800)
    await sleep(120)
    await click(ada, 2)
    await sleep(380)
    await type(ada, 'Big idea: one board for the whole team')
    await sleep(350)
    await moveTo(ada, 1060, 640, 600)
    await click(ada)
    await sleep(250)

    // A picture dragged in from the side of the screen.
    focus(ada, picture, all, 50)
    placeCursor(ada, 1290, picture.y + 90)
    ada.carry = true
    await moveTo(ada, picture.x, picture.y, 900)
    await call(ada, 'dropPicture', picture.x, picture.y)
    ada.carry = false
    await sleep(900)
    await key(ada, 'Escape')

    const boxes = await call(ada, 'checkboxRects', board.ids.todo)
    focus(ada, todo, all, 50)
    for (const box of boxes.slice(0, 2)) {
      const c = center(box)
      await moveTo(ada, c.x, c.y, 550)
      await sleep(80)
      await click(ada)
      await sleep(300)
    }
    await key(ada, 'Escape')
    focus(ada, all)
    await moveTo(ada, picture.x + 120, picture.y + 300, 700)
    await sleep(900)
    await stopRecording(ada)
    ada.win.destroy()
  },

  /** Organise: a card dragged into a column, then a board opened inside the board. */
  async organise() {
    const ada = await openWindow(ADA)
    const board = await call(ada, 'planBoard')
    await call(ada, 'show', board.id, BOARD_VIEW)
    await sleep(500)
    const loose = await call(ada, 'cardRect', board.ids.loose)
    const doing = await call(ada, 'cardRect', board.ids.doing)
    const todoColumn = await call(ada, 'cardRect', board.ids.todoColumn)
    const moodCard = await call(ada, 'cardRect', board.ids.moodboardCard)
    const all = union(todoColumn, doing, loose, moodCard)
    placeCursor(ada, 1040, 640)
    startRecording(ada, 'organise')
    focus(ada, all)
    await sleep(500)

    focus(ada, union(doing, loose), all, 40)
    await moveTo(ada, loose.x + loose.w * 0.45, loose.y + 22, 800)
    await sleep(100)
    await press(ada)
    // Let go inside the column, near its bottom: the app drops where the pointer is, so the card goes last.
    await moveTo(ada, doing.x + doing.w * 0.5, doing.y + doing.h - 24, 1100)
    await sleep(250)
    await release(ada)
    await sleep(700)

    const mood = await call(ada, 'cardRect', board.ids.moodboardCard)
    focus(ada, mood, all, 50)
    const m = center(mood)
    await moveTo(ada, m.x, m.y, 800)
    await sleep(150)
    await click(ada, 2)
    // The board inside opens where its colours and notes fill the same column (seed.planBoard).
    focus(ada, { x: 345, y: 60, w: 600, h: 520 }, { x: 345, y: 60, w: 600, h: 520 }, 20)
    await sleep(2200)
    await moveTo(ada, 860, 520, 900)
    await sleep(600)
    await stopRecording(ada)
    ada.win.destroy()
  },

  /** Together: Ben types into a note and Ada moves a card, each seeing the other live. */
  async together() {
    const ada = await openWindow(ADA)
    const ben = await openWindow(BEN)
    const board = await call(ada, 'teamBoard')
    if (!board.invite) throw new Error('no invite')
    await call(ben, 'join', board.invite)
    await call(ada, 'show', board.id, BOARD_VIEW)
    await call(ben, 'show', board.id, BOARD_VIEW)
    await until(ben, `!!document.getElementById(${JSON.stringify(`card-${board.ids.post}`)})`, "Ben's copy of the board")
    for (const v of [ada, ben]) await until(v, `/online/.test(document.querySelector('.sync-pill__label')?.textContent ?? '')`, 'both people online')
    const title = await call(ada, 'cardRect', board.ids.title)
    const post = await call(ben, 'cardRect', board.ids.post)
    const checklist = await call(ada, 'cardRect', board.ids.checklist)
    const photo = await call(ada, 'cardRect', board.ids.photo)
    const moved = { ...photo, y: photo.y + 150 }
    const all = union(title, post, checklist, photo, moved)
    placeCursor(ada, 1040, 600)
    placeCursor(ben, 1060, 640)
    await sleep(800)
    const t0 = performance.now()
    startRecording(ada, 'together-ada', t0)
    startRecording(ben, 'together-ben', t0)
    // Each screen frames what the other person does there: Ben's typing, Ada's moving card.
    focus(ada, { ...post, h: post.h + 60 }, all, 40)
    focus(ben, union(photo, moved), all, 40)
    await sleep(600)

    await Promise.all([
      (async () => {
        await moveTo(ben, post.x + 120, post.y + 26, 1000)
        await sleep(200)
        await click(ben, 2)
        await sleep(400)
        await key(ben, 'End')
        await type(ben, '\nFree visual boards for every team. Live today!')
        await sleep(300)
        await moveTo(ben, 1000, 640, 800)
        await click(ben)
      })(),
      (async () => {
        await sleep(900)
        await moveTo(ada, photo.x + 110, photo.y + 22, 900)
        await sleep(1500)
        await press(ada)
        await moveTo(ada, moved.x + 110, moved.y + 22, 1000)
        await release(ada)
        await moveTo(ada, 1030, 560, 900)
      })(),
    ])
    await sleep(1200)
    await Promise.all([stopRecording(ada), stopRecording(ben)])
    ada.win.destroy()
    ben.win.destroy()
  },

  /** Share: one click on Share, one on Copy invite link. */
  async share() {
    const ada = await openWindow(ADA)
    const board = await call(ada, 'launchBoard')
    await call(ada, 'show', board.id, BOARD_VIEW)
    await until(ada, `/Synced|online/.test(document.querySelector('.sync-pill__label')?.textContent ?? '')`, 'the board to sync')
    const share = await call(ada, 'rect', '.app-header__share')
    const title = await call(ada, 'cardRect', board.ids.title)
    const todo = await call(ada, 'cardRect', board.ids.todo)
    placeCursor(ada, 900, 420)
    startRecording(ada, 'share')
    focus(ada, share, union(share, title, todo), 40)
    await sleep(500)
    const s = center(share)
    await moveTo(ada, s.x, s.y, 800)
    await sleep(150)
    const clickedAt = frameNow(ada)
    await click(ada)
    await sleep(350)
    // Marked from the click on, so the camera heads for the dialog as it opens.
    const dialog = await call(ada, 'rect', '[role="dialog"]')
    focus(ada, dialog, dialog, 30, clickedAt)
    await sleep(550)
    const copy = await call(ada, 'buttonRect', 'Copy invite link')
    const c = center(copy)
    await moveTo(ada, c.x, c.y, 700)
    await sleep(150)
    await click(ada)
    await sleep(300)
    focus(ada, dialog, union(dialog, await call(ada, 'rect', '.toast')), 30)
    await sleep(1500)
    await stopRecording(ada)
    ada.win.destroy()
  },
}

// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  const wanted = process.argv.slice(2).filter((a) => a in SHOTS)
  const names = wanted.length ? wanted : Object.keys(SHOTS)
  let stop = async () => {}
  let failed = 0
  try {
    log('starting the app and the relay...')
    stop = await startServers()
    for (const name of names) {
      log(`shot: ${name}`)
      try {
        await SHOTS[name]()
      } catch (e) {
        failed++
        log(`${name} failed: ${e instanceof Error ? e.stack : e}`)
      }
    }
  } catch (e) {
    failed++
    log(e instanceof Error ? e.stack : e)
  } finally {
    await stop()
    app.exit(failed ? 1 : 0)
  }
})
