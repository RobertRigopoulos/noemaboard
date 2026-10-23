// Check sheets for the NoemaBoard mark: writes preview.html, pixels.html and social.html next to this file and the
// raster job list (raster-jobs.json) for raster.cjs. Run after gen.mjs:
//   node design/concept-1/sheets.mjs
//   npx electron design/concept-1/raster.cjs design/concept-1/raster-jobs.json
//   npx electron design/concept-1/render.cjs design/concept-1/preview.html design/concept-1/preview.png \
//     design/concept-1/pixels.html design/concept-1/pixels.png design/concept-1/social.html design/concept-1/social.png
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAL } from './lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const rd = (n) => fs.readFileSync(path.join(here, n), 'utf8')
const inter = '../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'

// canvases that draw an SVG at a true pixel size (width/height injected, so its media queries see that size),
// shown enlarged with nearest-neighbour scaling
const SRC = {}
const zoom = (file, px, z, bg = 'transparent') => {
  SRC[file] ??= rd(file)
  return `<canvas data-file="${file}" data-px="${px}" data-bg="${bg}" style="width:${px * z}px;height:${px * z}px"></canvas>`
}
const script = () => `<script>
const SRC = ${JSON.stringify(SRC)}
window.__notReady = true
let left = 0
for (const c of document.querySelectorAll('canvas[data-file]')) {
  left++
  const px = +c.dataset.px; c.width = c.height = px
  const svg = SRC[c.dataset.file].replace(/<svg\\b/, '<svg width="' + px + '" height="' + px + '"')
  const im = new Image()
  im.onload = () => {
    const ctx = c.getContext('2d')
    if (c.dataset.bg !== 'transparent') { ctx.fillStyle = c.dataset.bg; ctx.fillRect(0, 0, px, px) }
    ctx.drawImage(im, 0, 0, px, px)
    if (--left === 0) window.__notReady = false
  }
  im.src = 'data:image/svg+xml;base64,' + btoa(svg)
}
if (!left) window.__notReady = false
</script>`

const css = `@font-face{font-family:Inter;src:url('${inter}') format('woff2');font-weight:100 900}
html,body{margin:0;overflow:hidden}
body{font:500 12px/1.3 Inter,system-ui,sans-serif;letter-spacing:.01em}
figure{margin:0;display:flex;flex-direction:column;align-items:center;gap:10px}
figcaption{font-size:11px;opacity:.55;white-space:nowrap}
canvas{image-rendering:pixelated;display:block}`

// ------------------------------------------------------------------ preview.html (contact sheet)
function band(mode) {
  const dark = mode === 'dark'
  const bg = dark ? PAL.dark : PAL.light
  const lock = dark ? 'lockup-dark.svg' : 'lockup.svg'
  const mk = dark ? 'mark-dark.svg' : 'mark.svg'
  const mono = dark ? 'mark-mono-white.svg' : 'mark-mono.svg'
  const sizes = [512, 180, 64, 32, 24, 16]
  return `<section style="background:${bg};color:${dark ? '#e7e9ec' : PAL.ink}">
  <header><span>${dark ? 'Dark' : 'Light'} &middot; ${bg}</span><span>icon.svg at ${sizes.join(' / ')} px</span></header>
  <div class="row">
    ${sizes.map((s) => `<figure><img src="icon.svg" width="${s}" height="${s}"><figcaption>${s}</figcaption></figure>`).join('')}
    <figure><div class="row tight">${zoom('icon.svg', 16, 6)}${zoom('icon.svg', 24, 4)}${zoom('icon.svg', 32, 3)}</div><figcaption>16 / 24 / 32 px, true pixels, enlarged</figcaption></figure>
  </div>
  <div class="row">
    <figure class="l"><img src="${lock}" style="height:80px"><figcaption>lockup, mark 80 px tall</figcaption></figure>
    <figure class="l"><img src="${lock}" style="height:28px"><figcaption>lockup, 28 px</figcaption></figure>
    <figure><div class="row tight"><img src="${mk}" width="96"><img src="${mono}" width="96"><img src="${mk}" width="48"></div><figcaption>mark: colour / one colour / colour at 48</figcaption></figure>
  </div>
</section>`
}
const preview = `<!doctype html><meta charset="utf-8"><title>NoemaBoard preview</title><style>${css}
body{width:1560px}
section{padding:28px 40px 36px;display:flex;flex-direction:column;gap:30px}
header{display:flex;justify-content:space-between;text-transform:uppercase;letter-spacing:.08em;opacity:.55}
.row{display:flex;align-items:flex-end;gap:44px}.row.tight{gap:18px}
.l{align-items:flex-start}
</style>${band('light')}${band('dark')}${script()}`
fs.writeFileSync(path.join(here, 'preview.html'), preview)

