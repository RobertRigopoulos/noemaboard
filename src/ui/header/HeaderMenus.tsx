/** Header dropdowns: app menu (logo), Export and View. */
import { useMemo } from 'react'
import {
  Archive,
  Download,
  Eye,
  FileImage,
  FileText,
  Focus,
  FolderArchive,
  Grid2x2,
  Grid3x3,
  House,
  Inbox,
  Keyboard,
  Link2,
  Magnet,
  Maximize,
  Minus,
  Plus,
  Presentation,
  Printer,
  ScanSearch,
  Settings,
  Trash,
  Upload,
} from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { useCanvasPrefs } from '../../board/prefs'
import { usePanels, useSelection, useView } from '../../board/store'
import { zoomBy, zoomTo, zoomToFit, zoomToSelection } from '../../board/actions'
import { canOpenBoard } from '../../app/boardAccess'
import { openBoard } from '../../app/router'
import { useLibrary } from '../../collab/library'
import { APP_NAME, HOME_BOARD_ID } from '../../config'
import { useDialogs } from '../uiStore'
import { useTheme, type Theme } from '../theme'
import {
  downloadBoardBackup,
  downloadMarkdown,
  downloadMarkdownBundle,
  downloadPlainText,
  pickAndImportBackup,
  printBoard,
  useExportBusy,
} from '../export/exportActions'
import { openImageExport } from '../export/ImageExportDialog'
import { BoardGlyph } from '../icons/BoardGlyph'
import { useUnsortedCards } from '../panels/UnsortedPanel'
import { isPreset, ZOOM_PRESETS, zoomPercent } from '../panels/zoomScale'
import { Menu, type MenuEntry } from './Menu'
import { MOD } from './hooks'

const appIconUrl = `${import.meta.env.BASE_URL}icon.svg`
const RECENT_BOARDS = 8

/** The boards opened most recently on this device (never the one shown, never Home). */
function useRecentBoards(currentId: string) {
  const entries = useLibrary((s) => s.entries)
  return useMemo(
    () =>
      Object.values(entries)
        .filter((e) => e.id !== currentId && e.id !== HOME_BOARD_ID && e.lastOpened > 0 && canOpenBoard(e.id, entries))
        .sort((a, b) => b.lastOpened - a.lastOpened)
        .slice(0, RECENT_BOARDS),
    [entries, currentId],
  )
}

export function AppMenu({ isHome, boardId }: { isHome: boolean; boardId: string }) {
  const open = useDialogs((s) => s.open)
  const recent = useRecentBoards(boardId)
  const items: MenuEntry[] = [
    { label: 'Home', icon: House, onSelect: () => openBoard(HOME_BOARD_ID), disabled: isHome },
    { label: 'Join a board…', icon: Link2, onSelect: () => open('join') },
    { label: 'Import a backup…', icon: Upload, onSelect: () => void pickAndImportBackup() },
  ]
  if (recent.length) {
    items.push({ kind: 'separator' }, { kind: 'label', label: 'Recent boards' })
    for (const e of recent) {
      items.push({
        label: e.title || 'Untitled board',
        icon: <BoardGlyph icon={e.icon} color={e.color} size={18} />,
        onSelect: () => openBoard(e.id),
      })
    }
  }
  items.push(
    { kind: 'separator' },
    { label: 'Settings', icon: Settings, onSelect: () => open('settings') },
    { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => open('shortcuts'), shortcut: '?' },
  )
  return (
    <Menu label={`${APP_NAME} menu`} className="app-mark" placement="bottom-start" items={items}>
      <img src={appIconUrl} alt="" width={26} height={26} draggable={false} />
      {isHome && <span className="app-mark__name">{APP_NAME}</span>}
    </Menu>
  )
}

