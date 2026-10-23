/**
 * "Move to board… / Copy to board…": picks a board from the library (a tree by parent, recent
 * boards first, a filter) and moves or copies the selected cards there. Opened through
 * useBoardPicker from the card menu.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import type * as Y from 'yjs'
import { ChevronRight, Clock, Search } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { canMoveIntoBoard, fillForkedBoards, moveIntoBoard, snap } from '../../board/actions'
import { useCanvasPrefs } from '../../board/prefs'
import { useSelection } from '../../board/store'
import { canOpenBoard } from '../../app/boardAccess'
import { openBoard } from '../../app/router'
import { docs } from '../../collab/docs'
import { getUser } from '../../collab/identity'
import { useLibrary } from '../../collab/library'
import { HOME_BOARD_ID } from '../../config'
import {
  deserializeCards,
  expandSelection,
  forEachActiveCard,
  forkBoardCards,
  getCardMap,
  insertClonedCards,
  isTrashed,
  LOCAL_ORIGIN,
  readCard,
  serializeCards,
} from '../../model/board'
import { moveToUnsorted } from '../../model/unsorted'
import { BoardGlyph } from '../icons/BoardGlyph'
import { toast } from '../toast'
import { useBoardPicker, type BoardPickerMode } from '../uiStore'
import { buildBoardTree, filterBoardTree, findNode, recentBoards, subtreeIds, visibleRows, type TreeBoard } from './boardTree'
import { Dialog } from './Dialog'
import { topLevelCopies } from './topLevelCopies'

const RECENT_COUNT = 5

export function BoardPicker({ ctx }: { ctx: BoardContextValue }) {
  const request = useBoardPicker((s) => s.request)
  const close = useBoardPicker((s) => s.close)
  // Picking only makes sense for cards on an editable board, and only on the board they came from.
  const usable = !!request && request.boardId === ctx.boardId && !ctx.readOnly && request.ids.length > 0
  useEffect(() => {
    if (request && !usable) close()
  }, [request, usable, close])
  if (!request || !usable) return null
  const n = request.ids.length
  const what = n === 1 ? 'card' : `${n} cards`
  return (
    <Dialog open onClose={close} size="md" title={request.mode === 'move' ? `Move ${what} to…` : `Copy ${what} to…`} className="board-picker-dlg">
      <PickerBody ctx={ctx} mode={request.mode} ids={request.ids} onClose={close} />
    </Dialog>
  )
}

const plural = (n: number) => (n === 1 ? '1 card' : `${n} cards`)

/** Why `boardId` cannot take the cards, or null when it can. */
function blockReason(doc: Y.Doc, ids: readonly string[], boardId: string, insideMoved: ReadonlySet<string>): string | null {
  if (boardId === doc.guid) return 'The cards are on this board'
  if (insideMoved.has(boardId)) return 'A board cannot go inside itself'
  if (!canMoveIntoBoard(doc, ids, boardId)) return 'Not available on this device'
  return null
}

/** Board ids (with everything nested in them) of the board cards being moved or copied. */
function boardsInSelection(doc: Y.Doc, ids: readonly string[]): string[] {
  const out: string[] = []
  for (const id of expandSelection(doc, ids)) {
    const m = getCardMap(doc, id)
    const boardId = m?.get('type') === 'board' ? m.get('boardId') : null
    if (typeof boardId === 'string' && boardId) out.push(boardId)
  }
  return out
}

