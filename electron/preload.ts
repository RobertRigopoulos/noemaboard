/**
 * Sandboxed preload: exposes the DesktopAPI (src/lib/desktop.ts) as `window.desktop`.
 * Bundled into one CommonJS file that only requires 'electron' (sandbox requirement).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopAPI, DesktopSettings, LinkPreview, PrintToPdfOptions } from '../src/lib/desktop'
import { APP_VERSION_ARG, IPC } from './ipcChannels'

const versionArg = process.argv.find((a) => a.startsWith(APP_VERSION_ARG))
const appVersion = versionArg ? versionArg.slice(APP_VERSION_ARG.length) : '0.0.0'
const platform = (['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'linux') as DesktopAPI['platform']

const openUrlListeners = new Set<(url: string) => void>()

ipcRenderer.on(IPC.openUrl, (_event: IpcRendererEvent, url: unknown) => {
  if (typeof url !== 'string' || url.length > 8192) return
  for (const cb of openUrlListeners) {
    try {
      cb(url)
    } catch (err) {
      console.error('[desktop] open-url listener failed', err)
    }
  }
})

const api: DesktopAPI = {
  platform,
  appVersion,

  fetchLinkPreview(url: string): Promise<LinkPreview | null> {
    if (typeof url !== 'string') return Promise.resolve(null)
    return ipcRenderer.invoke(IPC.fetchLinkPreview, url)
  },

  fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    if (typeof url !== 'string') return Promise.resolve(null)
    return ipcRenderer.invoke(IPC.fetchImage, url)
  },

  onOpenUrl(cb: (url: string) => void): () => void {
    if (typeof cb !== 'function') return () => {}
    // Wrap so the same callback can subscribe twice and unsubscribe independently.
    const wrapped = (url: string) => cb(url)
    openUrlListeners.add(wrapped)
    ipcRenderer.send(IPC.openUrlListeners, openUrlListeners.size)
    return () => {
      if (openUrlListeners.delete(wrapped)) ipcRenderer.send(IPC.openUrlListeners, openUrlListeners.size)
    }
  },

  takePendingOpenUrl(): Promise<string | null> {
    return ipcRenderer.invoke(IPC.takePendingOpenUrl)
  },

  getSettings(): Promise<DesktopSettings> {
    return ipcRenderer.invoke(IPC.getSettings)
  },

  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings> {
    return ipcRenderer.invoke(IPC.setSettings, patch)
  },

  saveFile(defaultName: string, data: Uint8Array, filters?: { name: string; extensions: string[] }[]): Promise<boolean> {
    if (!(data instanceof Uint8Array)) return Promise.reject(new TypeError('saveFile expects a Uint8Array'))
    return ipcRenderer.invoke(IPC.saveFile, String(defaultName ?? ''), data, filters)
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC.openExternal, url)
  },

  async printToPdf(opts: PrintToPdfOptions): Promise<Uint8Array | null> {
    if (!opts || typeof opts !== 'object') return null
    try {
      const bytes: unknown = await ipcRenderer.invoke(IPC.printToPdf, { pageSize: opts.pageSize, landscape: opts.landscape })
      return bytes instanceof Uint8Array ? bytes : null
    } catch (err) {
      console.error('[desktop] printToPdf failed', err)
      return null
    }
  },
}

contextBridge.exposeInMainWorld('desktop', api)

// Electron turns mouse back/forward buttons into 'app-command' only on Windows and Linux (see
// window.ts); on macOS the page sees them as buttons 3 and 4. Only there, so nothing navigates twice.
if (platform === 'darwin') {
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) history.back()
    else if (e.button === 4) history.forward()
  })
}
