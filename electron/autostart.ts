/** "Open at login": login items on Windows/macOS, an XDG autostart entry on Linux. */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { linuxAutostartEntry } from './autostartEntry'

export const HIDDEN_ARG = '--hidden'

function linuxAutostartFile(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'autostart', 'noema.desktop')
}

/** Executable + leading args that start this same app (dev runs need the app path). */
function launchCommand(): { exe: string; args: string[] } {
  if (process.env.PORTABLE_EXECUTABLE_FILE) return { exe: process.env.PORTABLE_EXECUTABLE_FILE, args: [] }
  if (process.platform === 'linux' && process.env.APPIMAGE) return { exe: process.env.APPIMAGE, args: [] }
  if (process.defaultApp && process.argv[1]) return { exe: process.execPath, args: [path.resolve(process.argv[1])] }
  return { exe: process.execPath, args: [] }
}

export interface OpenAtLoginOverride {
  /** Start this file instead of the running executable (e.g. the AppImage an update just installed). */
  exe?: string
}

export function applyOpenAtLogin(enabled: boolean, override: OpenAtLoginOverride = {}): void {
  const { exe, args } = override.exe ? { exe: override.exe, args: [] } : launchCommand()
  if (process.platform === 'linux') {
    const file = linuxAutostartFile()
    if (enabled) {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, linuxAutostartEntry(app.getName(), exe, [...args, HIDDEN_ARG], 'Keeps your shared boards in sync'))
    } else {
      fs.rmSync(file, { force: true })
    }
    return
  }
  if (process.platform === 'win32') {
    // Windows stores the command line verbatim, so paths with spaces must be quoted.
    app.setLoginItemSettings({ openAtLogin: enabled, path: exe, args: [...args.map((a) => `"${a}"`), HIDDEN_ARG] })
    return
  }
  // macOS ignores args; a login launch is detected with wasOpenedAtLogin instead.
  app.setLoginItemSettings({ openAtLogin: enabled })
}

/** True when this process was started by the OS at login (and should stay in the tray). */
export function launchedAtLogin(argv: readonly string[]): boolean {
  if (argv.includes(HIDDEN_ARG)) return true
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin
    } catch {
      return false
    }
  }
  return false
}