export function ExportMenu({ ctx }: { ctx: BoardContextValue }) {
  const busy = useExportBusy((s) => s.busy)
  const items: MenuEntry[] = [
    { kind: 'label', label: 'Export this board' },
    { label: 'Markdown (.md)', icon: FileText, onSelect: () => void downloadMarkdown(ctx.doc), disabled: !!busy },
    { label: 'Markdown with images (.zip)', icon: FolderArchive, onSelect: () => void downloadMarkdownBundle(ctx.doc), disabled: !!busy },
    { label: 'Plain text (.txt)', icon: FileText, onSelect: () => void downloadPlainText(ctx.doc), disabled: !!busy },
    { label: 'Image (.png)…', icon: FileImage, onSelect: () => openImageExport('png'), disabled: !!busy },
    { label: 'PDF (.pdf)…', icon: FileText, onSelect: () => openImageExport('pdf'), disabled: !!busy },
    { kind: 'separator' },
    {
      label: ctx.isHome ? 'Backup of all boards (.noema)' : 'Board backup (.noema)',
      title: ctx.isHome ? 'Every board, with images and files' : 'This board and every board inside it, with images and files',
      icon: Archive,
      onSelect: () => void downloadBoardBackup(ctx.doc),
      disabled: !!busy,
    },
    { label: 'Import a backup…', icon: Upload, onSelect: () => void pickAndImportBackup(), disabled: !!busy || ctx.readOnly },
    { kind: 'separator' },
    { label: 'Print…', icon: Printer, onSelect: () => printBoard(ctx.doc), shortcut: `${MOD}+P` },
  ]
  return (
    <Menu label={busy ? `Export (${busy} in progress)` : 'Export'} items={items}>
      <Download size={18} aria-hidden className={busy ? 'is-busy' : undefined} />
    </Menu>
  )
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
]

export function ViewMenu({ ctx }: { ctx: BoardContextValue }) {
  const theme = useTheme((s) => s.theme)
  const setTheme = useTheme((s) => s.setTheme)
  const prefs = useCanvasPrefs()
  const zoom = useView((s) => s.viewport.zoom)
  const hasSelection = useSelection((s) => s.selected.size > 0)
  const unsorted = useUnsortedCards(ctx).length
  const unsortedOpen = usePanels((s) => s.panel === 'unsorted')
  const items: MenuEntry[] = [
    { label: 'Zoom in', icon: Plus, onSelect: () => zoomBy(1.25), shortcut: `${MOD}+=` },
    { label: 'Zoom out', icon: Minus, onSelect: () => zoomBy(0.8), shortcut: `${MOD}+−` },
    { label: 'Actual size (100%)', icon: ScanSearch, onSelect: () => zoomTo(1), shortcut: `${MOD}+0` },
    { label: 'Fit to screen', icon: Maximize, onSelect: () => zoomToFit(ctx.doc), shortcut: 'Shift+1' },
    { label: 'Zoom to selection', icon: Focus, onSelect: () => zoomToSelection(ctx.doc), shortcut: 'Shift+2', disabled: !hasSelection },
    { kind: 'label', label: 'Zoom level' },
    ...ZOOM_PRESETS.map((p) => ({ label: zoomPercent(p), checked: isPreset(zoom, p), onSelect: () => zoomTo(p) })),
    { kind: 'separator' },
    { label: 'Show dot grid', icon: Grid3x3, toggle: true, checked: prefs.showGrid, onSelect: () => prefs.set({ showGrid: !prefs.showGrid }) },
    { label: 'Snap to grid', icon: Magnet, toggle: true, checked: prefs.snapToGrid, onSelect: () => prefs.set({ snapToGrid: !prefs.snapToGrid }) },
    { label: 'Grid size: Small (10)', icon: Grid3x3, checked: prefs.gridSize === 10, onSelect: () => prefs.set({ gridSize: 10 }) },
    { label: 'Grid size: Medium (20)', icon: Grid2x2, checked: prefs.gridSize === 20, onSelect: () => prefs.set({ gridSize: 20 }) },
    { kind: 'separator' },
    {
      label: `Unsorted (${unsorted})`,
      icon: Inbox,
      toggle: true,
      checked: unsortedOpen,
      onSelect: () => usePanels.getState().setPanel(unsortedOpen ? null : 'unsorted'),
    },
    { label: 'Trash', icon: Trash, onSelect: () => usePanels.getState().setPanel('trash'), disabled: ctx.readOnly },
    { label: 'Present', icon: Presentation, onSelect: () => usePanels.getState().setPresenting(true) },
    { kind: 'separator' },
    { kind: 'label', label: 'Theme' },
    ...THEME_OPTIONS.map((o) => ({ label: o.label, checked: theme === o.value, onSelect: () => setTheme(o.value) })),
  ]
  return (
    <Menu label="View" items={items}>
      <Eye size={18} aria-hidden />
    </Menu>
  )
}
