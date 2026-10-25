#!/usr/bin/env node
/**
 * Builds the copy of the front page (site/) that GitHub Pages serves, into pages-dist/. That copy
 * was the address shared on LinkedIn before NoemaBoard had its own domain, so it stays online:
 *  - its link preview (og:url, og:image) still comes from this host, so posts that use it keep theirs,
 *  - visitors are sent on to the main site (SITE_HOME), keeping the part after # (e.g. #faq),
 *  - "Open app" links point to the app on the main site (APP_URL), for browsers without JavaScript.
 *
 *   SITE_URL=https://you.github.io/noemaboard/ node scripts/build-pages-site.mjs
 *   (optional: SITE_HOME=https://noemaboard.app/ APP_URL=https://noemaboard.app/app/)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const OUT = path.join(ROOT, 'pages-dist')
const MAIN_HOST = 'https://noemaboard.app/'
const EXCLUDE = new Set(['og.html'])

const withSlash = (u) => u.replace(/\/?$/, '/')
const SITE_URL = withSlash(process.env.SITE_URL || '')
const SITE_HOME = withSlash(process.env.SITE_HOME || MAIN_HOST)
const APP_URL = withSlash(process.env.APP_URL || `${MAIN_HOST}app/`)
if (!/^https:\/\//.test(SITE_URL)) {
  console.error('build-pages-site: set SITE_URL to the https address this copy is served from.')
  process.exit(1)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.cpSync(SITE, OUT, { recursive: true, filter: (src) => !EXCLUDE.has(path.relative(SITE, src)) })

const indexPath = path.join(OUT, 'index.html')
let html = fs.readFileSync(indexPath, 'utf8')
const swap = (from, to) => {
  if (!html.includes(from)) {
    console.error(`build-pages-site: site/index.html no longer contains ${from}`)
    process.exit(1)
  }
  html = html.replaceAll(from, to)
}
// The main site's forwarding script (app/moved.js) is not part of this copy: forward right here.
swap('<script src="app/moved.js"></script>', `<script>location.replace(${JSON.stringify(SITE_HOME)} + location.hash)</script>`)
swap('href="./app/"', `href="${APP_URL}"`)
// The preview comes from this host; the canonical address (for search engines) stays the main site.
swap(`<meta property="og:url" content="${MAIN_HOST}">`, `<meta property="og:url" content="${SITE_URL}">`)
swap(`"${MAIN_HOST}og.png"`, `"${SITE_URL}og.png"`)
fs.writeFileSync(indexPath, html)
// GitHub Pages runs Jekyll unless told not to, which would hide files and folders starting with _.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '')

console.log(`build-pages-site: ${path.relative(ROOT, OUT)}/ for ${SITE_URL} (forwards to ${SITE_HOME}, app at ${APP_URL})`)
