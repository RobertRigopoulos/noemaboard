/**
 * Electron main process for NoemaBoard: a thin, hardened shell around the web app.
 *
 * - Serves the renderer from app://bundle/ (secure context with IndexedDB, WebCrypto, WebRTC).
 *   NEVER change the scheme, host, appId or productName: they key the IndexedDB origin and the
 *   userData folder, i.e. where every user's boards are stored.
 * - Handles noema:// invite links (single instance, cold start, macOS open-url).
 * - Optional tray mode so a teammate's computer keeps shared boards online.
 */
import { app, BrowserWindow, Menu, Notification, session, shell, type WebContents } from 'electron'
import os from 'node:os'
import path from 'node:path'
import { APP_NAME, PROTOCOL } from '../src/config'
import type { DesktopSettings } from '../src/lib/desktop'
import { handleAppScheme, registerAppSchemePrivileges } from './appProtocol'
import { applyOpenAtLogin, launchedAtLogin } from './autostart'
import { APP_INDEX_URL, APP_ORIGIN } from './bundle'
import { attachContextMenu } from './contextMenu'
import { DeepLinkInbox, findDeepLink, normalizeDeepLink } from './deeplink'
import { registerIpc } from './ipc'
import { buildAppMenu, PROJECT_URL } from './menu'
import { isPermissionAllowed } from './permissions'
import { RecoverySchedule, REPORT_AFTER_FAILURES, shouldRecoverRenderer, STABLE_AFTER_MS } from './rendererRecovery'
import { SettingsStore } from './settings'
import { runSmokeTest, SMOKE_ARG } from './smoke'
import { TrayController } from './tray'
import { initAutoUpdates } from './updater'
import { isAllowedExternalUrl } from './validate'
import { createMainWindow, revealWindow } from './window'

const isSmokeTest = process.argv.includes(SMOKE_ARG)
const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null

if (isSmokeTest) {
  // Throwaway profile: never touch real boards, never collide with a running instance.
  app.setPath('userData', path.join(os.tmpdir(), `noema-smoke-${process.pid}`))
}
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'org.noema.app' : process.execPath)

app.enableSandbox()
registerAppSchemePrivileges()

const inbox = new DeepLinkInbox()
let mainWindow: BrowserWindow | null = null
let quitting = false

const settings = new SettingsStore(path.join(app.getPath('userData'), 'settings.json'))

const tray = new TrayController({
  open: () => showWindow(),
  quit: () => {
    quitting = true
    app.quit()
  },
  isKeepOnline: () => settings.get().closeToTray,
  setKeepOnline: (on) => updateSettings({ closeToTray: on }),
})

function isTrustedUrl(url: string): boolean {
  if (url.startsWith(`${APP_ORIGIN}/`)) return true
  return !!devOrigin && (url === devOrigin || url.startsWith(`${devOrigin}/`))
}

function receiveDeepLink(raw: unknown): void {
  const url = normalizeDeepLink(raw, PROTOCOL)
  if (url) inbox.push(url)
  if (app.isReady()) showWindow()
}

// macOS delivers links through this event, possibly before 'ready'.
app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveDeepLink(url)
})

const hasLock = isSmokeTest || app.requestSingleInstanceLock()
if (!hasLock) {
  // Another instance is running; it receives our argv through 'second-instance'.
  app.quit()
} else {
  const coldStartLink = findDeepLink(process.argv, PROTOCOL)
  if (coldStartLink) inbox.push(coldStartLink)

  app.on('second-instance', (_event, argv) => {
    const link = findDeepLink(argv, PROTOCOL)
    if (link) receiveDeepLink(link)
    else showWindow()
  })

  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      console.error('[main] failed to start', err)
      app.exit(1)
    })
}

function updateSettings(patch: Partial<DesktopSettings>): DesktopSettings {
  const prev = settings.get()
  const next = settings.set(patch)
  if (patch.openAtLogin !== undefined && patch.openAtLogin !== prev.openAtLogin) {
    try {
      applyOpenAtLogin(next.openAtLogin)
    } catch (err) {
      console.warn('[main] could not update login item', err)
    }
  }
  syncTray()
  return next
}

/** The tray exists while it is the only way back to a hidden window, or when tray mode is on. */
function syncTray(): void {
  const hidden = !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()
  if (settings.get().closeToTray || hidden) tray.ensure()
  else tray.destroy()
}

function registerProtocolClient(): void {
  try {
    if (process.defaultApp) {
      // Dev: `electron <app path>` must be relaunched with the same app path.
      if (process.argv[1]) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])])
    } else if (process.env.PORTABLE_EXECUTABLE_FILE) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.env.PORTABLE_EXECUTABLE_FILE)
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL)
    }
  } catch (err) {
    console.warn('[main] could not register the invite link protocol', err)
  }
}

function hardenSession(): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    callback(isPermissionAllowed(permission, { trusted: isTrustedUrl(details.requestingUrl), isMainFrame: details.isMainFrame }))
  })
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return isPermissionAllowed(permission, { trusted: isTrustedUrl(`${requestingOrigin}/`) })
  })
  ses.setDevicePermissionHandler(() => false)
}

