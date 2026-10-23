/**
 * Exact-size rasterizer for the NoemaBoard SVGs (Electron's Chromium, canvas drawImage, like build/make-icons.cjs),
 * plus a small ICO writer. The SVG gets width/height set to the target size first, so the media queries inside
 * icon.svg / favicon.svg pick the drawing made for that size.
 *
 *   npx electron design/concept-1/raster.cjs <jobs.json>
 *
 * jobs.json: [{ "svg": "file.svg", "w": 180, "h": 180, "out": "file.png" },
 *             { "ico": [{ "svg": "icon.svg", "size": 16 }, ...], "out": "icon.ico" }]   (paths relative to the json)
 * ICO entries up to 128 px are stored as 32-bit BMP (widest compatibility: NSIS, rcedit, old shells), 256 as PNG.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const jobsFile = process.argv.slice(2).find((a) => a.endsWith('.json'))
const base = path.dirname(path.resolve(jobsFile))
const jobs = JSON.parse(fs.readFileSync(jobsFile, 'utf8'))

app.disableHardwareAcceleration()

function sized(svg, w, h) {
  return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, '')} width="${w}" height="${h}">`)
}

async function raster(win, file, w, h) {
  const svg = sized(fs.readFileSync(path.resolve(base, file), 'utf8'), w, h)
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  return win.webContents.executeJavaScript(`(async () => {
    const img = new Image()
    img.src = ${JSON.stringify(src)}
    await img.decode()
    const c = document.createElement('canvas')
    c.width = ${w}; c.height = ${h}
    const ctx = c.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, ${w}, ${h})
    const px = ctx.getImageData(0, 0, ${w}, ${h}).data
    let bin = ''
    for (let i = 0; i < px.length; i += 8192) bin += String.fromCharCode.apply(null, px.subarray(i, i + 8192))
    return { png: c.toDataURL('image/png').split(',')[1], rgba: btoa(bin) }
  })()`)
}

function bmpEntry(rgba, s) {
  const maskRow = Math.ceil(s / 32) * 4
  const buf = Buffer.alloc(40 + s * s * 4 + maskRow * s)
  buf.writeUInt32LE(40, 0)
  buf.writeInt32LE(s, 4)
  buf.writeInt32LE(s * 2, 8) // XOR + AND masks
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(s * s * 4 + maskRow * s, 20)
  let o = 40
  for (let y = s - 1; y >= 0; y--)
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4
      buf[o++] = rgba[i + 2]
      buf[o++] = rgba[i + 1]
      buf[o++] = rgba[i]
      buf[o++] = rgba[i + 3]
    }
  // AND mask stays all zero: transparency comes from the alpha channel
  return buf
}

function ico(entries) {
  const head = Buffer.alloc(6 + 16 * entries.length)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(entries.length, 4)
  let offset = head.length
  entries.forEach((e, i) => {
    const o = 6 + 16 * i
    head[o] = e.size >= 256 ? 0 : e.size
    head[o + 1] = e.size >= 256 ? 0 : e.size
    head[o + 2] = 0
    head[o + 3] = 0
    head.writeUInt16LE(1, o + 4)
    head.writeUInt16LE(32, o + 6)
    head.writeUInt32LE(e.data.length, o + 8)
    head.writeUInt32LE(offset, o + 12)
    offset += e.data.length
  })
  return Buffer.concat([head, ...entries.map((e) => e.data)])
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
    await win.loadURL('data:text/html,<!doctype html><title>raster</title>')
    for (const job of jobs) {
      const out = path.resolve(base, job.out)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      if (job.ico) {
        const entries = []
        for (const e of job.ico.sort((a, b) => a.size - b.size)) {
          const r = await raster(win, e.svg, e.size, e.size)
          const data = e.size <= 128 ? bmpEntry(Buffer.from(r.rgba, 'base64'), e.size) : Buffer.from(r.png, 'base64')
          entries.push({ size: e.size, data })
        }
        fs.writeFileSync(out, ico(entries))
        console.log('wrote', job.out, entries.map((e) => e.size).join('/'))
      } else {
        const r = await raster(win, job.svg, job.w, job.h)
        fs.writeFileSync(out, Buffer.from(r.png, 'base64'))
        console.log('wrote', job.out, `${job.w}x${job.h}`)
      }
    }
    app.exit(0)
  } catch (err) {
    console.error(err)
    app.exit(1)
  }
})
