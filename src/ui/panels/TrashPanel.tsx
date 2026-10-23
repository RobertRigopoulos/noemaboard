/**
 * Right-side panel listing the board's trash: what was deleted, by whom and when, with restore
 * and permanent delete. Entries are soft-deleted cards grouped by deletion (see model/board.ts).
 */
import { useEffect, useRef, useState } from 'react'
import { Trash2, RotateCcw, X, Inbox } from 'lucide-react'
import { usePeers, type BoardContextValue } from '../../board/BoardContext'
import { centerOn } from '../../board/actions'
import { measuredSize, unionRects, type Rect } from '../../board/geometry'
import { usePanels, useSelection, useView } from '../../board/store'
import { CARD_DEFINITIONS } from '../../cards/registry'
import { useIdentity } from '../../collab/identity'
import { emptyTrash, getCards, purgeTrashEntry, readCard, restoreTrashEntry, TRASH_RETENTION_MS } from '../../model/board'
import { memberName } from '../../model/members'
import type { CardType } from '../../model/types'
import { toast } from '../toast'
import { entryLabel, relativeTime, type TrashSummary } from './trashSummary'
import { useTrashSummaries } from './useTrash'
import './panels.css'

const TYPE_LABELS = Object.fromEntries(Object.values(CARD_DEFINITIONS).map((d) => [d.type, d.label])) as Record<CardType, string>
const RETENTION_DAYS = Math.round(TRASH_RETENTION_MS / (24 * 3600 * 1000))
/** Must match .side-panel width and right inset in panels.css. */
const PANEL_WIDTH = 340
const PANEL_GAP = 8

export function TrashPanel({ ctx }: { ctx: BoardContextValue }) {
  const open = usePanels((s) => s.panel === 'trash')
  const presenting = usePanels((s) => s.presenting)
  if (!open || presenting) return null
  return <TrashPanelBody ctx={ctx} />
}

