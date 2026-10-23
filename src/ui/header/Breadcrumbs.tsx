/** Home › Parent › Board trail. Long chains collapse their middle into a "…" menu. */
import { useMemo } from 'react'
import { ChevronRight, House } from 'lucide-react'
import { HOME_BOARD_ID } from '../../config'
import { breadcrumbs } from '../../collab/boards'
import { useLibrary } from '../../collab/library'
import { openBoard } from '../../app/router'
import { CARD_COLORS } from '../../model/types'
import { Menu } from './Menu'
import { BoardIcon } from '../icons/BoardIcon'
import { isBoardIconId } from '../../model/boardIcons'
import { useDrag } from '../../board/store'

interface Crumb {
  id: string
  title: string
  icon: string | null
  color: string | null
}

const MAX_VISIBLE = 4

function CrumbIcon({ crumb }: { crumb: Crumb }) {
  if (crumb.id === HOME_BOARD_ID) return <House size={14} aria-hidden className="crumb__home" />
  if (isBoardIconId(crumb.icon)) return <BoardIcon icon={crumb.icon} size={14} className="crumb__icon" />
  const color = crumb.color && (CARD_COLORS as readonly string[]).includes(crumb.color) ? crumb.color : null
  return <span className="crumb__dot" data-color={color ?? undefined} aria-hidden />
}

export function Breadcrumbs({ boardId, currentTitle }: { boardId: string; currentTitle?: string }) {
  const dropTarget = useDrag((s) => (s.drag?.target?.kind === 'board' && s.drag.target.cardId === '' ? s.drag.target.boardId : null))
  const entries = useLibrary((s) => s.entries)
  const chain: Crumb[] = useMemo(
    () =>
      breadcrumbs(boardId).map((c, i, all) => ({
        ...c,
        title: c.id === HOME_BOARD_ID ? 'Home' : i === all.length - 1 && currentTitle ? currentTitle : c.title,
        color: entries[c.id]?.color ?? null,
      })),
    // breadcrumbs() reads the library store; `entries` changes whenever it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, entries, currentTitle],
  )

  const collapsed = chain.length > MAX_VISIBLE
  const hidden = collapsed ? chain.slice(1, chain.length - 2) : []
  const visible = collapsed ? [chain[0], null, ...chain.slice(-2)] : chain

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      <ol>
        {visible.map((c, i) => {
          const last = i === visible.length - 1
          if (!c) {
            return (
              <li key="more" className="crumb">
                <Menu
                  label={`Show ${hidden.length} more board${hidden.length === 1 ? '' : 's'} in the path`}
                  className="crumb__btn crumb__btn--more"
                  placement="bottom-start"
                  items={hidden.map((h) => ({ label: h.title || 'Untitled board', icon: <CrumbIcon crumb={h} />, onSelect: () => openBoard(h.id) }))}
                >
                  …
                </Menu>
                <ChevronRight size={14} className="crumb__sep" aria-hidden />
              </li>
            )
          }
          return (
            <li key={c.id} className={`crumb${last ? ' crumb--current' : ''}`}>
              {last ? (
                <span className="crumb__btn" aria-current="page" title={c.title}>
                  <CrumbIcon crumb={c} />
                  <span className="crumb__text">{c.title || 'Untitled board'}</span>
                </span>
              ) : (
                <button
                  type="button"
                  className={`crumb__btn${dropTarget === c.id ? ' is-drop-target' : ''}`}
                  title={`Open ${c.title}${c.id === HOME_BOARD_ID ? '' : ' (drop cards here to move them to this board)'}`}
                  onClick={() => openBoard(c.id)}
                  data-drop={c.id === HOME_BOARD_ID ? undefined : 'crumb'}
                  data-board-id={c.id}
                >
                  <CrumbIcon crumb={c} />
                  <span className="crumb__text">{c.title || 'Untitled board'}</span>
                </button>
              )}
              {!last && <ChevronRight size={14} className="crumb__sep" aria-hidden />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
