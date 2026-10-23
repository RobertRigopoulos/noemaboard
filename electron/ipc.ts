/**
 * IPC handlers behind window.desktop. Every call checks that it comes from the top frame of our
 * own renderer (app://bundle/ or the dev server) and validates arguments before acting.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { DesktopSettings, LinkPreview } from '../src/lib/desktop'
import type { DeepLinkInbox } from './deeplink'
import { IPC } from './ipcChannels'
import { createLimiter, defaultUserAgent, fetchImage, fetchLinkPreview, type FetchOptions } from './linkPreview'
import { MAX_URL_LENGTH } from './netGuard'
import { sanitizePatch } from './settings'
import { defaultFiltersFor, isAllowedExternalUrl, isValidSaveData, sanitizeFileName, sanitizeFilters, sanitizePrintOptions } from './validate'

export interface IpcDeps {
  isTrustedUrl(url: string): boolean
  inbox: DeepLinkInbox
  getSettings(): DesktopSettings
  updateSettings(patch: Partial<DesktopSettings>): DesktopSettings
}

const PREVIEW_TTL_OK = 10 * 60 * 1000
const PREVIEW_TTL_FAIL = 60 * 1000
const PREVIEW_CACHE_MAX = 300

export function registerIpc(deps: IpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent): boolean => {
    const frame = event.senderFrame
    return !!frame && frame.parent === null && deps.isTrustedUrl(frame.url)
  }
  const handle = <A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('Blocked IPC call from an untrusted frame')
      return fn(event, ...(args as A))
    })
  }

  const fetchOpts = (): FetchOptions => {
    const locale = app.getLocale()
    return {
      userAgent: defaultUserAgent(process.versions.chrome),
      acceptLanguage: `${/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(locale) ? locale : 'en-US'},en;q=0.8`,
    }
  }
  const limit = createLimiter(6)
  const previewCache = new Map<string, { at: number; value: LinkPreview | null }>()

  handle(IPC.fetchLinkPreview, async (_e, url: unknown) => {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
    const hit = previewCache.get(url)
    if (hit && Date.now() - hit.at < (hit.value ? PREVIEW_TTL_OK : PREVIEW_TTL_FAIL)) return hit.value
    const value = await limit(() => fetchLinkPreview(url, fetchOpts()))
    previewCache.delete(url)
    previewCache.set(url, { at: Date.now(), value })
    if (previewCache.size > PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value!)
    return value
  })

  handle(IPC.fetchImage, async (_e, url: unknown) => {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
    return limit(() => fetchImage(url, fetchOpts()))
  })

  handle(IPC.takePendingOpenUrl, () => deps.inbox.take())

  handle(IPC.getSettings, () => deps.getSettings())

  handle(IPC.setSettings, (_e, patch: unknown) => {
    const clean = sanitizePatch(patch)
    if (!clean) throw new Error('Invalid settings')
    return deps.updateSettings(clean)
  })

  handle(IPC.saveFile, async (event, name: unknown, data: unknown, filters: unknown) => {
    if (!isValidSaveData(data)) throw new Error('saveFile: data must be a Uint8Array of at most 2 GB')
    const fileName = sanitizeFileName(name)
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: sanitizeFilters(filters) ?? defaultFiltersFor(fileName),
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    }
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await fs.writeFile(result.filePath, data)
    return true
  })

  handle(IPC.openExternal, async (_e, url: unknown) => {
    if (!isAllowedExternalUrl(url)) return
    await shell.openExternal(url)
  })

  // Only ever prints the calling page itself, one job per page at a time.
  const printing = new WeakSet<Electron.WebContents>()
  handle(IPC.printToPdf, async (event, raw: unknown) => {
    const opts = sanitizePrintOptions(raw)
    if (!opts) throw new Error('printToPdf: invalid options')
    const sender = event.sender
    if (printing.has(sender)) throw new Error('printToPdf: already printing')
    printing.add(sender)
    try {
      const pdf = await sender.printToPDF({
        printBackground: true,
        pageSize: opts.pageSize,
        landscape: opts.landscape,
        // PrintToPDFMargins has no marginType; zero inches on every side is "none".
        margins: { top: 0, bottom: 0, left: 0, right: 0 },
        preferCSSPageSize: true,
      })
      // A copy: a view could carry the rest of a pooled Buffer's memory over IPC.
      return new Uint8Array(pdf)
    } finally {
      printing.delete(sender)
    }
  })

  ipcMain.on(IPC.openUrlListeners, (event, count: unknown) => {
    if (!trusted(event)) return
    const sender = event.sender
    if (typeof count === 'number' && count > 0) {
      deps.inbox.setDelivery((url) => {
        if (sender.isDestroyed() || sender.isCrashed()) return false
        sender.send(IPC.openUrl, url)
        return true
      })
    } else {
      deps.inbox.setDelivery(null)
    }
  })
}
