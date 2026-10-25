/**
 * Export / import actions wired to the UI: file names, save dialogs, progress and toasts.
 * The conversions themselves live in markdown.ts, backup.ts and raster.ts.
 */
import type * as Y from 'yjs'
import { zipSync, strToU8, type Zippable } from 'fflate'
import { create } from 'zustand'
import { HOME_BOARD_ID } from '../../config'
import type { BoardContextValue } from '../../board/BoardContext'
import { getLocalBlob } from '../../collab/blobs'
import { readMeta } from '../../model/board'
import { desktop, printToPdf, saveFile } from '../../lib/desktop'
import { usePanels, useView } from '../../board/store'
import { zoomToFit } from '../../board/actions'
import { openBoard } from '../../app/router'
import { toast } from '../toast'
import { BackupError, backupFileName, exportBackup, homeBoards, importBackup, safeFileName, BACKUP_EXTENSION } from './backup'
import { defaultAssetPath, exportMarkdown, exportPlainText, referencedAssets } from './markdown'
import { ExportEmptyError, exportTargets, mountPrintSheet, renderPng, withEveryCardRendered, type PngOptions, type SheetOptions } from './raster'
import './print.css'

/** True while a long export/import runs (menus disable their items). */
export const useExportBusy = create<{ busy: string | null }>(() => ({ busy: null }))

async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (useExportBusy.getState().busy) {
    toast('Please wait for the current export to finish.')
    return undefined
  }
  useExportBusy.setState({ busy: label })
  try {
    return await fn()
  } catch (e) {
    const known = e instanceof BackupError || e instanceof ExportEmptyError
    const msg = known ? (e as Error).message : `${label} failed. ${e instanceof Error ? e.message : ''}`.trim()
    toast(msg, known && e instanceof ExportEmptyError ? 'info' : 'error', 7000)
    return undefined
  } finally {
    useExportBusy.setState({ busy: null })
  }
}

function boardTitle(doc: Y.Doc): string {
  return doc.guid === HOME_BOARD_ID ? 'Home' : readMeta(doc).title.trim() || 'Untitled board'
}

const enc = new TextEncoder()

export function downloadMarkdown(doc: Y.Doc) {
  return run('Markdown export', async () => {
    const name = `${safeFileName(boardTitle(doc))}.md`
    if (await saveFile(name, enc.encode(exportMarkdown(doc)), 'text/markdown;charset=utf-8')) toast(`Exported ${name}`, 'success')
  })
}

/** Markdown plus the images and files it references, so links in the .md resolve. */
export function downloadMarkdownBundle(doc: Y.Doc) {
  return run('Markdown export', async () => {
    const title = safeFileName(boardTitle(doc))
    const files: Zippable = { [`${title}.md`]: strToU8(exportMarkdown(doc)) }
    let missing = 0
    for (const a of referencedAssets(doc)) {
      const blob = await getLocalBlob(a.hash)
      if (!blob) {
        missing++
        continue
      }
      files[defaultAssetPath(a.kind, a.hash, a.name, a.mime)] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }]
    }
    const name = `${title}.zip`
    if (await saveFile(name, zipSync(files), 'application/zip')) {
      toast(missing ? `Exported ${name}. ${missing} file${missing === 1 ? ' is' : 's are'} not on this device yet and were left out.` : `Exported ${name}`, missing ? 'info' : 'success', missing ? 7000 : 4000)
    }
  })
}

export function downloadPlainText(doc: Y.Doc) {
  return run('Text export', async () => {
    const name = `${safeFileName(boardTitle(doc))}.txt`
    if (await saveFile(name, enc.encode(exportPlainText(doc)), 'text/plain;charset=utf-8')) toast(`Exported ${name}`, 'success')
  })
}

function describeExport(res: { boards: number; blobs: number; missingBlobs: number }): string {
  const parts = [`${res.boards} board${res.boards === 1 ? '' : 's'}`]
  if (res.blobs) parts.push(`${res.blobs} file${res.blobs === 1 ? '' : 's'}`)
  let s = `Backed up ${parts.join(' and ')}.`
  if (res.missingBlobs) s += ` ${res.missingBlobs} image${res.missingBlobs === 1 ? '' : 's'}/file${res.missingBlobs === 1 ? '' : 's'} not on this device were skipped.`
  return s
}

/** This board and every board nested inside it (on Home: every board). */
export function downloadBoardBackup(doc: Y.Doc) {
  if (doc.guid === HOME_BOARD_ID) return downloadFullBackup()
  return run('Backup', async () => {
    const res = await exportBackup([doc.guid])
    if (await saveFile(backupFileName(boardTitle(doc)), res.bytes, 'application/zip')) toast(describeExport(res), 'success', 6000)
  })
}

export function downloadFullBackup() {
  return run('Backup', async () => {
    const { ids, secrets } = await homeBoards()
    // Every board on Home, plus the notes placed directly on Home.
    const res = await exportBackup(ids, { secrets, homeNotes: true }).catch((e: unknown) => {
      if (!ids.length && e instanceof BackupError) return null
      throw e
    })
    if (!res) {
      toast('There is nothing to back up yet.')
      return
    }
    if (await saveFile(backupFileName('All boards'), res.bytes, 'application/zip')) toast(describeExport(res), 'success', 6000)
  })
}

