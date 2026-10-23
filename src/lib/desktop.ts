/**
 * Bridge to the Electron shell. `window.desktop` is exposed by electron/preload.ts via
 * contextBridge; in a plain browser it is undefined and every caller must have a fallback.
 */

export interface LinkPreview {
  /** Final URL after redirects. */
  url: string
  title: string
  description: string
  siteName: string
  /** Absolute URL of the og:image / twitter:image, if any. */
  image: string | null
  /** Absolute URL of the favicon, if any. */
  favicon: string | null
}

export interface DesktopSettings {
  /** Keep running in the system tray when the window is closed, so teammates can sync. */
  closeToTray: boolean
  /** Start the app (hidden in the tray) when the computer starts. */
  openAtLogin: boolean
}

export const PDF_PAGE_SIZES = ['A4', 'Letter', 'A3'] as const
export type PdfPageSize = (typeof PDF_PAGE_SIZES)[number]

export interface PrintToPdfOptions {
  pageSize: PdfPageSize
  landscape: boolean
}

export interface DesktopAPI {
  platform: 'win32' | 'darwin' | 'linux'
  appVersion: string
  /** Fetches OpenGraph metadata for a public http(s) URL (SSRF-guarded in the main process). */
  fetchLinkPreview(url: string): Promise<LinkPreview | null>
  /** Downloads a public image (≤10 MB, image/* only) for link preview thumbnails. */
  fetchImage(url: string): Promise<{ bytes: Uint8Array; mime: string } | null>
  /** Subscribes to invite deep links (noema://join/...) opened while the app runs. */
  onOpenUrl(cb: (url: string) => void): () => void
  /** Deep link the app was launched with, if any (consumed once). */
  takePendingOpenUrl(): Promise<string | null>
  getSettings(): Promise<DesktopSettings>
  setSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>
  /** Native "Save as" dialog. Resolves false if cancelled. */
  saveFile(defaultName: string, data: Uint8Array, filters?: { name: string; extensions: string[] }[]): Promise<boolean>
  /** Opens a URL in the user's default browser (http/https/mailto only). */
  openExternal(url: string): Promise<void>
  /**
   * Prints this window's page to PDF with backgrounds, no margins and CSS @page sizes respected.
   * Resolves null on failure.
   */
  printToPdf(opts: PrintToPdfOptions): Promise<Uint8Array | null>
}

export const desktop: DesktopAPI | null =
  typeof window !== 'undefined' ? ((window as unknown as { desktop?: DesktopAPI }).desktop ?? null) : null

/** Saves bytes as a file: native dialog on desktop, download link in the browser. */
export async function saveFile(name: string, data: Uint8Array | Blob, mime = 'application/octet-stream'): Promise<boolean> {
  if (desktop) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data
    return desktop.saveFile(name, bytes)
  }
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return true
}

/**
 * PDF of the current page, rendered by the desktop shell (what is on screen, styled by the page's
 * print CSS). null in the browser, where callers fall back to window.print(), or on error.
 */
export async function printToPdf(opts: PrintToPdfOptions): Promise<Uint8Array | null> {
  if (!desktop || typeof desktop.printToPdf !== 'function') return null
  try {
    const bytes = await desktop.printToPdf({ pageSize: opts.pageSize, landscape: opts.landscape === true })
    return bytes instanceof Uint8Array && bytes.byteLength > 0 ? bytes : null
  } catch (err) {
    console.warn('[desktop] printing to PDF failed', err)
    return null
  }
}

/** Opens a link outside the app. */
export function openExternal(url: string) {
  if (!/^(https?:|mailto:)/i.test(url)) return
  if (desktop) void desktop.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}
