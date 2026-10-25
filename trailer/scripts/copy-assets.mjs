#!/usr/bin/env node
/** Copies the brand files the trailer uses (logo, fonts) from the app into public/brand/. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')
const OUT = path.resolve(HERE, '../public/brand')

const FILES = {
  'public/logo-light.svg': 'logo-light.svg',
  'public/logo-mark.svg': 'logo-mark.svg',
  'public/icon.svg': 'icon.svg',
  'site/assets/fonts/inter-latin-wght-normal.woff2': 'inter.woff2',
  'site/assets/fonts/fraunces-latin-opsz-normal.woff2': 'fraunces.woff2',
}

fs.mkdirSync(OUT, { recursive: true })
for (const [from, to] of Object.entries(FILES)) fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to))
console.log(`copy-assets: ${Object.keys(FILES).length} brand files in ${path.relative(process.cwd(), OUT) || '.'}`)