/** External links open in the default browser, at a bounded rate (embedded iframes can call window.open). */
let externalOpens: number[] = []
function openExternalSafely(url: string): void {
  if (!isAllowedExternalUrl(url)) return
  const now = Date.now()
  externalOpens = externalOpens.filter((t) => now - t < 3000)
  if (externalOpens.length >= 3) return
  externalOpens.push(now)
  void shell.openExternal(url)
}

function guardWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    openExternalSafely(url)
  })
  contents.on('will-redirect', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  attachContextMenu(contents)
}

function createWindow(startHidden: boolean): BrowserWindow {
  const win = createMainWindow({
    preload: path.join(__dirname, '../preload/index.cjs'),
    stateFile: path.join(app.getPath('userData'), 'window.json'),
    startHidden,
  })

  win.on('close', (event) => {
    if (quitting || isSmokeTest || !settings.get().closeToTray) return
    // Tray mode: hide instead of closing so the renderer (and P2P sync) keeps running.
    event.preventDefault()
    win.hide()
    tray.ensure()
    tray.showHiddenHint()
  })
  win.on('show', syncTray)
  win.on('hide', syncTray)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    inbox.setDelivery(null)
  })

  // Links can only be delivered while the current page has a listener; a reload drops it.
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) inbox.setDelivery(null)
  })
  // Windows shutdown/logoff must not be blocked by the hide-to-tray close handler.
  win.on('session-end', () => {
    quitting = true
  })
  watchRenderer(win)

  if (isSmokeTest) runSmokeTest(win)

  void win.loadURL(devServerUrl ?? APP_INDEX_URL)
  return win
}

const RENDERER_PROBLEM = 'The window keeps crashing, so boards are not syncing. Retrying…'

/**
 * Brings the page back whenever the renderer dies (it runs all P2P and relay sync), with a growing
 * delay so a crash loop never spins, and tells people when it keeps failing.
 */
function watchRenderer(win: BrowserWindow): void {
  const recovery = new RecoverySchedule()
  let timer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let losses = 0
  let notified = false

  win.webContents.on('render-process-gone', (_e, details) => {
    inbox.setDelivery(null)
    console.error('[main] renderer gone:', details.reason, details.exitCode)
    losses++
    if (stableTimer) clearTimeout(stableTimer)
    stableTimer = null
    if (isSmokeTest || timer || !shouldRecoverRenderer({ quitting, destroyed: win.isDestroyed() })) return
    const delay = recovery.crashed(Date.now())
    if (recovery.consecutiveFailures >= REPORT_AFTER_FAILURES) {
      tray.setProblem(RENDERER_PROBLEM)
      if (!notified && !win.isVisible()) {
        notified = true
        try {
          if (Notification.isSupported()) new Notification({ title: APP_NAME, body: RENDERER_PROBLEM }).show()
        } catch {
          // notifications can be disabled by policy
        }
      }
    }
    timer = setTimeout(() => {
      timer = null
      if (quitting || win.isDestroyed()) return
      recovery.reloaded(Date.now())
      win.webContents.reload()
    }, delay)
  })
  // The problem notice goes away once the page has stayed up for a while.
  win.webContents.on('did-finish-load', () => {
    if (stableTimer) clearTimeout(stableTimer)
    const seen = losses
    stableTimer = setTimeout(() => {
      stableTimer = null
      if (losses !== seen) return
      notified = false
      tray.setProblem(null)
    }, STABLE_AFTER_MS)
  })
  win.on('closed', () => {
    if (timer) clearTimeout(timer)
    if (stableTimer) clearTimeout(stableTimer)
    timer = stableTimer = null
  })
}

function showWindow(): void {
  if (!app.isReady() || isSmokeTest) return
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow(false)
  revealWindow(mainWindow)
}

async function start(): Promise<void> {
  hardenSession()
  handleAppScheme(path.join(__dirname, '../renderer'))
  app.on('web-contents-created', (_e, contents) => guardWebContents(contents))
  registerIpc({ isTrustedUrl, inbox, getSettings: () => settings.get(), updateSettings })

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'MIT License · NoemaBoard contributors',
    website: PROJECT_URL,
  })
  Menu.setApplicationMenu(buildAppMenu({ onAbout: () => app.showAboutPanel() }))

  const startHidden = isSmokeTest || launchedAtLogin(process.argv)
  if (!isSmokeTest) {
    registerProtocolClient()
    // Re-apply so the login item follows the app if it was moved or updated.
    if (settings.get().openAtLogin) {
      try {
        applyOpenAtLogin(true)
      } catch (err) {
        console.warn('[main] could not refresh login item', err)
      }
    }
  }

  mainWindow = createWindow(startHidden)
  if (startHidden && !isSmokeTest) tray.ensure()
  else syncTray()

  if (!isSmokeTest) {
    void initAutoUpdates({
      // An AppImage update installs under a new (versioned) file name and deletes the old one:
      // point "Open at login" at the new file, or the next login starts nothing.
      onAppImageMoved: (file) => {
        if (!settings.get().openAtLogin) return
        try {
          applyOpenAtLogin(true, { exe: file })
        } catch (err) {
          console.warn('[main] could not update login item after the update', err)
        }
      },
    })
  }
}

app.on('activate', () => showWindow())

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // macOS apps stay in the dock; elsewhere closing the last window quits (unless hidden to tray,
  // in which case the window was not closed at all).
  if (process.platform !== 'darwin' || isSmokeTest) app.quit()
})