function PickerBody({ ctx, mode, ids, onClose }: { ctx: BoardContextValue; mode: BoardPickerMode; ids: readonly string[]; onClose: () => void }) {
  const entries = useLibrary((s) => s.entries)
  const unsortedOnMove = useCanvasPrefs((s) => s.unsortedOnMove)
  const [query, setQuery] = useState('')
  /** Nodes the person opened (true) or closed (false); others follow the filter. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [active, setActive] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const treeRef = useRef<HTMLUListElement | null>(null)
  const id = useId()

  const boards: TreeBoard[] = useMemo(
    () =>
      Object.values(entries)
        .filter((e) => e.id !== HOME_BOARD_ID && canOpenBoard(e.id, entries))
        .map((e) => ({ id: e.id, title: e.title || 'Untitled board', icon: e.icon, color: e.color, parentId: e.parentId, lastOpened: e.lastOpened })),
    [entries],
  )
  const tree = useMemo(() => buildBoardTree(boards, HOME_BOARD_ID), [boards])

  // A board card being moved takes its whole subtree with it: none of those boards can receive it.
  const insideMoved = useMemo(() => {
    const out = new Set<string>()
    for (const b of boardsInSelection(ctx.doc, ids)) {
      const node = findNode(tree, b)
      if (node) subtreeIds(node, out)
      else out.add(b)
    }
    return out
  }, [ctx.doc, ids, tree])
  const reasons = useMemo(() => {
    const m = new Map<string, string | null>()
    for (const b of boards) m.set(b.id, blockReason(ctx.doc, ids, b.id, insideMoved))
    return m
  }, [boards, ctx.doc, ids, insideMoved])

  // Show where we are: the current board's ancestors start expanded.
  useEffect(() => {
    const open = new Map<string, boolean>()
    let cur = entries[ctx.boardId]?.parentId ?? null
    for (let n = 0; cur && cur !== HOME_BOARD_ID && n < 64; n++) {
      open.set(cur, true)
      cur = entries[cur]?.parentId ?? null
    }
    setOverrides(open)
    // Only when the picker opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filtered = useMemo(() => filterBoardTree(tree, query), [tree, query])
  const expanded = useMemo(() => {
    const out = new Set<string>()
    // A filter opens the ancestors of its matches, unless the person closed one.
    for (const b of filtered.expanded) if (overrides.get(b) !== false) out.add(b)
    for (const [b, open] of overrides) if (open) out.add(b)
    return out
  }, [filtered, overrides])
  const rows = useMemo(() => visibleRows(filtered.roots, expanded), [filtered, expanded])
  const recent = useMemo(() => (query.trim() ? [] : recentBoards(boards, RECENT_COUNT, new Set([ctx.boardId]))), [boards, query, ctx.boardId])

  const activeId = active && rows.some((r) => r.node.board.id === active) ? active : (rows[0]?.node.board.id ?? null)

  const focusRow = (boardId: string | null) => {
    if (!boardId) return
    setActive(boardId)
    requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-board="${CSS.escape(boardId)}"]`)?.focus())
  }

  const toggle = (boardId: string, open?: boolean) =>
    setOverrides((s) => {
      const next = new Map(s)
      next.set(boardId, open ?? !expanded.has(boardId))
      return next
    })

  const pick = async (board: TreeBoard) => {
    if (busy || reasons.get(board.id)) return
    setBusy(true)
    try {
      if (mode === 'move') await moveCards(ctx, ids, board)
      else await copyCards(ctx.doc, ids, board)
      onClose()
    } catch (err) {
      console.warn('Board picker action failed', err)
      toast(mode === 'move' ? 'The cards could not be moved.' : 'The cards could not be copied.', 'error')
      setBusy(false)
    }
  }

  const onTreeKeyDown = (e: ReactKeyboardEvent) => {
    const i = rows.findIndex((r) => r.node.board.id === activeId)
    const row = rows[i]
    if (!row) return
    const node = row.node
    const hasKids = node.children.length > 0
    const isOpen = expanded.has(node.board.id)
    let handled = true
    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[Math.min(rows.length - 1, i + 1)]?.node.board.id ?? null)
        break
      case 'ArrowUp':
        if (i === 0) document.getElementById(`${id}-filter`)?.focus()
        else focusRow(rows[i - 1].node.board.id)
        break
      case 'ArrowRight':
        if (hasKids && !isOpen) toggle(node.board.id, true)
        else if (hasKids) focusRow(node.children[0].board.id)
        break
      case 'ArrowLeft':
        if (hasKids && isOpen) toggle(node.board.id, false)
        else if (row.parentId) focusRow(row.parentId)
        break
      case 'Home':
        focusRow(rows[0].node.board.id)
        break
      case 'End':
        focusRow(rows[rows.length - 1].node.board.id)
        break
      case 'Enter':
      case ' ':
        // A held key (from the menu item that opened the picker) is not a choice.
        if (!e.repeat) void pick(node.board)
        break
      default:
        handled = false
    }
    if (handled) e.preventDefault()
  }

  const verb = mode === 'move' ? 'Move' : 'Copy'

  return (
    <div className="board-picker">
      <div className="board-picker__filter">
        <Search size={16} aria-hidden className="board-picker__filter-icon" />
        <input
          id={`${id}-filter`}
          data-autofocus
          className="input"
          type="search"
          placeholder="Find a board"
          aria-label="Find a board"
          aria-controls={`${id}-tree`}
          value={query}
          maxLength={200}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && rows.length) {
              e.preventDefault()
              focusRow(activeId)
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (e.repeat) return
              // After typing a name, Enter picks the first matching board that can take the cards.
              // Without one nothing was chosen yet: Enter goes to the list instead.
              const first = query.trim() ? rows.find((r) => !reasons.get(r.node.board.id) && filtered.matches.has(r.node.board.id)) : undefined
              if (first) void pick(first.node.board)
              else if (!query.trim() && rows.length) focusRow(activeId)
            }
          }}
        />
      </div>

      {recent.length > 0 && (
        <section className="board-picker__recent" aria-labelledby={`${id}-recent`}>
          <h3 className="board-picker__heading" id={`${id}-recent`}>
            <Clock size={13} aria-hidden />
            Recent
          </h3>
          <ul className="board-picker__chips">
            {recent.map((b) => {
              const reason = reasons.get(b.id)
              return (
                <li key={b.id}>
                  <button
                    type="button"
                    className="board-picker__chip"
                    disabled={!!reason || busy}
                    title={reason ?? `${verb} to “${b.title}”`}
                    onClick={() => void pick(b)}
                  >
                    <BoardGlyph icon={b.icon} color={b.color} />
                    <span className="board-picker__chip-text">{b.title}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <h3 className="board-picker__heading" id={`${id}-all`}>
        {query.trim() ? 'Matching boards' : 'All boards'}
      </h3>
      {rows.length === 0 ? (
        <p className="board-picker__empty muted">{boards.length ? 'No board matches that name.' : 'There are no other boards yet. Create a board first.'}</p>
      ) : (
        <ul ref={treeRef} id={`${id}-tree`} className="board-picker__tree" role="tree" aria-labelledby={`${id}-all`} onKeyDown={onTreeKeyDown}>
          {rows.map((r) => {
            const b = r.node.board
            const reason = reasons.get(b.id) ?? null
            const hasKids = r.node.children.length > 0
            const isOpen = expanded.has(b.id)
            const dim = !!query.trim() && !filtered.matches.has(b.id)
            return (
              <li
                key={b.id}
                role="treeitem"
                aria-level={r.level}
                aria-expanded={hasKids ? isOpen : undefined}
                aria-selected={b.id === activeId}
                aria-disabled={reason ? true : undefined}
                tabIndex={b.id === activeId ? 0 : -1}
                data-board={b.id}
                className={`board-picker__row${reason ? ' is-disabled' : ''}${dim ? ' is-context' : ''}`}
                style={{ paddingLeft: 6 + (r.level - 1) * 18 }}
                title={reason ?? `${verb} to “${b.title}”`}
                onFocus={() => setActive(b.id)}
                onClick={() => void pick(b)}
              >
                <span
                  className={`board-picker__twisty${hasKids ? '' : ' is-leaf'}${isOpen ? ' is-open' : ''}`}
                  aria-hidden
                  onClick={(e) => {
                    if (!hasKids) return
                    e.stopPropagation()
                    toggle(b.id)
                  }}
                >
                  {hasKids && <ChevronRight size={14} strokeWidth={2} />}
                </span>
                <BoardGlyph icon={b.icon} color={b.color} />
                <span className="board-picker__title">{b.title}</span>
                {reason && <span className="board-picker__reason">{reason}</span>}
              </li>
            )
          })}
        </ul>
      )}
      <p className="dlg-small board-picker__note">
        {unsortedOnMove ? 'The cards wait in the board’s Unsorted drawer.' : 'The cards are placed to the right of the board’s content.'}
        {mode === 'copy' ? ' Copied boards get their own new boards with the same content.' : ''}
      </p>
    </div>
  )
}

/** The cards among `ids` that are on the board now (not deleted, moved away or gone). */
function liveCards(doc: Y.Doc, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const m = getCardMap(doc, id)
    return !!m && !isTrashed(m)
  })
}

