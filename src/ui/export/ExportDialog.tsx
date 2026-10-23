/** Export choices as a dialog (useDialogs 'export'), for entry points outside the header menu. */
import { Archive, FileImage, FileText, FolderArchive, Printer, Upload, type LucideIcon } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { useDialogs } from '../uiStore'
import { Dialog } from '../dialogs/Dialog'
import {
  downloadBoardBackup,
  downloadMarkdown,
  downloadMarkdownBundle,
  downloadPlainText,
  pickAndImportBackup,
  printBoard,
  useExportBusy,
} from './exportActions'
import { openImageExport } from './ImageExportDialog'

interface Choice {
  icon: LucideIcon
  title: string
  detail: string
  run: () => unknown
  disabled?: boolean
}

export function ExportDialog({ ctx }: { ctx: BoardContextValue }) {
  const open = useDialogs((s) => s.dialog === 'export')
  const close = useDialogs((s) => s.close)
  const busy = useExportBusy((s) => s.busy)

  const choices: Choice[] = [
    { icon: FileText, title: 'Markdown (.md)', detail: 'Text, headings, lists, links and comments. Opens in any notes app.', run: () => downloadMarkdown(ctx.doc) },
    {
      icon: FolderArchive,
      title: 'Markdown with images (.zip)',
      detail: 'The Markdown file plus every image and file on the board.',
      run: () => downloadMarkdownBundle(ctx.doc),
    },
    { icon: FileText, title: 'Plain text (.txt)', detail: 'Just the words.', run: () => downloadPlainText(ctx.doc) },
    { icon: FileImage, title: 'Image (.png)…', detail: 'A picture of the board or of the selected cards.', run: () => openImageExport('png') },
    { icon: FileText, title: 'PDF (.pdf)…', detail: 'On one page, or at actual size over several pages.', run: () => openImageExport('pdf') },
    {
      icon: Archive,
      title: ctx.isHome ? 'Backup of all boards (.noema)' : 'Board backup (.noema)',
      detail: ctx.isHome
        ? 'Every board with its images and files. Import it on any device.'
        : 'This board and every board inside it, with images and files. Import it on any device.',
      run: () => downloadBoardBackup(ctx.doc),
    },
    { icon: Upload, title: 'Import a backup…', detail: 'Adds the boards from a .noema file.', run: () => pickAndImportBackup(), disabled: ctx.readOnly },
    {
      icon: Printer,
      title: 'Print…',
      detail: 'Prints the board as it fits on the page, without the app around it.',
      run: () => {
        close()
        // Let the dialog disappear before the print snapshot.
        setTimeout(() => printBoard(ctx.doc), 50)
      },
    },
  ]

  return (
    <Dialog open={open} onClose={close} size="sm" title="Export & backup">
      <div className="choice-list">
        {choices.map((c) => (
          <button
            key={c.title}
            type="button"
            className="choice"
            disabled={!!busy || c.disabled}
            onClick={() => {
              void c.run()
            }}
          >
            <c.icon size={18} aria-hidden />
            <span className="choice__text">
              <strong>{c.title}</strong>
              <span>{c.detail}</span>
            </span>
          </button>
        ))}
      </div>
      {busy && (
        <p className="dlg-small" role="status" style={{ marginTop: 10 }}>
          {busy} in progress…
        </p>
      )}
    </Dialog>
  )
}
