/**
 * Column: a titled vertical stack of cards. Children are ordinary cards whose `parent` is this
 * column; each renders through its own <CardShell inColumn>, which handles its pointer events.
 * Clicks on the column's own background/header select and drag the column (handled by our shell).
 */
import { useMemo, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CardProps } from '../types'
import type { CardType, ColumnCard as ColumnData } from '../../model/types'
import { updateCard } from '../../model/board'
import { useBoard } from '../../board/BoardContext'
import { CardShell } from '../../board/CardShell'
import { addCardBelow } from '../../board/actions'
import { useDrag, useSelection } from '../../board/store'
import { getUser } from '../../collab/identity'
import { getDefinition } from '../registry'
import { cardCountLabel, cleanTitle, COLUMN_TITLE_MAX, contentsLabel, insertionSlot, sameIds } from './helpers'
import { visibleColumnChildren } from './columnActions'
import { TitleInput } from './TitleInput'
import './actions'
import './column.css'

const NO_IDS: string[] = []

/** Child ids in display order; the array identity only changes when the stack itself changes. */
function useColumnChildren(columnId: string): string[] {
  const { index } = useBoard()
  const getSnapshot = useMemo(() => {
    let lastSnap: unknown = null
    let ids = NO_IDS
    return () => {
      const snap = index.getSnapshot()
      if (snap === lastSnap) return ids
      lastSnap = snap
      const next = visibleColumnChildren(snap, columnId, (id) => index.get(id))
      if (!sameIds(next, ids)) ids = next.length ? next : NO_IDS
      return ids
    }
  }, [index, columnId])
  return useSyncExternalStore(index.subscribe, getSnapshot)
}

const typeLabel = (t: CardType) => getDefinition(t)?.label ?? 'card'

export function ColumnCard({ id, card, editing, readOnly, stopEditing }: CardProps<ColumnData>) {
  const { doc, index } = useBoard()
  const children = useColumnChildren(id)
  // Primitive selectors so a drag elsewhere does not re-render every column on each pointer move.
  const dropIndex = useDrag((s) => {
    const t = s.drag?.target
    return t && t.kind === 'column' && t.columnId === id ? t.index : -1
  })
  const draggedIds = useDrag((s) => (dropIndex >= 0 ? s.drag?.ids : undefined))
  // Read-only viewers can peek into a collapsed column without changing the shared doc.
  const [peek, setPeek] = useState(false)

  const title = cleanTitle(card.title, COLUMN_TITLE_MAX)
  const collapsed = card.collapsed === true && !(readOnly && peek)
  const isEditing = editing && !readOnly
  const count = children.length
  const countText = cardCountLabel(count)
  // A card's type never changes, so the breakdown only depends on which cards are in the column.
  const breakdown = useMemo(() => {
    const types: CardType[] = []
    for (const cid of children) {
      const c = index.get(cid)
      if (c) types.push(c.type)
    }
    return contentsLabel(types, typeLabel)
  }, [children, index])

  const slot = useMemo(
    () => (dropIndex >= 0 && !collapsed ? insertionSlot(children, new Set(draggedIds ?? NO_IDS), dropIndex) : null),
    [dropIndex, collapsed, children, draggedIds],
  )

  const toggleCollapsed = () => {
    if (readOnly) {
      if (card.collapsed === true) setPeek((p) => !p)
      return
    }
    const next = !collapsed
    updateCard(doc, id, { collapsed: next }, getUser().id)
    if (next) {
      // Hidden cards cannot stay selected; the column takes over the selection instead.
      const sel = useSelection.getState()
      const hidden = children.filter((c) => sel.selected.has(c))
      if (hidden.length) sel.select([...Array.from(sel.selected).filter((s) => !hidden.includes(s)), id])
    }
  }

  // A double-click on a nested card that is not editable must not put the column in edit mode.
  const onBodyDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const inner = (e.target as HTMLElement).closest('.card-shell')
    const own = e.currentTarget.closest('.card-shell')
    if (inner && inner !== own) e.stopPropagation()
  }

  return (
    <div className={`col${collapsed ? ' is-collapsed' : ''}`} role="group" aria-label={`Column: ${title || 'Untitled column'}`}>
      <div className="col__header">
        {isEditing ? (
          <TitleInput
            className="col__title-input"
            value={title}
            placeholder="Untitled column"
            maxLength={COLUMN_TITLE_MAX}
            ariaLabel="Column title"
            onCommit={(v) => updateCard(doc, id, { title: v }, getUser().id)}
            onDone={stopEditing}
            onBlur={stopEditing}
            onCreateNext={() => addCardBelow(doc, id)}
          />
        ) : (
          <div className={`col__title${title ? '' : ' is-placeholder'}`} title={title || undefined}>
            {title || 'Untitled column'}
          </div>
        )}
        <span className="col__count" title={breakdown} aria-label={breakdown} role="img">
          {count}
        </span>
        <button
          type="button"
          className="col__toggle"
          aria-label={collapsed ? 'Expand column' : 'Collapse column'}
          title={collapsed ? 'Expand' : 'Collapse'}
          aria-expanded={!collapsed}
          disabled={readOnly && card.collapsed !== true}
          onPointerDown={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronRight size={16} aria-hidden /> : <ChevronDown size={16} aria-hidden />}
        </button>
      </div>

      {collapsed ? (
        <div className={`col__stack${dropIndex >= 0 ? ' is-active' : ''}${count ? '' : ' is-empty'}`} aria-hidden>
          {count > 2 && <span className="col__sheet col__sheet--3" />}
          {count > 1 && <span className="col__sheet col__sheet--2" />}
          <span className="col__sheet col__sheet--1">{count ? countText : 'Empty'}</span>
        </div>
      ) : (
        <div className="col__body" onDoubleClick={onBodyDoubleClick}>
          {children.map((cid) => (
            <div key={cid} className="col__item" data-insert={slot?.id === cid ? slot.edge : undefined}>
              <CardShell id={cid} inColumn />
            </div>
          ))}
          {count === 0 && (
            <div className={`col__empty${dropIndex >= 0 ? ' is-active' : ''}`}>{readOnly ? 'No cards' : 'Drag cards here'}</div>
          )}
        </div>
      )}
    </div>
  )
}
