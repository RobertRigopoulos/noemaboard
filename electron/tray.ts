/** System tray icon used while the window is hidden (boards keep syncing in the background). */
import { app, Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { TRAY_16, TRAY_24, TRAY_32, TRAY_TEMPLATE_16, TRAY_TEMPLATE_32 } from './icons'

export interface TrayActions {
  open(): void
  quit(): void
  isKeepOnline(): boolean
  setKeepOnline(on: boolean): void
}

function trayImage(): NativeImage {
  const img = nativeImage.createEmpty()
  if (process.platform === 'darwin') {
    img.addRepresentation({ scaleFactor: 1, dataURL: TRAY_TEMPLATE_16 })
    img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_TEMPLATE_32 })
    img.setTemplateImage(true)
  } else if (process.platform === 'linux') {
    // Linux panels scale icons themselves; give them the sharpest source.
    img.addRepresentation({ scaleFactor: 1, dataURL: TRAY_32 })
  } else {
    img.addRepresentation({ scaleFactor: 1, dataURL: TRAY_16 })
    img.addRepresentation({ scaleFactor: 1.5, dataURL: TRAY_24 })
    img.addRepresentation({ scaleFactor: 2, dataURL: TRAY_32 })
  }
  return img
}

export class TrayController {
  private tray: Tray | null = null
  private hintShown = false
  /** Shown in the tooltip and menu while something keeps boards from syncing. */
  private problem: string | null = null

  constructor(private readonly actions: TrayActions) {}

  get active(): boolean {
    return this.tray !== null
  }

  ensure(): void {
    if (this.tray) {
      this.refresh()
      return
    }
    try {
      this.tray = new Tray(trayImage())
    } catch (err) {
      console.warn('[tray] not available', err)
      return
    }
    this.applyToolTip()
    // Windows/Linux: a click on the icon opens the window; macOS shows the menu instead.
    if (process.platform !== 'darwin') this.tray.on('click', () => this.actions.open())
    this.refresh()
  }

  /** Reports (or clears, with null) a problem such as a window that keeps crashing. */
  setProblem(text: string | null): void {
    if (this.problem === text) return
    this.problem = text
    this.applyToolTip()
    this.refresh()
  }

  private applyToolTip(): void {
    const name = app.getName()
    this.tray?.setToolTip(this.problem ? `${name}: ${this.problem}` : name)
  }

  refresh(): void {
    if (!this.tray) return
    const name = app.getName()
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...(this.problem ? [{ label: this.problem, enabled: false }, { type: 'separator' as const }] : []),
        { label: `Open ${name}`, click: () => this.actions.open() },
        { type: 'separator' },
        {
          label: 'Keep boards online when window is closed',
          type: 'checkbox',
          checked: this.actions.isKeepOnline(),
          click: (item) => this.actions.setKeepOnline(item.checked),
        },
        { type: 'separator' },
        { label: `Quit ${name}`, click: () => this.actions.quit() },
      ]),
    )
  }

  /** One-time hint (Windows) so people know where the app went after closing the window. */
  showHiddenHint(): void {
    if (!this.tray || this.hintShown || process.platform !== 'win32') return
    this.hintShown = true
    try {
      this.tray.displayBalloon({
        iconType: 'info',
        title: `${app.getName()} is still running`,
        content: 'Your boards stay online for teammates. Use the tray icon to open or quit.',
      })
    } catch {
      // Balloons can be disabled by policy; nothing to do.
    }
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
