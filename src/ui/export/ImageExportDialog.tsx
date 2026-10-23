/** Export > Image (.png) / PDF (.pdf): what to include and how it should look. */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { FileImage, FileText, Printer } from 'lucide-react'
import { create } from 'zustand'
import type { BoardContextValue } from '../../board/BoardContext'
import { useSelection } from '../../board/store'
import { desktop, PDF_PAGE_SIZES, type PdfPageSize } from '../../lib/desktop'
import { Dialog } from '../dialogs/Dialog'
import { useTheme } from '../theme'
import { useDialogs } from '../uiStore'
import { exportPdf, exportPng, useExportBusy } from './exportActions'
import type { ExportScope } from './raster'

export type PictureFormat = 'png' | 'pdf'

const useImageExport = create<{ format: PictureFormat }>(() => ({ format: 'png' }))

/** Opens the picture export dialog for PNG or PDF. */
export function openImageExport(format: PictureFormat) {
  useImageExport.setState({ format })
  useDialogs.getState().open('imageExport')
}

interface Option<T extends string> {
  value: T
  label: string
  disabled?: boolean
  title?: string
}

/** A labelled radio group drawn as a segmented control (arrow keys move the choice). */
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Option<T>[]; onChange: (v: T) => void }) {
  const id = useId()
  const enabled = options.filter((o) => !o.disabled)
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!dir || !enabled.length) return
    e.preventDefault()
    const i = enabled.findIndex((o) => o.value === value)
    const next = enabled[(i + dir + enabled.length) % enabled.length]
    onChange(next.value)
    ;(e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus()
  }
  return (
    <div className="pic-export__field">
      <span className="pic-export__label" id={id}>
        {label}
      </span>
      <div className="seg pic-export__seg" role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            data-value={o.value}
            aria-checked={value === o.value}
            className="seg__opt"
            disabled={o.disabled}
            title={o.title}
            tabIndex={value === o.value ? 0 : -1}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function ImageExportDialog({ ctx }: { ctx: BoardContextValue }) {
  const open = useDialogs((s) => s.dialog === 'imageExport')
  const close = useDialogs((s) => s.close)
  const format = useImageExport((s) => s.format)
  return (
    <Dialog open={open} onClose={close} size="sm" title={format === 'png' ? 'Export as image' : 'Export as PDF'} className="pic-export-dlg">
      <ImageExportBody key={format} ctx={ctx} format={format} onClose={close} />
    </Dialog>
  )
}

type Background = 'white' | 'board' | 'transparent'

function ImageExportBody({ ctx, format, onClose }: { ctx: BoardContextValue; format: PictureFormat; onClose: () => void }) {
  const selectedCount = useSelection((s) => s.selected.size)
  const resolvedTheme = useTheme((s) => s.resolved)
  const busy = useExportBusy((s) => s.busy)
  const [scope, setScope] = useState<ExportScope>(selectedCount > 0 ? 'selection' : 'board')
  const [scale, setScale] = useState<'1' | '2'>('2')
  const [background, setBackground] = useState<Background>(format === 'png' ? 'board' : 'white')
  const [theme, setTheme] = useState<'light' | 'current'>('current')
  const [pageSize, setPageSize] = useState<PdfPageSize>('A4')
  const [layout, setLayout] = useState<'fit' | 'large'>('fit')
  const [hint, setHint] = useState(false)
  const hintPrimary = useRef<HTMLButtonElement | null>(null)
  const mainPrimary = useRef<HTMLButtonElement | null>(null)
  // Switching steps unmounts the focused button, and the dialog only autofocuses when it opens.
  const shownStep = useRef(hint)
  useEffect(() => {
    if (shownStep.current === hint) return
    shownStep.current = hint
    ;(hint ? hintPrimary : mainPrimary).current?.focus({ preventScroll: true })
  }, [hint])
  const effectiveScope: ExportScope = scope === 'selection' && selectedCount === 0 ? 'board' : scope
  const pdfBackground: 'white' | 'board' = background === 'transparent' ? 'white' : background

  const go = () => {
    onClose()
    if (format === 'png') {
      void exportPng(ctx, {
        scope: effectiveScope,
        scale: Number(scale),
        background,
        theme: theme === 'light' ? 'light' : resolvedTheme,
      })
    } else {
      // Let the dialog leave the screen before the page is printed.
      setTimeout(() => {
        void exportPdf(ctx, { scope: effectiveScope, layout, pageSize, landscape: null, background: pdfBackground, light: theme === 'light' })
      }, 60)
    }
  }

  if (hint) {
    return (
      <div className="pic-export">
        <div className="callout">
          <Printer size={16} aria-hidden />
          <span>
            Your browser's print dialog opens next. Choose <strong>Save as PDF</strong> as the printer (or destination) to get a PDF file.
          </span>
        </div>
        <div className="pic-export__actions">
          <button type="button" className="btn btn--ghost" onClick={() => setHint(false)}>
            Back
          </button>
          <button ref={hintPrimary} type="button" className="btn btn--primary" onClick={go} disabled={!!busy}>
            <Printer size={15} aria-hidden />
            Open print dialog
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="pic-export">
      <Choice<ExportScope>
        label="Include"
        value={effectiveScope}
        onChange={setScope}
        options={[
          { value: 'board', label: 'Whole board' },
          {
            value: 'selection',
            label: selectedCount ? `Selected cards (${selectedCount})` : 'Selected cards',
            disabled: !selectedCount,
            title: selectedCount ? undefined : 'Select cards on the board first',
          },
        ]}
      />
      {format === 'png' && (
        <Choice<'1' | '2'>
          label="Size"
          value={scale}
          onChange={setScale}
          options={[
            { value: '1', label: 'Standard (1x)' },
            { value: '2', label: 'Sharp (2x)' },
          ]}
        />
      )}
      {format === 'pdf' && (
        <>
          <Choice<PdfPageSize> label="Paper" value={pageSize} onChange={setPageSize} options={PDF_PAGE_SIZES.map((p) => ({ value: p, label: p }))} />
          <Choice<'fit' | 'large'>
            label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: 'fit', label: 'Fit on one page' },
              { value: 'large', label: 'Large (several pages)' },
            ]}
          />
        </>
      )}
      <Choice<Background>
        label="Background"
        value={format === 'pdf' ? pdfBackground : background}
        onChange={setBackground}
        options={[
          { value: 'white', label: 'White' },
          { value: 'board', label: 'Board colour' },
          ...(format === 'png' ? [{ value: 'transparent' as const, label: 'Transparent' }] : []),
        ]}
      />
      <Choice<'light' | 'current'>
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'current', label: resolvedTheme === 'dark' ? 'Current (dark)' : 'Current (light)' },
        ]}
      />
      <p className="dlg-small pic-export__note">
        {format === 'png'
          ? 'Cards in the Unsorted drawer are left out. Very large boards are made smaller to fit what this device can draw.'
          : `Page orientation follows the shape of the content. ${layout === 'large' ? 'Cards are printed at actual size over as many pages as needed.' : ''}`}
      </p>
      <div className="pic-export__actions">
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          ref={mainPrimary}
          type="button"
          className="btn btn--primary"
          disabled={!!busy}
          onClick={() => (format === 'pdf' && !desktop ? setHint(true) : go())}
        >
          {format === 'png' ? <FileImage size={15} aria-hidden /> : <FileText size={15} aria-hidden />}
          {format === 'png' ? 'Export PNG' : desktop ? 'Export PDF' : 'Continue'}
        </button>
      </div>
      {busy && (
        <p className="dlg-small" role="status">
          {busy} in progress…
        </p>
      )}
    </div>
  )
}