async function moveCards(ctx: BoardContextValue, ids: readonly string[], board: TreeBoard) {
  ctx.undo.stopCapturing()
  const unsorted = useCanvasPrefs.getState().unsortedOnMove
  const before = liveCards(ctx.doc, ids)
  await moveIntoBoard(ctx.doc, before, board.id)
  // moveIntoBoard does nothing when the cards changed (or the board closed) while the target loaded.
  const moved = ctx.doc.isDestroyed ? 0 : before.filter((id) => getCardMap(ctx.doc, id)?.get('movedTo') === board.id).length
  if (!moved) {
    toast('Nothing was moved: the cards changed while the board was opening.', 'info', 6000)
    return
  }
  toast(`Moved ${plural(moved)} to ${unsorted ? 'Unsorted on ' : ''}“${board.title}”`, 'success', 6000, {
    label: 'Open',
    run: () => openBoard(board.id),
  })
}

/** Right of the target's canvas content (drawer cards and lines aside), on the grid. */
function spotRight(doc: Y.Doc): { x: number; y: number } {
  let maxX = -Infinity
  let minY = Infinity
  forEachActiveCard(doc, (m) => {
    if (m.get('parent') || m.get('unsorted') === true) return
    const c = readCard(m)
    if (c.type === 'line') return
    maxX = Math.max(maxX, c.x + c.w)
    minY = Math.min(minY, c.y)
  })
  return Number.isFinite(maxX) ? { x: snap(maxX + 40), y: snap(minY) } : { x: 80, y: 80 }
}

