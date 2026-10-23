/** The main window: hardened webPreferences, remembered bounds, theme-matched background. */
import { app, BrowserWindow, nativeImage, nativeTheme, screen } from 'electron'
import { APP_VERSION_ARG } from './ipcChannels'
import { WINDOW_ICON_128 } from './icons'
import { DEFAULT_SIZE, loadWindowState, MIN_SIZE, saveWindowState } from './windowState'

// Same values as --canvas-bg in src/styles/base.css, so there is no white flash on startup.
const BG_LIGHT = '#eceef1'
const BG_DARK = '#17191c'

export interface MainWindowOptions {
  preload: string
  stateFile: string
  /** Keep hidden after load (launched at login, smoke test). */
  startHidden: boolean
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const workAreas = screen.getAllDisplays().map((d) => d.workArea)
  const state = loadWindowState(opts.stateFile, workAreas)

  const win = new BrowserWindow({
    ...(state.bounds ?? DEFAULT_SIZE),
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: app.getName(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT,
    // Windows/macOS take the icon from the app bundle; Linux needs it on the window.
    ...(process.platform === 'linux' ? { icon: nativeImage.createFromDataURL(WINDOW_ICON_128) } : {}),
    webPreferences: {
      preload: opts.preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep timers and sync running while minimized or hidden in the tray.
      backgroundThrottling: false,
      spellcheck: true,
      webviewTag: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      additionalArguments: [`${APP_VERSION_ARG}${app.getVersion()}`],
    },
  })

  let firstShow = true
  const showFirstTime = () => {
    if (!firstShow) return
    firstShow = false
    if (state.maximized) win.maximize()
  }
  win.on('show', showFirstTime)
  win.once('ready-to-show', () => {
    if (!opts.startHidden) win.show()
  })

  let saveTimer: NodeJS.Timeout | undefined
  const save = () => {
    clearTimeout(saveTimer)
    if (win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return
    saveWindowState(opts.stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized() })
  }
  const saveSoon = () => {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, 600)
  }
  // Mouse buttons 4/5 on Windows and Linux (macOS never emits app-command: the preload handles them
  // there). Keyboard back/forward (Mod+[ / Mod+] with nothing selected) is handled by the page.
  win.on('app-command', (_event, command) => {
    if (win.isDestroyed()) return
    const history = win.webContents.navigationHistory
    if (command === 'browser-backward' && history.canGoBack()) history.goBack()
    else if (command === 'browser-forward' && history.canGoForward()) history.goForward()
  })

  win.on('resize', saveSoon)
  win.on('move', saveSoon)
  win.on('maximize', saveSoon)
  win.on('unmaximize', saveSoon)
  win.on('close', save)

  return win
}

export function revealWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
  if (process.platform === 'darwin') app.focus({ steal: true })
}
