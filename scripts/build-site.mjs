#!/usr/bin/env node
/**
 * Builds everything that is deployed to https://app.noemaboard.workers.dev/ into deploy-dist/:
 *
 *   deploy-dist/index.html, styles.css, main.js, og.png, assets/...   the front page (site/)
 *   deploy-dist/app/                                                  the web app (Vite build)
 *
 * Usage (from anywhere; paths are resolved from this file):
 *   node scripts/build-site.mjs                 build the app, then copy the front page
 *   node scripts/build-site.mjs --site-only     copy the front page only (keeps an existing deploy-dist/app)
 *   node scripts/build-site.mjs --out <dir>     write somewhere else than deploy-dist/
 *
 * The app is built with `--mode cloudflare` (reads .env.cloudflare: same-origin sync relay at /relay).
 * It uses relative asset paths and works out its own address at runtime, so it runs from /app/.
 * site/og.html is the source of og.png and is not deployed. No dependencies beyond Node itself.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const APP_DIR = 'app'
/** Site files that are sources for other files, not pages to publish (paths relative to site/). */
const EXCLUDE = new Set(['og.html'])

const args = process.argv.slice(2)
const siteOnly = args.includes('--site-only')
const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : null
const OUT = path.resolve(ROOT, outArg || 'deploy-dist')

function fail(msg) {
  console.error(`build-site: ${msg}`)
  process.exit(1)
}

function rel(p) {
  return path.relative(ROOT, p) || '.'
}

// ---------------------------------------------------------------------------
// Checks

if (!fs.existsSync(path.join(SITE, 'index.html'))) fail(`${rel(SITE)}/index.html is missing.`)
if (fs.existsSync(path.join(SITE, APP_DIR))) fail(`${rel(SITE)}/${APP_DIR} exists and would collide with the web app.`)
// The output folder is emptied (except app/), so never let it be the project, a parent of it, or site/.
const isInside = (child, parent) => {
  const r = path.relative(parent, child)
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
}
if (isInside(ROOT, OUT)) fail(`refusing to write to ${OUT}: it is the project folder or one of its parents.`)
if (isInside(OUT, SITE)) fail(`refusing to write to ${OUT}: it is inside site/.`)
if (fs.existsSync(path.join(OUT, 'package.json'))) fail(`refusing to write to ${OUT}: it looks like a project folder.`)

// ---------------------------------------------------------------------------
// 1. The web app -> <out>/app

if (siteOnly) {
  console.log('build-site: --site-only, skipping the app build')
} else {
  const outDir = path.relative(ROOT, path.join(OUT, APP_DIR)).split(path.sep).join('/')
  const viteArgs = ['vite', 'build', '--mode', 'cloudflare', '--outDir', outDir, '--emptyOutDir']
  console.log(`build-site: npx ${viteArgs.join(' ')}`)
  const res = spawnSync('npx', viteArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    // npx is npx.cmd on Windows, which needs a shell to start. The arguments are fixed strings.
    shell: process.platform === 'win32',
  })
  if (res.error) fail(`could not start vite: ${res.error.message}`)
  if (res.status !== 0) fail(`vite build failed (exit ${res.status}).`)
  if (!fs.existsSync(path.join(OUT, APP_DIR, 'index.html'))) fail(`vite did not produce ${rel(OUT)}/${APP_DIR}/index.html.`)
}

// ---------------------------------------------------------------------------
// 2. The front page -> <out>/ (everything except app/ is replaced)

fs.mkdirSync(OUT, { recursive: true })
for (const entry of fs.readdirSync(OUT)) {
  if (entry === APP_DIR) continue
  fs.rmSync(path.join(OUT, entry), { recursive: true, force: true })
}

let files = 0
let bytes = 0
function copyDir(from, to, prefix = '') {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = prefix + entry.name
    if (entry.name.startsWith('.') || EXCLUDE.has(relPath)) continue
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst, relPath + '/')
    else if (entry.isFile()) {
      fs.copyFileSync(src, dst)
      files++
      bytes += fs.statSync(src).size
    }
  }
}
copyDir(SITE, OUT)

// ---------------------------------------------------------------------------
// 3. Sanity checks and summary

const missing = ['index.html', 'styles.css', 'og.png', 'favicon.ico'].filter((f) => !fs.existsSync(path.join(OUT, f)))
if (missing.length) fail(`missing from the output: ${missing.join(', ')}`)
const hasApp = fs.existsSync(path.join(OUT, APP_DIR, 'index.html'))
const shots = fs.existsSync(path.join(OUT, 'assets', 'screenshots'))
  ? fs.readdirSync(path.join(OUT, 'assets', 'screenshots')).filter((f) => f.endsWith('.png'))
  : []

console.log(`build-site: front page -> ${rel(OUT)}/ (${files} files, ${(bytes / 1024).toFixed(0)} KB)`)
console.log(`build-site: app        -> ${rel(OUT)}/${APP_DIR}/ ${hasApp ? '' : '(missing: run without --site-only)'}`)
console.log(`build-site: screenshots: ${shots.length ? shots.join(', ') : 'none (the page shows its drawings instead)'}`)