/**
 * Copies the cards (with column children, attached comments and lines between them) into another
 * board, as one change there. Copied board cards get their own new boards, filled afterwards.
 */
export async function copyCardsToBoard(doc: Y.Doc, ids: readonly string[], targetId: string, unsorted: boolean): Promise<number> {
  const group = deserializeCards(serializeCards(doc, ids))
  if (!group.length) return 0
  const forks = forkBoardCards(group)
  const user = getUser().id
  let placed = 0
  await docs.withDoc(targetId, (target) => {
    target.transact(() => {
      const inserted = insertClonedCards(target, group, spotRight(target), user)
      const top = topLevelCopies(target, inserted)
      placed = top.length
      if (unsorted) moveToUnsorted(target, top, user)
    }, LOCAL_ORIGIN)
  })
  // Nested boards fill in the background; their cards already point to the new boards.
  void fillForkedBoards(targetId, forks).catch((err) => console.warn('Could not copy nested boards', err))
  return placed
}

async function copyCards(doc: Y.Doc, ids: readonly string[], board: TreeBoard) {
  const unsorted = useCanvasPrefs.getState().unsortedOnMove
  const n = await copyCardsToBoard(doc, ids, board.id, unsorted)
  if (!n) {
    toast('There was nothing to copy.', 'info')
    return
  }
  // The originals stay selected here, as after a regular copy.
  if (!useSelection.getState().selected.size) useSelection.getState().select(ids)
  toast(`Copied ${plural(n)} to ${unsorted ? 'Unsorted on ' : ''}“${board.title}”`, 'success', 6000, {
    label: 'Open',
    run: () => openBoard(board.id),
  })
}
