// Copies the final NoemaBoard assets from design/concept-1 into the app (public/) and the packaging inputs (build/).
// Run after gen.mjs and raster.cjs:  node design/concept-1/publish.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const MAP = {
  'public/icon.svg': 'icon.svg', // app icon, header logo, tray source (npm run icons)
  'public/favicon.svg': 'favicon.svg', // browser tab, pixel-fitted 16/24/32
  'public/favicon.ico': 'favicon.ico', // 16/32/48 fallback for browsers without SVG favicons
  'public/logo-mark.svg': 'mark.svg', // symbol only, transparent (light backgrounds, 48 px and up)
  'public/logo.svg': 'lockup.svg', // lockup, dark text
  'public/logo-light.svg': 'lockup-dark.svg', // lockup for dark backgrounds
  'public/apple-touch-icon.png': 'apple-touch-icon.png', // 180, full bleed (iOS applies its own mask)
  'public/icon-512.png': 'icon-512.png',
  'build/icon.png': 'icon-1024.png', // Linux, and the Windows fallback
  'build/icon.ico': 'icon.ico', // Windows: pixel-fitted 16/24/32 + 48..256
  'build/icon-mac.svg': 'icon-macos.svg', // macOS source (824 tile, shadow), used by build/make-icons.cjs
  'build/icon-mac.png': 'icon-macos-1024.png', // macOS (.icns is made from it by electron-builder)
  'build/tray-template.svg': 'tray-template.svg', // macOS menu-bar template glyph, used by build/make-icons.cjs
}
for (const [to, from] of Object.entries(MAP)) {
  fs.copyFileSync(path.join(here, from), path.join(root, to))
  console.log(`${from} -> ${to}`)
}
