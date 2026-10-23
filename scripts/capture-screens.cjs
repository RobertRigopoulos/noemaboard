/**
 * Captures real app screenshots for the front page: site/assets/screenshots/*.png.
 *
 *   1. Start the dev server:   npm run dev            (http://localhost:5173)
 *   2. From the repository root:
 *        npx electron scripts/capture-screens.cjs
 *      Options:  --url http://localhost:5173   another dev server address
 *                --only hero                   capture only shots whose name contains "hero"
 *
 * What it does:
 *   - Opens the app in a hidden (offscreen) window with a fresh, in-memory browser session and the
 *     "demo" storage profile (?profile=demo), so your own boards are never read or changed.
 *   - Pre-sets a display name and the light theme, then creates demo boards by importing the app's
 *     own modules through the dev server (templates/create.ts, collab/docs.ts, model/board.ts,
 *     templates/writer.ts and templates/richText.ts).
 *   - Opens each board, fits it in view and captures it at 1440 x 900 with device scale factor 2.
 *
 * Output: site/assets/screenshots/<name>.png at 1600 x 1000 (sharp on retina, light enough for the
 * web) and the untouched 2880 x 1800 captures in design/site-previews/app/<name>@2x.png.
 * The front page picks the files up by name: hero.png replaces the drawing in the hero, and
 * project-plan.png, moodboard.png and brainstorm.png fill the "A look inside" gallery.
 */
const { app, BrowserWindow, nativeImage } = require('electron')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const OUT_WEB = path.join(ROOT, 'site', 'assets', 'screenshots')
const OUT_RAW = path.join(ROOT, 'design', 'site-previews', 'app')

const argv = process.argv.slice(2)
const argValue = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const BASE = (argValue('--url') || 'http://localhost:5173').replace(/\/+$/, '')
const ONLY = argValue('--only') || ''

const VIEW = { width: 1440, height: 900, scale: 2 }
const WEB_WIDTH = 1600