// ------------------------------------------------------------------ pixels.html (small sizes, enlarged, three backgrounds)
const BGS = [PAL.light, '#ffffff', PAL.dark]
const pxSection = (bg) => {
  const fg = bg === PAL.dark ? '#e7e9ec' : PAL.ink
  const mk = bg === PAL.dark ? 'mark-dark.svg' : 'mark.svg'
  const ones = (file, sizes) => sizes.map((s) => `<img src="${file}" width="${s}" height="${s}">`).join('')
  return `<section style="background:${bg};color:${fg}"><div class="lab">${bg}</div>
  <div class="row">${[16, 24, 32].map((s) => zoom('icon.svg', s, s === 16 ? 8 : s === 24 ? 6 : 5, bg)).join('')}${zoom('icon.svg', 48, 3, bg)}${zoom('icon.svg', 64, 2, bg)}
    <div class="ones">${ones('icon.svg', [16, 24, 32, 48, 64])}</div><div class="cap">icon.svg 16 / 24 / 32 / 48 / 64 (x8, x6, x5, x3, x2) and 1:1</div></div>
  <div class="row">${[16, 24, 32].map((s) => zoom('favicon.svg', s, s === 16 ? 8 : s === 24 ? 6 : 5, bg)).join('')}
    <div class="ones">${ones('favicon.svg', [16, 24, 32])}</div>
    ${zoom('icon.svg', 26, 5, bg)}<div class="hdr"><img src="icon.svg" width="26" height="26">NoemaBoard</div>
    <div class="cap">favicon.svg 16 / 24 / 32; app header 26 px</div></div>
  <div class="row">${[16, 24, 32, 48].map((s) => zoom(mk, s, s <= 24 ? 5 : 3, bg)).join('')}<div class="ones">${ones(mk, [16, 24, 32, 48])}</div><div class="cap">transparent mark (rule: 48 px and up)</div></div>
</section>`
}
const pixels = `<!doctype html><meta charset="utf-8"><title>NoemaBoard pixels</title><style>${css}
body{width:1440px}
section{padding:14px 20px 18px;display:flex;flex-direction:column;gap:14px}
.lab{font-size:11px;opacity:.55;text-transform:uppercase;letter-spacing:.08em}
.row{display:flex;align-items:flex-end;gap:14px}
.ones{display:flex;align-items:flex-end;gap:10px;margin:0 10px}
.cap{font-size:11px;opacity:.55;align-self:center}
.hdr{display:flex;align-items:center;gap:8px;height:38px;padding:0 6px;font:600 17px Georgia,serif}
.hdr img{border-radius:7px}
</style>${BGS.map(pxSection).join('')}${script()}`
fs.writeFileSync(path.join(here, 'pixels.html'), pixels)

// ------------------------------------------------------------------ social.html (avatar crop, banners with overlap zones)
const social = `<!doctype html><meta charset="utf-8"><title>NoemaBoard social</title><style>${css}
body{width:1640px;background:#fff;color:${PAL.ink};padding:24px;box-sizing:border-box}
.row{display:flex;gap:36px;align-items:flex-end;margin-bottom:28px}
.av{border-radius:50%;display:block}
.bn{position:relative;display:inline-block}
.bn img{display:block}
.zone{position:absolute;border:2px dashed #e5484d;border-radius:50%;background:rgba(229,72,77,.08)}
</style>
<div class="row">
  <figure><img src="social/avatar-400.png" width="400"><figcaption>avatar-400.png (square)</figcaption></figure>
  <figure><img class="av" src="social/avatar-400.png" width="200"><figcaption>circle crop 200</figcaption></figure>
  <figure><img class="av" src="social/avatar-400.png" width="48"><figcaption>48</figcaption></figure>
  <figure><img class="av" src="social/avatar-400.png" width="32"><figcaption>32</figcaption></figure>
  <figure style="background:#000;padding:10px"><img class="av" src="social/avatar-400.png" width="120"><figcaption style="color:#fff">on black</figcaption></figure>
  <figure><div class="row" style="margin:0;gap:20px"><img src="apple-touch-icon.png" width="180" style="border-radius:40px"><img src="icon-512.png" width="180"></div><figcaption>apple-touch-icon (iOS mask) / icon-512</figcaption></figure>
</div>
<figure style="align-items:flex-start"><div class="bn"><img src="social/banner-x-1500x500.png" width="1500"><div class="zone" style="left:40px;top:333px;width:334px;height:334px"></div></div><figcaption>X header 1500 x 500, dashed: avatar overlap zone (approx.)</figcaption></figure>
<figure style="align-items:flex-start;margin-top:24px"><div class="bn"><img src="social/banner-linkedin-1584x396.png" width="1584"><div class="zone" style="left:48px;top:200px;width:300px;height:300px"></div></div><figcaption>LinkedIn banner 1584 x 396, dashed: profile photo zone (approx.)</figcaption></figure>
`
fs.writeFileSync(path.join(here, 'social.html'), social)

// ------------------------------------------------------------------ raster jobs (PNG + ICO deliverables)
const icoSizes = (sizes) => sizes.map((size) => ({ svg: 'icon.svg', size }))
const jobs = [
  { svg: 'icon-square.svg', w: 400, h: 400, out: 'social/avatar-400.png' },
  { svg: 'social/banner-x.svg', w: 1500, h: 500, out: 'social/banner-x-1500x500.png' },
  { svg: 'social/banner-linkedin.svg', w: 1584, h: 396, out: 'social/banner-linkedin-1584x396.png' },
  { svg: 'icon-square.svg', w: 180, h: 180, out: 'apple-touch-icon.png' },
  { svg: 'icon.svg', w: 512, h: 512, out: 'icon-512.png' },
  { svg: 'icon.svg', w: 1024, h: 1024, out: 'icon-1024.png' },
  { svg: 'icon-macos.svg', w: 1024, h: 1024, out: 'icon-macos-1024.png' },
  { ico: icoSizes([16, 24, 32, 48, 64, 128, 256]), out: 'icon.ico' },
  { ico: [16, 32, 48].map((size) => ({ svg: 'favicon.svg', size })), out: 'favicon.ico' },
]
fs.writeFileSync(path.join(here, 'raster-jobs.json'), JSON.stringify(jobs, null, 1))
console.log('sheets + raster-jobs.json written')
