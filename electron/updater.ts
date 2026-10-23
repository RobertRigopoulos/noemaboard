/**
 * Auto-update from GitHub Releases (electron-updater). Enabled for the Windows installer and the
 * Linux AppImage only: the portable build has nothing to update in place, .deb is managed by the
 * package manager, and unsigned macOS apps cannot install updates by themselves.
 */
import { app } from 'electron'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export interface AutoUpdateHooks {
  /**
   * The AppImage was replaced by a file with another name (the update's versioned file name; the
   * old file is deleted). Called synchronously while installing, possibly during quit.
   */
  onAppImageMoved?: (file: string) => void
}

export function updatesSupported(): boolean {
  if (!app.isPackaged) return false
  if (process.env.PORTABLE_EXECUTABLE_FILE) return false
  if (process.platform === 'win32') return true
  if (process.platform === 'linux') return !!process.env.APPIMAGE
  return false
}

export async function initAutoUpdates(hooks: AutoUpdateHooks = {}): Promise<void> {
  if (process.platform === 'darwin' && app.isPackaged) {
    console.info('[updater] macOS build is unsigned; new versions are published on GitHub Releases.')
    return
  }
  if (!updatesSupported()) return
  try {
    const { autoUpdater } = await import('electron-updater')
    autoUpdater.logger = {
      info: (m?: unknown) => console.info('[updater]', m),
      warn: (m?: unknown) => console.warn('[updater]', m),
      error: (m?: unknown) => console.warn('[updater]', m),
      debug: () => {},
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    // Offline or GitHub unreachable is normal for a P2P app: log and try again later.
    autoUpdater.on('error', (err) => console.warn('[updater]', err?.message ?? err))
    autoUpdater.on('appimage-filename-updated', (file: string) => {
      console.info('[updater] AppImage installed as', file)
      try {
        hooks.onAppImageMoved?.(file)
      } catch (err) {
        console.warn('[updater] AppImage rename hook failed', err)
      }
    })
    const check = () => {
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => console.warn('[updater] check failed', err))
    }
    setTimeout(check, 15_000)
    setInterval(check, CHECK_EVERY_MS)
  } catch (err) {
    console.warn('[updater] disabled', err)
  }
}
