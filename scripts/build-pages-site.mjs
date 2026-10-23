#!/usr/bin/env node
/**
 * Builds a copy of the front page (site/) for a second host, e.g. GitHub Pages, into pages-dist/.
 * The app itself stays on the main host: "Open app" links point to APP_URL, and the page's own
 * address (canonical, og:url, og:image) becomes SITE_URL so link previews load from this host.
 *
 *   SITE_URL=https://you.github.io/noemaboard/ APP_URL=https://app.example.workers.dev/app/ \
 *     node scripts/build-pages-site.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const OUT = path.join(ROOT, 'pages-dist')
const MAIN_HOST = 'https://app.noemaboard.workers.dev/'
const EXCLUDE = new Set(['og.html'])

const withSlash = (u) => u.replace(/\/?$/, '/')
const SITE_URL = withSlash(process.env.SITE_URL || '')
const APP_URL = withSlash(process.env.APP_URL || `${MAIN_HOST}app/`)
if (!/^https:\/\//.test(SITE_URL)) {
  console.error('build-pages-site: set SITE_URL to the https address this copy is served from.')
  process.exit(1)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.cpSync(SITE, OUT, { recursive: true, filter: (src) => !EXCLUDE.has(path.relative(SITE, src)) })

const indexPath = path.join(OUT, 'index.html')
let html = fs.readFileSync(indexPath, 'utf8')
html = html.replaceAll('href="./app/"', `href="${APP_URL}"`)
// Page identity and preview image come from this host; the invite-link example text stays as is.
html = html.replaceAll(`"${MAIN_HOST}"`, `"${SITE_URL}"`).replaceAll(`"${MAIN_HOST}og.png"`, `"${SITE_URL}og.png"`)
fs.writeFileSync(indexPath, html)
// GitHub Pages runs Jekyll unless told not to, which would hide files and folders starting with _.
fs.writeFileSync(path.join(OUT, '.nojekyll'), '')

console.log(`build-pages-site: ${path.relative(ROOT, OUT)}/ for ${SITE_URL} (app at ${APP_URL})`)
