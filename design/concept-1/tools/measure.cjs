/**
 * Measures kerned pen positions of a string in a font with given variation settings (Chromium/HarfBuzz shaping).
 * npx electron design/concept-1/tools/measure.cjs <font.woff2> <text> <json settings array> <out.json>
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const a = process.argv.slice(2).filter((x) => !x.endsWith('.cjs') && x !== '.' && !x.startsWith('--'))
const [font, text, settingsJson, out] = a
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 2400, height: 600, webPreferences: { offscreen: true } })
  const html = `<!doctype html><meta charset="utf-8"><style>@font-face{font-family:F;src:url('${pathToFileURL(font).href}') format('woff2');font-weight:100 900}
  body{margin:0} div{font-family:F;font-size:2000px;line-height:1;white-space:nowrap;position:absolute;left:0;top:0;font-kerning:normal}</style><body></body>`
  const tmp = require('node:path').join(require('node:os').tmpdir(), 'measure-' + process.pid + '.html')
  fs.writeFileSync(tmp, html)
  await win.loadURL(pathToFileURL(tmp).href)
  const res = await win.webContents.executeJavaScript(`(async () => {
    const settings = ${settingsJson}
    const text = ${JSON.stringify(text)}
    const out = []
    for (const s of settings) {
      const el = document.createElement('div')
      el.style.fontVariationSettings = Object.entries(s).map(([k, v]) => "'" + k + "' " + v).join(', ')
      el.textContent = text
      document.body.appendChild(el)
      await document.fonts.ready
      await new Promise(r => setTimeout(r, 50))
      const node = el.firstChild, xs = []
      for (let i = 0; i <= text.length; i++) {
        const r = document.createRange()
        if (i < text.length) { r.setStart(node, i); r.setEnd(node, i + 1); xs.push(r.getBoundingClientRect().left) }
        else { r.setStart(node, i - 1); r.setEnd(node, i); xs.push(r.getBoundingClientRect().right) }
      }
      out.push(xs)
      el.remove()
    }
    return out
  })()`)
  fs.writeFileSync(out, JSON.stringify(res))
  console.log(JSON.stringify(res))
  app.exit(0)
})