export function importBackupFile(file: File | Blob) {
  return run('Import', async () => {
    const s = await importBackup(file)
    if (!s.boards) {
      toast(s.skipped ? 'Nothing was imported: the boards in this backup are damaged or belong to different boards with the same id.' : 'Nothing was imported.', 'error', 8000)
      return s
    }
    let msg = `Imported ${s.boards} board${s.boards === 1 ? '' : 's'}`
    if (s.blobs) msg += ` and ${s.blobs} file${s.blobs === 1 ? '' : 's'}`
    msg += s.addedToHome ? '. They are waiting in Home’s Unsorted drawer.' : '.'
    if (s.skipped) msg += ` ${s.skipped} damaged or conflicting board${s.skipped === 1 ? ' was' : 's were'} skipped.`
    const show = s.addedToHome
      ? {
          label: 'Show',
          run: () => {
            usePanels.getState().setPanel('unsorted')
            openBoard(HOME_BOARD_ID)
          },
        }
      : undefined
    toast(msg, s.skipped || s.badBlobs ? 'info' : 'success', 7000, show)
    return s
  })
}

/** Opens the system file picker for a backup file. */
export function pickBackupFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = `${BACKUP_EXTENSION},application/zip,application/x-zip-compressed`
    input.style.display = 'none'
    let settled = false
    const done = (f: File | null) => {
      if (settled) return
      settled = true
      input.remove()
      resolve(f)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    input.addEventListener('cancel', () => done(null))
    document.body.appendChild(input)
    input.click()
  })
}

export async function pickAndImportBackup() {
  const file = await pickBackupFile()
  if (file) await importBackupFile(file)
}

/** Fits the board on the page, prints, then restores the previous view. */
export function printBoard(doc: Y.Doc) {
  const prev = useView.getState().viewport
  zoomToFit(doc)
  const restore = () => {
    window.removeEventListener('afterprint', restore)
    useView.getState().setViewport(prev)
  }
  window.addEventListener('afterprint', restore)
  // Two frames so the fitted view is painted before the print snapshot.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      window.print()
    }),
  )
}

// ---------------------------------------------------------------------------
// Pictures: PNG and PDF

/** Saves the board (or the selected cards) as a PNG image. */
export function exportPng(ctx: BoardContextValue, opts: PngOptions) {
  return run('Image export', async () => {
    const res = await withEveryCardRendered(() => renderPng(ctx, opts), { media: () => exportTargets(ctx, opts.scope).cardIds })
    const name = `${safeFileName(boardTitle(ctx.doc))}.png`
    if (!(await saveFile(name, res.blob, 'image/png'))) return
    const notes: string[] = []
    if (res.downscaled) notes.push('It was made smaller to stay within what this device can draw.')
    if (res.missingImages) notes.push(missingImagesNote(res.missingImages))
    toast(notes.length ? `Exported ${name}. ${notes.join(' ')}` : `Exported ${name}`, notes.length ? 'info' : 'success', notes.length ? 8000 : 4000)
  })
}

function missingImagesNote(n: number): string {
  return `${n} image${n === 1 ? ' is' : 's are'} not on this device yet and show${n === 1 ? 's' : ''} as grey boxes.`
}

/** Shows the light theme while printing when asked; returns how to put the current theme back. */
function forceLightTheme(on: boolean): () => void {
  const root = document.documentElement
  if (!on) return () => {}
  const prev = root.getAttribute('data-theme')
  root.setAttribute('data-theme', 'light')
  return () => {
    if (prev === null) root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', prev)
  }
}

/** window.print(), resolving once the print dialog has closed. */
function printAndWait(): Promise<void> {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      window.removeEventListener('afterprint', finish)
      resolve()
    }
    window.addEventListener('afterprint', finish)
    const started = Date.now()
    window.print()
    // Most browsers block in print() until the dialog closes; others report it with 'afterprint'.
    if (Date.now() - started > 400) finish()
    else setTimeout(finish, 5 * 60_000)
  })
}

export interface PdfExportOptions extends SheetOptions {
  /** Print in the light theme even when the app is dark. */
  light: boolean
}

/**
 * PDF of the board (or the selected cards). The desktop app writes the file directly; browsers open
 * the print dialog, where people choose "Save as PDF".
 */
export function exportPdf(ctx: BoardContextValue, opts: PdfExportOptions) {
  return run('PDF export', async () => {
    const name = `${safeFileName(boardTitle(ctx.doc))}.pdf`
    await withEveryCardRendered(
      async () => {
        const restoreTheme = forceLightTheme(opts.light)
        let sheet: Awaited<ReturnType<typeof mountPrintSheet>> | null = null
        try {
          sheet = await mountPrintSheet(ctx, opts)
          const missing = sheet.missingImages ? ` ${missingImagesNote(sheet.missingImages)}` : ''
          const bytes = desktop ? await printToPdf({ pageSize: opts.pageSize, landscape: sheet.landscape }) : null
          if (bytes) {
            if (await saveFile(name, bytes, 'application/pdf'))
              toast(`Exported ${name} (${sheet.pages} page${sheet.pages === 1 ? '' : 's'}).${missing}`, missing ? 'info' : 'success', missing ? 8000 : 4000)
          } else {
            // The desktop shell could not write the PDF: its print dialog can still save one.
            if (desktop) toast('The PDF could not be made directly. Choose “Save as PDF” in the print dialog.', 'info', 7000)
            await printAndWait()
            if (missing) toast(missing.trim(), 'info', 8000)
          }
        } finally {
          sheet?.remove()
          restoreTheme()
        }
      },
      { media: () => exportTargets(ctx, opts.scope).cardIds },
    )
  })
}
