/**
 * Renders local HTML files to PNG with Electron's Chromium (hidden offscreen window, 1x scale).
 *
 * Usage (from the repo root):
 *   npx electron design/concept-1/render.cjs <in.html> <out.png> [<in2.html> <out2.png> ...]
 *
 * The page size is measured after load (document scroll size), so pages define their own canvas.
 * A page can delay capture by setting window.__notReady = true and clearing it when done.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.cjs') && a !== '.')
const jobs = []
for (let i = 0; i + 1 < args.length; i += 2) jobs.push([args[i], args[i + 1]])

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.commandLine.appendSwitch('high-dpi-support', '1')

async function renderOne(inHtml, outPng) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 800,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: true, webSecurity: false },
  })
  await win.loadURL(pathToFileURL(path.resolve(inHtml)).href)
  const size = await win.webContents.executeJavaScript(`(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map(i => i.decode().catch(() => {})))
    for (let k = 0; k < 100 && window.__notReady; k++) await new Promise(r => setTimeout(r, 50))
    await new Promise(r => setTimeout(r, 250))
    const el = document.documentElement
    return { w: Math.ceil(Math.max(el.scrollWidth, document.body.scrollWidth)), h: Math.ceil(Math.max(el.scrollHeight, document.body.scrollHeight)) }
  })()`)
  win.setContentSize(size.w, size.h)
  await new Promise((r) => setTimeout(r, 400))
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size.w, height: size.h })
  fs.writeFileSync(path.resolve(outPng), img.toPNG())
  console.log('wrote', outPng, img.getSize())
  win.destroy()
}

app.whenReady().then(async () => {
  try {
    for (const [i, o] of jobs) await renderOne(i, o)
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
