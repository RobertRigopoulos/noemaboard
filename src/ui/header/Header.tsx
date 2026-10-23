/**
 * Fixed top bar: app menu + breadcrumbs (left), board title (centre), undo/redo, presence,
 * sharing and app actions (right).
 */
import { CircleQuestionMark, Redo2, Search, Settings, Share2, Undo2 } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { useDialogs } from '../uiStore'
import { openSettings } from '../dialogs/SettingsDialog'
import { AppMenu, ExportMenu, ViewMenu } from './HeaderMenus'
import { AvatarStack } from './AvatarStack'
import { Breadcrumbs } from './Breadcrumbs'
import { BoardTitle, useBoardTitle } from './BoardTitle'
import { SyncStatus } from './SyncStatus'
import { MOD, useUndoState } from './hooks'
import { QuickNote } from './QuickNote'
import { openSearch } from '../search/searchState'
import { keepControlKeys } from '../keyGuard'
import './header.css'

export function Header({ ctx }: { ctx: BoardContextValue }) {
  const open = useDialogs((s) => s.open)
  const { canUndo, canRedo } = useUndoState(ctx.undo)
  const title = useBoardTitle(ctx)

  return (
    // Space/Enter on header buttons must activate them, not pan the canvas or edit a card.
    <header className="app-header" onKeyDown={keepControlKeys}>
      <div className="app-header__left">
        <AppMenu isHome={ctx.isHome} boardId={ctx.boardId} />
        {!ctx.isHome && <Breadcrumbs boardId={ctx.boardId} currentTitle={title} />}
      </div>

      <div className="app-header__center">
        <BoardTitle ctx={ctx} />
      </div>

      <div className="app-header__right">
        {!ctx.readOnly && (
          <div className="app-header__group" role="group" aria-label="History">
            <button
              type="button"
              className="icon-btn"
              aria-label="Undo"
              title={`Undo (${MOD}+Z)`}
              disabled={!canUndo}
              onClick={() => ctx.undo.undo()}
            >
              <Undo2 size={18} aria-hidden />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Redo"
              title={`Redo (${MOD}+Shift+Z)`}
              disabled={!canRedo}
              onClick={() => ctx.undo.redo()}
            >
              <Redo2 size={18} aria-hidden />
            </button>
          </div>
        )}

        {!ctx.isHome && (
          <>
            <span className="app-header__divider" aria-hidden />
            <SyncStatus boardId={ctx.boardId} onClick={(action) => (action === 'network' ? openSettings('network') : open('share'))} />
            <AvatarStack />
            <button type="button" className="btn btn--primary app-header__share" onClick={() => open('share')} title="Invite people to this board">
              <Share2 size={15} aria-hidden />
              <span>Share</span>
            </button>
          </>
        )}

        <span className="app-header__divider" aria-hidden />

        <QuickNote ctx={ctx} />
        <button type="button" className="icon-btn" aria-label="Search" title={`Search (${MOD}+F)`} onClick={() => openSearch('all')}>
          <Search size={18} aria-hidden />
        </button>
        <ExportMenu ctx={ctx} />
        <ViewMenu ctx={ctx} />
        <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={() => open('settings')}>
          <Settings size={18} aria-hidden />
        </button>
        <button type="button" className="icon-btn" aria-label="Keyboard shortcuts and help" title="Keyboard shortcuts (?)" onClick={() => open('shortcuts')}>
          <CircleQuestionMark size={18} aria-hidden />
        </button>
      </div>
    </header>
  )
}