/** Shots, in capture order. `board` names a key returned by the in-page setup below. */
const SHOTS = [
  { name: 'hero', board: 'hero' },
  { name: 'project-plan', board: 'project-plan' },
  { name: 'moodboard', board: 'moodboard' },
  { name: 'brainstorm', board: 'brainstorm' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.disableHardwareAcceleration()

function checkServer(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Runs in the page (as a string, through executeJavaScript). Creates the demo boards on Home with
 * the app's real APIs and returns { key: boardId }.
 */
const SETUP_DEMO = String.raw`(async () => {
  const [{ docs }, { HOME_BOARD_ID }, { createBoardFromTemplate }, board, { layout }, rt, { useLibrary }, { getUser }, thread] =
    await Promise.all([
      import('/src/collab/docs.ts'),
      import('/src/config.ts'),
      import('/src/templates/create.ts'),
      import('/src/model/board.ts'),
      import('/src/templates/writer.ts'),
      import('/src/templates/richText.ts'),
      import('/src/collab/library.ts'),
      import('/src/collab/identity.ts'),
      import('/src/cards/structure/thread.ts'),
    ])
  const { heading, paragraph, tasks, bullets } = rt
  const userId = getUser().id
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Waits until a board created by createBoardFromTemplate has been initialised. */
  async function initialised(id) {
    for (let i = 0; i < 100; i++) {
      const ok = await docs.withDoc(id, (doc) => !!board.getMeta(doc).get('id'))
      if (ok) return
      await wait(100)
    }
    throw new Error('board ' + id + ' was not initialised')
  }

  const home = docs.open(HOME_BOARD_ID)
  await home.ready
  try {
    const ids = {}
    // Board cards on Home, left to right. Each call also creates and fills the child board.
    ids.hero = createBoardFromTemplate(home.doc, 'blank', { x: 160, y: 160 })
    ids['project-plan'] = createBoardFromTemplate(home.doc, 'project-plan', { x: 340, y: 160 })
    ids.moodboard = createBoardFromTemplate(home.doc, 'moodboard', { x: 520, y: 160 })
    ids.brainstorm = createBoardFromTemplate(home.doc, 'brainstorm', { x: 700, y: 160 })
    for (const id of Object.values(ids)) await initialised(id)

    // The hero board: a launch plan that shows notes, a to-do, columns, swatches, a comment,
    // a line and a board inside the board.
    const TITLE = 'Spring launch'
    await docs.withDoc(ids.hero, (doc) => {
      board.updateMeta(doc, { title: TITLE, icon: 'rocket', color: 'orange' }, board.SYSTEM_ORIGIN)
      layout((w) => {
        const intro = w.note(
          { x: 0, y: 0 },
          [heading(1, TITLE), paragraph('A calm landing page, a week of short posts and one demo video. Everything for the launch lives on this board.')],
          { w: 470 },
        )
        const swatches = [
          ['#24324a', 'Night'],
          ['#3f7f7a', 'Juniper'],
          ['#a9c5b6', 'Sage'],
          ['#f2c23b', 'Sun'],
        ]
        swatches.forEach(([hex, name], i) => w.swatch({ x: 520 + i * 160, y: 0 }, hex, name))

        const y = Math.max(w.below(intro), 200)
        const ideas = w.column({ x: 0, y }, 'Ideas', { color: 'yellow' })
        const doing = w.column({ x: 350, y }, 'In progress', { color: 'blue' })
        const done = w.column({ x: 700, y }, 'Done', { color: 'green' })

        w.note({ column: ideas }, [heading(3, 'Teaser clip'), paragraph('Ten seconds of a board filling up. No voice-over needed.')])
        w.note({ column: ideas }, [paragraph('One short post a day for a week, on LinkedIn and X.')], { color: 'yellow' })
        w.note({ column: ideas }, [heading(3, 'Questions to answer'), bullets('Why is it free?', 'Where do my boards live?', 'Can my team join without an account?')])

        w.todo({ column: doing }, 'Landing page', tasks({ text: 'Write the headline', done: true }, { text: 'Pick the colours', done: true }, 'Record a demo', 'Proofread every section'))
        w.note({ column: doing }, [heading(3, 'Demo video'), paragraph('Two people, one board, two minutes. Show the cursors moving.')])

        w.note({ column: done }, [heading(3, 'Name and logo'), paragraph('The N made of three cards, with the yellow thought card in the middle.')])
        w.todo({ column: done }, 'Setup', tasks({ text: 'Free hosting', done: true }, { text: 'Sync service', done: true }))

        const launch = w.note({ x: 1080, y: y + 40 }, [heading(2, 'Launch day'), paragraph('Tuesday morning, once the demo video is ready.')], { w: 300, color: 'orange' })
        w.line(done, launch)

        // A comment from a teammate, so the board does not look like a one-person show.
        const commentId = board.createCard(doc, 'comment', { x: 1080, y: w.below(launch, 60), w: 300 }, userId)
        const map = board.getCardMap(doc, commentId)
        if (map) thread.addComment(doc, map, { id: 'demo-jo-0000001', name: 'Jo', color: '#30a46c' }, 'The demo will be ready on Monday. Tuesday works for me.')
      })(doc, userId)
    })
    // Cached title on the Home card and in the library (breadcrumbs).
    board.getCards(home.doc).forEach((m, id) => {
      if (m.get('boardId') === ids.hero) board.updateCard(home.doc, id, { title: TITLE, icon: 'rocket', color: 'orange' }, userId, board.SYSTEM_ORIGIN)
    })
    useLibrary.getState().upsert({ id: ids.hero, title: TITLE, icon: 'rocket', color: 'orange' })

    // Boards inside boards: a moodboard card on the hero board.
    const heroHandle = docs.open(ids.hero)
    await heroHandle.ready
    try {
      createBoardFromTemplate(heroHandle.doc, 'moodboard', { x: 1230, y: 60 })
    } finally {
      heroHandle.release()
    }
    await wait(500)
    return ids
  } finally {
    home.release()
  }
})()`

/** Runs in the page: opens a board and waits until its cards are on screen. */
const openBoardJs = (id) => String.raw`(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  location.hash = '#/b/' + ${JSON.stringify(id)}
  for (let i = 0; i < 150; i++) {
    if (document.querySelectorAll('.card-shell').length > 0 && !document.querySelector('.board-loading')) break
    await wait(100)
  }
  await document.fonts.ready
  await wait(1200)
  // Fit again now that every card has its measured height; never zoom in past 100 %.
  const [{ docs }, actions, { useView }] = await Promise.all([
    import('/src/collab/docs.ts'),
    import('/src/board/actions.ts'),
    import('/src/board/store.ts'),
  ])
  const doc = docs.peek(${JSON.stringify(id)})
  if (doc) actions.zoomToFit(doc)
  await wait(100)
  if (useView.getState().viewport.zoom > 1) actions.zoomTo(1)
  // Nothing selected or focused, no caret, no hover states.
  const sel = (await import('/src/board/store.ts')).useSelection.getState()
  sel.clear?.()
  document.activeElement?.blur?.()
  await wait(800)
  return document.querySelectorAll('.card-shell').length
})()`

/** Tucks away transient UI so it never lands in a screenshot. */
const CAPTURE_CSS = `
  .toasts, .storage-banner { display: none !important; }
  *, *::before, *::after { caret-color: transparent !important; }
`

async function waitFor(win, expression, timeoutMs, label) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      if (await win.webContents.executeJavaScript(expression)) return
    } catch {
      // page still loading
    }
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${label}`)
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    console.error('capture-screens: timed out after 4 minutes')
    app.exit(2)
  }, 240_000)
  watchdog.unref()

  try {
    if (!(await checkServer(BASE + '/'))) {
      throw new Error(`no dev server at ${BASE}. Start it with "npm run dev" first, or pass --url.`)
    }
    fs.mkdirSync(OUT_WEB, { recursive: true })
    fs.mkdirSync(OUT_RAW, { recursive: true })

    const win = new BrowserWindow({
      show: false,
      width: VIEW.width,
      height: VIEW.height,
      useContentSize: true,
      webPreferences: {
        // Offscreen: a plain hidden window never finishes a capture on Windows.
        offscreen: true,
        // No "persist:" prefix: an in-memory session that disappears when this script exits.
        partition: `noema-capture-${Date.now()}`,
        contextIsolation: true,
        sandbox: true,
      },
    })
    win.webContents.setAudioMuted(true)

    // Emulation must start after a first navigation (Electron crashes otherwise).
    await win.loadURL('data:text/html,<title>capture</title>')
    const dbg = win.webContents.debugger
    dbg.attach('1.3')
    const send = (method, params = {}) => dbg.sendCommand(method, params)
    await send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: VIEW.scale, mobile: false })
    await send('Emulation.setScrollbarsHidden', { hidden: true })
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: 'light' },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    })

    // First visit: store a name and the light theme for the demo profile, then load the app for real.
    const appUrl = `${BASE}/?profile=demo`
    await win.loadURL(appUrl)
    await win.webContents.executeJavaScript(`(() => {
      const id = Array.from(crypto.getRandomValues(new Uint8Array(14)), (b) => '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'[b % 62]).join('')
      localStorage.setItem('noema:demo:profile', JSON.stringify({ id, name: 'Maya', color: '#f76b15' }))
      localStorage.setItem('noema:demo:theme', JSON.stringify('light'))
    })()`)
    await win.loadURL(appUrl)
    await win.webContents.insertCSS(CAPTURE_CSS)
    await waitFor(win, `!!document.querySelector('.board-view .canvas')`, 60_000, 'the app to start')
    console.log('capture-screens: app is up, creating demo boards')

    const ids = await win.webContents.executeJavaScript(SETUP_DEMO)
    await sleep(1000)

    for (const shot of SHOTS.filter((s) => !ONLY || s.name.includes(ONLY))) {
      const id = ids[shot.board]
      if (!id) throw new Error(`no board for ${shot.name}`)
      const cards = await win.webContents.executeJavaScript(openBoardJs(id))
      await win.webContents.insertCSS(CAPTURE_CSS)
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      const raw = Buffer.from(data, 'base64')
      fs.writeFileSync(path.join(OUT_RAW, `${shot.name}@2x.png`), raw)
      const web = nativeImage.createFromBuffer(raw).resize({ width: WEB_WIDTH, quality: 'best' })
      fs.writeFileSync(path.join(OUT_WEB, `${shot.name}.png`), web.toPNG())
      const size = web.getSize()
      console.log(`capture-screens: ${shot.name}.png ${size.width}x${size.height} (${cards} cards)`)
    }

    dbg.detach()
    clearTimeout(watchdog)
    app.exit(0)
  } catch (err) {
    console.error('capture-screens:', err && err.message ? err.message : err)
    app.exit(1)
  }
})