/** Re-renders every `ms` so relative times stay fresh. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function TrashPanelBody({ ctx }: { ctx: BoardContextValue }) {
  const entries = useTrashSummaries(ctx.doc)
  const now = useNow(30_000)
  const userId = useIdentity((s) => s.user.id)
  const peers = usePeers()
  const [confirmAll, setConfirmAll] = useState(false)
  const panelRef = useRef<HTMLElement | null>(null)
  const close = () => usePanels.getState().setPanel(null)

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true })
  }, [])
  useEffect(() => {
    if (!entries.length) setConfirmAll(false)
  }, [entries.length])

  // Live presence first (current name), then the board's member roster (people who are offline now).
  const who = (id: string) => {
    if (id && id === userId) return 'You'
    const peer = peers.find((p) => p.state.user?.id === id)
    const live = peer?.state.user.name?.trim()
    if (live) return live.slice(0, 40)
    const member = id ? memberName(ctx.doc, id) : null
    return member ? member.slice(0, 40) : 'A teammate'
  }

  const restore = (e: TrashSummary) => {
    ctx.undo.stopCapturing()
    const ids = restoreTrashEntry(ctx.doc, e.id, userId)
    if (!ids.length) {
      toast('That item is no longer in the trash.', 'info')
      return
    }
    const cards = getCards(ctx.doc)
    const top = ids.filter((id) => !cards.get(id)?.get('parent'))
    const rects: Rect[] = []
    for (const id of top) {
      const m = cards.get(id)
      if (!m) continue
      const c = readCard(m)
      if (c.type === 'line') rects.push({ x: Math.min(c.from.x, c.to.x), y: Math.min(c.from.y, c.to.y), w: Math.abs(c.to.x - c.from.x), h: Math.abs(c.to.y - c.from.y) })
      else rects.push({ x: c.x, y: c.y, w: c.w, h: c.h ?? measuredSize(id)?.h ?? 100 })
    }
    useSelection.getState().select(top.length ? top : ids)
    const box = unionRects(rects)
    // Centre in the part of the canvas the panel does not cover.
    const shift = (PANEL_WIDTH + PANEL_GAP) / 2 / useView.getState().viewport.zoom
    if (box) centerOn({ x: box.x + box.w / 2 + shift, y: box.y + box.h / 2 })
    toast(`Restored ${entryLabel(e.types, e.count, TYPE_LABELS).toLowerCase()}`, 'success')
  }

  const purge = (e: TrashSummary) => {
    ctx.undo.stopCapturing()
    purgeTrashEntry(ctx.doc, e.id)
  }

  return (
    <aside
      ref={panelRef}
      className="side-panel trash-panel"
      aria-label="Trash"
      tabIndex={-1}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') {
          ev.preventDefault()
          ev.stopPropagation()
          close()
        } else if (!ev.ctrlKey && !ev.metaKey) {
          // Keep board shortcuts (Delete, arrows, N, T...) from acting on the canvas; undo/redo still work.
          ev.stopPropagation()
        }
      }}
    >
      <header className="side-panel__header">
        <h2 className="side-panel__title">Trash</h2>
        {entries.length > 0 && !ctx.readOnly && (
          <button type="button" className="btn btn--ghost btn--danger side-panel__action" onClick={() => setConfirmAll(true)} disabled={confirmAll}>
            Empty trash
          </button>
        )}
        <button type="button" className="icon-btn" aria-label="Close trash" title="Close" onClick={close}>
          <X size={18} strokeWidth={1.75} />
        </button>
      </header>

      {confirmAll && (
        <div className="trash-confirm" role="alertdialog" aria-label="Empty trash">
          <p>
            Permanently delete {entries.length === 1 ? 'the item' : `all ${entries.length} items`} in the trash? Nobody on this board
            will be able to restore {entries.length === 1 ? 'it' : 'them'}.
          </p>
          <div className="trash-confirm__actions">
            <button type="button" className="btn" onClick={() => setConfirmAll(false)} autoFocus>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--danger-solid"
              onClick={() => {
                ctx.undo.stopCapturing()
                emptyTrash(ctx.doc)
                setConfirmAll(false)
                toast('Trash emptied', 'success')
              }}
            >
              Empty trash
            </button>
          </div>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="side-panel__empty">
          <span className="side-panel__empty-icon" aria-hidden>
            <Inbox size={26} strokeWidth={1.5} />
          </span>
          <p className="side-panel__empty-title">The trash is empty</p>
          <p className="muted">Deleted cards land here for {RETENTION_DAYS} days, so you and your team can bring them back.</p>
        </div>
      ) : (
        <>
          <p className="trash-panel__note muted">Items are deleted forever after {RETENTION_DAYS} days.</p>
          <ul className="trash-list">
            {entries.map((e) => (
              <TrashRow
                key={e.id}
                entry={e}
                now={now}
                who={who(e.deletedBy)}
                readOnly={ctx.readOnly}
                onRestore={() => restore(e)}
                onPurge={() => purge(e)}
              />
            ))}
          </ul>
        </>
      )}
    </aside>
  )
}

function TrashRow({
  entry,
  now,
  who,
  readOnly,
  onRestore,
  onPurge,
}: {
  entry: TrashSummary
  now: number
  who: string
  readOnly: boolean
  onRestore: () => void
  onPurge: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const label = entryLabel(entry.types, entry.count, TYPE_LABELS)
  const title = entry.title || label
  const when = relativeTime(entry.deletedAt, now)
  const absolute = entry.deletedAt ? new Date(entry.deletedAt).toLocaleString() : undefined
  return (
    <li className="trash-row">
      <div className="trash-row__icons" aria-hidden>
        {entry.types.slice(0, 3).map(({ type }) => {
          const Icon = CARD_DEFINITIONS[type]?.icon
          return Icon ? (
            <span key={type} className="trash-row__icon">
              <Icon size={15} strokeWidth={1.75} />
            </span>
          ) : null
        })}
      </div>
      <div className="trash-row__body">
        <div className="trash-row__title" title={title}>
          {title}
        </div>
        <div className="trash-row__meta">
          {entry.title ? `${label} · ` : ''}
          {who} · <time dateTime={entry.deletedAt ? new Date(entry.deletedAt).toISOString() : undefined} title={absolute}>{when}</time>
        </div>
        {!readOnly &&
          (confirming ? (
            <div className="trash-row__actions" role="group" aria-label="Confirm permanent delete">
              <span className="trash-row__ask">Delete forever?</span>
              <button type="button" className="btn btn--sm" onClick={() => setConfirming(false)} autoFocus>
                Cancel
              </button>
              <button type="button" className="btn btn--sm btn--danger-solid" onClick={onPurge}>
                Delete
              </button>
            </div>
          ) : (
            <div className="trash-row__actions">
              <button type="button" className="btn btn--sm" onClick={onRestore} aria-label={`Restore ${title}`}>
                <RotateCcw size={14} strokeWidth={1.75} aria-hidden />
                Restore
              </button>
              <button
                type="button"
                className="btn btn--sm btn--ghost btn--danger"
                onClick={() => setConfirming(true)}
                aria-label={`Delete ${title} forever`}
              >
                <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                Delete forever
              </button>
            </div>
          ))}
      </div>
    </li>
  )
}
