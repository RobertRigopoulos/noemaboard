/**
 * `--smoke-test`: headless self-check used by CI and release verification. Loads the real
 * renderer, verifies the platform features the app depends on, prints one JSON line to stdout
 * and exits 0 (all required checks passed) or 1.
 */
import { app, nativeImage, type BrowserWindow } from 'electron'
import { TRAY_16, TRAY_TEMPLATE_16, WINDOW_ICON_128 } from './icons'

export const SMOKE_ARG = '--smoke-test'
const TIMEOUT_MS = 45_000
const SETTLE_MS = 2_000

/**
 * Runs inside the page. Required checks are booleans named in REQUIRED below. With
 * NOEMA_SMOKE_NETWORK=1 a real link preview is fetched too (informational only).
 */
const pageChecks = (network: boolean) => `(async () => {
  const r = {}
  r.href = location.href
  r.secureContext = window.isSecureContext === true
  r.desktopBridge = typeof window.desktop === 'object' && window.desktop !== null
  r.platform = window.desktop && window.desktop.platform
  r.appVersion = window.desktop && window.desktop.appVersion
  r.cryptoSubtle = !!(globalThis.crypto && crypto.subtle && typeof crypto.subtle.digest === 'function')
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('noema'))
    r.sha256 = d.byteLength === 32
  } catch (e) { r.sha256 = false }
  r.indexedDB = await new Promise((resolve) => {
    try {
      const req = indexedDB.open('noema-smoke-test', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('s')
      req.onsuccess = () => { req.result.close(); indexedDB.deleteDatabase('noema-smoke-test'); resolve(true) }
      req.onerror = () => resolve(false)
      req.onblocked = () => resolve(false)
    } catch (e) { resolve(false) }
  })
  r.rtcPeerConnection = typeof RTCPeerConnection === 'function'
  try {
    const pc = new RTCPeerConnection()
    pc.createDataChannel('smoke')
    const offer = await pc.createOffer()
    r.rtcOffer = typeof offer.sdp === 'string' && offer.sdp.includes('application')
    pc.close()
  } catch (e) { r.rtcOffer = false }
  try {
    const s = await window.desktop.getSettings()
    r.ipcSettings = typeof s === 'object' && typeof s.closeToTray === 'boolean' && typeof s.openAtLogin === 'boolean'
  } catch (e) { r.ipcSettings = false }
  try { r.ssrfBlocked = (await window.desktop.fetchLinkPreview('http://127.0.0.1/')) === null } catch (e) { r.ssrfBlocked = false }
  try { r.pendingOpenUrl = await window.desktop.takePendingOpenUrl() } catch (e) { r.pendingOpenUrl = 'error' }
  if (${network}) {
    try {
      const p = await window.desktop.fetchLinkPreview('https://example.com/')
      r.networkPreview = p ? p.title : null
      const img = await window.desktop.fetchImage('https://www.google.com/favicon.ico')
      r.networkImage = img ? img.mime + ' ' + img.bytes.byteLength + 'B' : null
    } catch (e) { r.networkPreview = 'error: ' + e }
  }
  const root = document.getElementById('root')
  r.rendererMounted = !!root && root.childElementCount > 0
  return r
})()`

const REQUIRED = ['secureContext', 'desktopBridge', 'cryptoSubtle', 'sha256', 'indexedDB', 'rtcPeerConnection', 'rtcOffer', 'ipcSettings', 'ssrfBlocked', 'icons']

/** Main-process checks that need no page. */
function shellChecks(): Record<string, unknown> {
  const icons = [TRAY_16, TRAY_TEMPLATE_16, WINDOW_ICON_128].every((d) => !nativeImage.createFromDataURL(d).isEmpty())
  return { icons, packaged: app.isPackaged }
}

export function runSmokeTest(win: BrowserWindow): void {
  const consoleErrors: string[] = []
  let finished = false

  const finish = (result: Record<string, unknown>) => {
    if (finished) return
    finished = true
    clearTimeout(timer)
    process.stdout.write(`${JSON.stringify({ ...result, consoleErrors })}\n`, () => app.exit(result.ok ? 0 : 1))
  }

  const timer = setTimeout(() => finish({ ok: false, error: 'timeout waiting for the renderer' }), TIMEOUT_MS)

  win.webContents.on('console-message', (event) => {
    if (event.level === 'error' && consoleErrors.length < 20) consoleErrors.push(event.message.slice(0, 400))
  })
  win.webContents.on('render-process-gone', (_e, details) => finish({ ok: false, error: `renderer gone: ${details.reason}` }))
  win.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (isMainFrame) finish({ ok: false, error: `did-fail-load ${code} ${description} ${url}` })
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const network = process.env.NOEMA_SMOKE_NETWORK === '1'
        const page = (await win.webContents.executeJavaScript(pageChecks(network), true)) as Record<string, unknown>
        const checks = { ...shellChecks(), ...page }
        const failed = REQUIRED.filter((k) => checks[k] !== true)
        finish({ ok: failed.length === 0, failed, checks, electron: process.versions.electron, chrome: process.versions.chrome })
      } catch (err) {
        finish({ ok: false, error: String(err) })
      }
    }, SETTLE_MS)
  })
}
