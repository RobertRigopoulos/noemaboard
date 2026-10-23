/**
 * High-level board actions shared by the toolbar, keyboard shortcuts, context menus and cards.
 * They combine model operations with UI state (selection, viewport) and the doc registry.
 */
import * as Y from 'yjs'
import {
  bringForward,
  bringToFront,
  cardsToPlainText,
  CLIPBOARD_MIME,
  columnChildren,
  copyBoardContent,
  createCard,
  deleteCards,
  deserializeCards,
  duplicateCards,
  expandSelection,
  forEachActiveCard,
  forkBoardCards,
  getCardMap,
  initBoardDoc,
  insertClonedCards,
  isParked,
  LOCAL_ORIGIN,
  moveCardsToBoard,
  orderKeyAt,
  readCard,
  sendBackward,
  sendToBack,
  serializeCards,
  updateCards,
  type BoardFork,
  type InsertOptions,
  type NewCardFields,
} from '../model/board'
import { newBoardId, newSecret, bytesToBase64Url, base64UrlToBytes, isValidId } from '../model/ids'
import { DEFAULT_SIZE, MIN_WIDTH, type Card, type CardColor, type CardType } from '../model/types'
import type { IndexedCard } from './cardIndex'
import { docs } from '../collab/docs'
import { getLibraryEntry, useLibrary } from '../collab/library'
import { getUser } from '../collab/identity'
import { HOME_BOARD_ID } from '../config'
import { clampZoom, MAX_ZOOM, useSelection, useView } from './store'
import { updateBoardAppearance } from '../cards/structure/boardAppearance'
import { canvasRect, cardBounds, elementBoardRect, measuredSize, unionRects, visibleBoardRect, type Rect } from './geometry'
import { trackMove } from './moveUndo'
import { snap as gridSnap, useCanvasPrefs } from './prefs'
import { LOCKED_KEPT_MESSAGE, splitLocked } from './lockRules'
import { pushDownPatches, type PushCandidate } from './pushDown'
import { arrangeRects, type ARect, type ArrangeMode } from './arrange'
import { toast } from '../ui/toast'
import { cardsToHtml } from '../editor/cardsHtml'
import { attachmentTarget } from '../cards/structure/attach'

/** Snaps a board coordinate with the user's grid preferences (bypass: whole pixels only). */
export const snap = (v: number, bypass = false) => gridSnap(v, bypass)

/** Card rendered on the canvas (not parked in the Unsorted drawer). */
const onCanvas = (m: Y.Map<unknown>) => m.get('unsorted') !== true

/** Undo manager of the open board, registered by BoardView, for actions that only get the doc. */
let activeUndo: Y.UndoManager | null = null
export function setActiveUndo(undo: Y.UndoManager | null) {
  activeUndo = undo
}

/** Unregisters `undo` unless another board has registered its own since. */
export function clearActiveUndo(undo: Y.UndoManager) {
  if (activeUndo === undo) activeUndo = null
}

/** Ends the current undo capture group of `doc`'s board, so the next write is its own step. */
export function stopUndoCapturing(doc: Y.Doc) {
  if (activeUndo && activeUndo.doc === doc) activeUndo.stopCapturing()
}

/** Center of the visible canvas in board coordinates. */
export function viewCenter(): { x: number; y: number } {
  const r = visibleBoardRect()
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** Creates a card centred at `at` (board coords) or at the view centre, selects it and optionally starts editing. */
export function addCard(
  doc: Y.Doc,
  type: CardType,
  fields: NewCardFields = {},
  opts: { at?: { x: number; y: number }; edit?: boolean; centered?: boolean } = {},
): string {
  const user = getUser()
  const size = DEFAULT_SIZE[type]
  const w = (fields.w as number | undefined) ?? size.w
  const h = (fields.h as number | undefined) ?? size.h ?? 80
  const at = opts.at ?? viewCenter()
  const centered = opts.centered ?? !opts.at
  let x = snap(centered ? at.x - w / 2 : at.x)
  let y = snap(centered ? at.y - h / 2 : at.y)
  // Toolbar/shortcut cards (no explicit position) should not land on top of existing cards.
  if (!opts.at) ({ x, y } = findFreeSpot(doc, { x, y, w, h }))
  let extra: NewCardFields = {}
  if (type === 'board' && !fields.boardId) {
    const boardId = newBoardId()
    const secret = newSecret()
    const title = (fields.title as string | undefined) ?? 'New board'
    extra = { boardId, secret, title }
    // Create the child board doc right away so it exists locally.
    void docs.withDoc(boardId, (child) => {
      initBoardDoc(child, { id: boardId, title, parentId: doc.guid, shared: false }, user.id)
    })
    useLibrary.getState().upsert({ id: boardId, secret, title, parentId: doc.guid })
  }
  const id = createCard(doc, type, { x, y, ...extra, ...fields }, user.id)
  const sel = useSelection.getState()
  sel.select([id])
  if (opts.edit) sel.setEditing(id)
  return id
}

/** Nearest position (spiralling outwards on the grid) where a w×h card overlaps no free card. */
export function findFreeSpot(doc: Y.Doc, want: { x: number; y: number; w: number; h: number }): { x: number; y: number } {
  const rects: { x: number; y: number; w: number; h: number }[] = []
  forEachActiveCard(doc, (m, id) => {
    if (m.get('parent') || !onCanvas(m)) return
    const c = readCard(m)
    if (c.type === 'line') return
    rects.push({ x: c.x, y: c.y, w: c.w, h: c.h ?? measuredSize(id)?.h ?? 120 })
  })
  const gap = 20
  const hits = (x: number, y: number) =>
    rects.some((r) => x < r.x + r.w + gap && x + want.w + gap > r.x && y < r.y + r.h + gap && y + want.h + gap > r.y)
  if (!hits(want.x, want.y)) return { x: want.x, y: want.y }
  const step = 40
  for (let ring = 1; ring <= 40; ring++) {
    for (let i = -ring; i <= ring; i++) {
      for (const [dx, dy] of [[i, -ring], [i, ring], [-ring, i], [ring, i]] as const) {
        const x = snap(want.x + dx * step)
        const y = snap(want.y + dy * step)
        if (!hits(x, y)) return { x, y }
      }
    }
  }
  return { x: want.x, y: want.y }
}

/** Deletes the selection except locked cards, which stay selected (with a toast saying why). */
export function deleteSelection(doc: Y.Doc) {
  const sel = useSelection.getState()
  if (!sel.selected.size) return
  const { deletable, kept } = splitLocked(doc, sel.selected)
  if (deletable.length) deleteCards(doc, deletable, getUser().id)
  if (kept.length) {
    sel.select(kept)
    toast(LOCKED_KEPT_MESSAGE)
  } else sel.clear()
}

export function duplicateSelection(doc: Y.Doc) {
  const sel = useSelection.getState()
  if (!sel.selected.size) return
  const forks: BoardFork[] = []
  const ids = duplicateCards(doc, sel.selected, getUser().id, undefined, { forks })
  void fillForkedBoards(doc.guid, forks)
  const top = ids.filter((id) => !getCardMap(doc, id)?.get('parent'))
  sel.select(top.length ? top : ids)
}

// ---------------------------------------------------------------------------
// Copies of board cards get their own child boards

/** Limits for copying nested boards (deeper or further boards are created empty). */
const FORK_MAX_DEPTH = 8
const FORK_MAX_BOARDS = 200

/**
 * Fills the new child boards of copied board cards (duplicate, paste) with a copy of the boards they
 * were copied from, recursively. A copy never shares the original's board or its secret, so
 * copying content into a new board really leaves people with the old link behind. Content is copied
 * from what this device has locally; a board this device does not know (e.g. a card pasted from
 * elsewhere) stays empty.
 */
export async function fillForkedBoards(
  parentId: string,
  forks: BoardFork[],
  depth = 0,
  budget = { left: FORK_MAX_BOARDS },
  ancestors: ReadonlySet<string> = new Set([parentId]),
): Promise<void> {
  const user = getUser()
  // Known right away (synchronously), so the new board cards never show as unavailable.
  for (const f of forks) useLibrary.getState().upsert({ id: f.to, secret: f.secret, title: f.title, parentId })
  for (const f of forks) {
    const canCopy =
      depth < FORK_MAX_DEPTH &&
      budget.left > 0 &&
      isValidId(f.from) &&
      f.from !== HOME_BOARD_ID &&
      !ancestors.has(f.from) &&
      !!getLibraryEntry(f.from)?.secret
    if (canCopy) budget.left--
    let nested: BoardFork[] = []
    try {
      await docs.withDoc(f.to, async (dst) => {
        if (canCopy) {
          await docs.withDoc(f.from, (src) => {
            nested = copyBoardContent(src, dst, { parentId, userId: user.id, title: f.title })
          })
        } else {
          initBoardDoc(dst, { id: f.to, title: f.title, parentId, shared: false }, user.id)
        }
      })
    } catch (err) {
      console.warn('Could not copy a nested board', err)
    }
    if (nested.length) await fillForkedBoards(f.to, nested, depth + 1, budget, new Set([...ancestors, f.from]))
  }
}

/** Rendered height of a card, for stacking cards that leave a column. */
function renderedHeight(id: string): number | undefined {
  return elementBoardRect(id)?.h ?? measuredSize(id)?.h
}

export function selectAll(doc: Y.Doc) {
  const ids: string[] = []
  forEachActiveCard(doc, (m, id) => {
    // Comments and lines hidden with a drawer card are not selected (nor deleted) with everything else.
    if (!m.get('parent') && onCanvas(m) && !isParked(doc, id)) ids.push(id)
  })
  useSelection.getState().select(ids)
}

/** Nudge (arrow keys) moves free, unlocked cards by a fixed step, independent of the snap grid. */
export function nudgeSelection(doc: Y.Doc, dx: number, dy: number) {
  const sel = useSelection.getState()
  const patches: Record<string, Record<string, unknown>> = {}
  for (const id of sel.selected) {
    const m = getCardMap(doc, id)
    if (!m || m.get('parent') || m.get('locked') === true || !onCanvas(m)) continue
    const c = readCard(m)
    if (c.type === 'line') {
      patches[id] = {
        from: c.from.card ? c.from : { ...c.from, x: c.from.x + dx, y: c.from.y + dy },
        to: c.to.card ? c.to : { ...c.to, x: c.to.x + dx, y: c.to.y + dy },
      }
    } else patches[id] = { x: c.x + dx, y: c.y + dy }
  }
  updateCards(doc, patches, getUser().id)
}

export function arrange(doc: Y.Doc, how: 'front' | 'back') {
  const ids = Array.from(useSelection.getState().selected)
  if (!ids.length) return
  if (how === 'front') bringToFront(doc, ids, getUser().id)
  else sendToBack(doc, ids, getUser().id)
}

/** One step forward or backward in the stacking order, past the nearest overlapping card. */
export function stepZOrder(doc: Y.Doc, dir: 'forward' | 'backward') {
  const ids = Array.from(useSelection.getState().selected)
  if (!ids.length) return
  const rectOf = (id: string) => {
    const m = getCardMap(doc, id)
    return m ? cardBounds(indexedCard(id, readCard(m))) : null
  }
  if (dir === 'forward') bringForward(doc, ids, getUser().id, rectOf)
  else sendBackward(doc, ids, getUser().id, rectOf)
}

/** Height used to lay out a free card: stored, measured, or read from the DOM. */
function layoutHeight(id: string, h: number | undefined, fallback: number): number {
  return h ?? measuredSize(id)?.h ?? elementBoardRect(id)?.h ?? fallback
}

/** Selected cards that Align, Distribute and Tidy may move: free, unlocked, on the canvas, not lines. */
export function arrangeableRects(doc: Y.Doc, ids: Iterable<string>): ARect[] {
  const out: ARect[] = []
  const lookup = (id: string) => {
    const m = getCardMap(doc, id)
    return m ? { card: readCard(m) } : undefined
  }
  for (const id of ids) {
    const m = getCardMap(doc, id)
    if (!m || m.get('parent') || m.get('locked') === true || !onCanvas(m)) continue
    const c = readCard(m)
    // A comment pinned to a card is drawn on that card, not at its own position.
    if (c.type === 'line' || attachmentTarget(c, lookup)) continue
    out.push({ id, x: c.x, y: c.y, w: c.w, h: layoutHeight(id, c.h, 100) })
  }
  return out
}

/**
 * Aligns, distributes or tidies the selection in ONE update (one undo step; callers stop undo
 * capturing first). Locked cards are skipped; lines attached to the cards follow on their own.
 */
export function arrangeSelection(doc: Y.Doc, mode: ArrangeMode) {
  const rects = arrangeableRects(doc, useSelection.getState().selected)
  const next = arrangeRects(rects, mode)
  if (!Object.keys(next).length) return
  updateCards(doc, next, getUser().id, LOCAL_ORIGIN)
}

// ---------------------------------------------------------------------------
// Mod+Enter: next card below

/** Gap between a card and the one created below it. */
const BELOW_GAP = 20
/** Heights of new, empty cards before they are measured: a note, and a column (header + empty body). */
const NEW_NOTE_H = 80
const NEW_COLUMN_H = 120

/** Expected height of the card Mod+Enter creates, so the cards under it are pushed far enough. */
function newCardHeight(type: CardType, sourceHeight: number): number {
  // A board follows a board: same tile and title layout as the source.
  if (type === 'board') return sourceHeight
  if (type === 'column') return NEW_COLUMN_H
  return DEFAULT_SIZE[type].h ?? NEW_NOTE_H
}

/**
 * Creates the next card below `sourceId` (Milanote's Mod+Enter): a board after a board, a column
 * after a column, a note after anything else. Free cards push the cards under them down; inside a
 * column the new card is inserted right after the source. Selects the new card and starts editing
 * a note or column. One undo step. Returns the new id, or null when nothing was created (lines and
 * comments pinned to a card have no place of their own to add below).
 */
export function addCardBelow(doc: Y.Doc, sourceId: string): string | null {
  const m = getCardMap(doc, sourceId)
  if (!m || !onCanvas(m)) return null
  const src = readCard(m)
  if (src.trashedAt || src.type === 'line') return null
  const lookup = (id: string) => {
    const tm = getCardMap(doc, id)
    return tm ? { card: readCard(tm) } : undefined
  }
  // A pinned comment is drawn on its card; its own stored position is stale.
  if (attachmentTarget(src, lookup)) return null
  // Its own undo step, even right after typing in the source card (editors call this directly).
  stopUndoCapturing(doc)
  const user = getUser()
  const parent = src.parent ? getCardMap(doc, src.parent) : undefined
  const inColumn = !!parent && parent.get('type') === 'column' && !readCard(parent).trashedAt
  let type: CardType = src.type === 'board' ? 'board' : src.type === 'column' ? 'column' : 'note'
  // Columns cannot nest.
  if (inColumn && type === 'column') type = 'note'
  let extra: NewCardFields = {}
  if (type === 'board') {
    const boardId = newBoardId()
    const secret = newSecret()
    const title = 'New board'
    extra = { boardId, secret, title }
    void docs.withDoc(boardId, (child) => {
      initBoardDoc(child, { id: boardId, title, parentId: doc.guid, shared: false }, user.id)
    })
    useLibrary.getState().upsert({ id: boardId, secret, title, parentId: doc.guid })
  }
  let id: string
  if (inColumn) {
    const siblings = columnChildren(doc, src.parent!)
    const index = siblings.indexOf(sourceId)
    const order = orderKeyAt(doc, siblings, index < 0 ? siblings.length : index + 1)
    id = createCard(doc, type, { ...extra, parent: src.parent, order, x: src.x, y: src.y }, user.id)
  } else {
    const w = Math.max(MIN_WIDTH[type], src.type === 'board' ? DEFAULT_SIZE.board.w : src.w)
    const h = layoutHeight(sourceId, src.h, NEW_NOTE_H)
    const at = { x: src.x, y: snap(src.y + h + BELOW_GAP) }
    const newRect = { x: at.x, y: at.y, w, h: newCardHeight(type, h) }
    const others: PushCandidate[] = []
    forEachActiveCard(doc, (om, oid) => {
      if (oid === sourceId) return
      const c = readCard(om)
      const free = !c.parent && onCanvas(om)
      others.push({
        id: oid,
        x: c.x,
        y: c.y,
        w: c.w,
        h: layoutHeight(oid, c.h, 100),
        movable: free && c.type !== 'line' && c.locked !== true && !attachmentTarget(c, lookup),
      })
    })
    // From the source's top: a card in the gap between the source and the new card moves too.
    const pushes = pushDownPatches(newRect, others, BELOW_GAP, snap, src.y)
    id = ''
    doc.transact(() => {
      id = createCard(doc, type, { ...extra, x: at.x, y: at.y, w }, user.id)
      updateCards(doc, pushes, user.id, LOCAL_ORIGIN)
    }, LOCAL_ORIGIN)
  }
  const sel = useSelection.getState()
  sel.select([id])
  if (type === 'note' || type === 'column') sel.setEditing(id)
  return id
}

export function setColor(doc: Y.Doc, ids: Iterable<string>, color: CardColor | null) {
  const patches: Record<string, Record<string, unknown>> = {}
  for (const id of ids) {
    const m = getCardMap(doc, id)
    // A board card's color is also the child board's own color: update both, or the child's meta
    // would copy its old color back onto the card the next time it loads.
    if (m?.get('type') === 'board') void updateBoardAppearance(doc, id, (m.get('boardId') as string) || null, { color })
    else patches[id] = { color }
  }
  updateCards(doc, patches, getUser().id)
}

// ---------------------------------------------------------------------------
// Clipboard

/** In-memory fallback when the system clipboard cannot carry our custom format. */
let memoryClipboard: { data: string; text: string } | null = null

export function copySelection(doc: Y.Doc, e?: ClipboardEvent): boolean {
  return copyCards(doc, Array.from(useSelection.getState().selected), e)
}

/** Puts `ids` on the clipboard (our format, plain text and HTML). Returns false when there is nothing to copy. */
function copyCards(doc: Y.Doc, ids: readonly string[], e?: ClipboardEvent): boolean {
  if (!ids.length) return false
  const data = bytesToBase64Url(serializeCards(doc, ids))
  const text = cardsToPlainText(doc, ids)
  memoryClipboard = { data, text }
  if (e?.clipboardData) {
    e.clipboardData.setData(CLIPBOARD_MIME, data)
    e.clipboardData.setData('text/plain', text || ' ')
    // Marker in HTML so a paste in another window of this app can find the cards; the rest is rich
    // text for other apps (mail, word processors).
    let html = ''
    try {
      html = cardsToHtml(doc, ids)
    } catch (err) {
      console.warn('Could not render cards as HTML', err)
    }
    e.clipboardData.setData('text/html', `<meta name="noema-cards" content="${data}">${html || escapeHtml(text)}`)
    e.preventDefault()
  } else {
    void navigator.clipboard?.writeText(text).catch(() => {})
  }
  return true
}

/**
 * Cuts the cards of the selection that may be deleted. Locked cards are neither copied nor deleted
 * (a cut and paste moves a group without duplicating its locked cards); they stay selected, with a
 * toast saying why.
 */
export function cutSelection(doc: Y.Doc, e?: ClipboardEvent) {
  const sel = useSelection.getState()
  if (!sel.selected.size) return
  const { deletable, kept } = splitLocked(doc, sel.selected)
  if (deletable.length) {
    if (copyCards(doc, deletable, e)) deleteCards(doc, deletable, getUser().id)
  } else {
    // Nothing to cut: leave the clipboard as it was.
    e?.preventDefault()
  }
  if (kept.length) {
    sel.select(kept)
    toast(LOCKED_KEPT_MESSAGE)
  } else sel.clear()
}

/** Pastes our own card format if present. Returns true if handled. */
export function pasteCards(doc: Y.Doc, e: ClipboardEvent | null, at?: { x: number; y: number }): boolean {
  let data = e?.clipboardData?.getData(CLIPBOARD_MIME) || ''
  if (!data) {
    const html = e?.clipboardData?.getData('text/html') || ''
    const m = html.match(/<meta name="noema-cards" content="([A-Za-z0-9_-]+)">/)
    if (m) data = m[1]
  }
  if (!data && memoryClipboard && e?.clipboardData) {
    // Only use the memory clipboard when the system clipboard still holds our text.
    const text = e.clipboardData.getData('text/plain')
    if (text && text === (memoryClipboard.text || ' ')) data = memoryClipboard.data
  }
  if (!data) return false
  let group
  try {
    group = deserializeCards(base64UrlToBytes(data))
  } catch {
    return false
  }
  if (!group.length) return false
  const target = at ?? pasteTarget()
  // Pasted board cards get their own new boards (copies), never the original's id and secret.
  const forks = forkBoardCards(group)
  const ids = insertClonedCards(doc, group, target, getUser().id, { heightOf: renderedHeight })
  void fillForkedBoards(doc.guid, forks)
  const top = ids.filter((id) => !getCardMap(doc, id)?.get('parent'))
  useSelection.getState().select(top.length ? top : ids)
  e?.preventDefault()
  return true
}

let lastPointer: { x: number; y: number } | null = null
/** Canvas reports the last pointer position (board coords) so pastes land under the mouse. */
export function setLastPointer(p: { x: number; y: number } | null) {
  lastPointer = p
}

export function pasteTarget(): { x: number; y: number } {
  const r = visibleBoardRect()
  if (lastPointer && lastPointer.x > r.x && lastPointer.x < r.x + r.w && lastPointer.y > r.y && lastPointer.y < r.y + r.h)
    return { x: snap(lastPointer.x), y: snap(lastPointer.y) }
  const c = viewCenter()
  return { x: snap(c.x - 150), y: snap(c.y - 60) }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}

// ---------------------------------------------------------------------------
// Moving cards into another board

/**
 * A board that cards of `doc` may be moved into: a valid, known (secret in the library) board that
 * is not Home and not `doc` itself. Cards moved anywhere else would land in a doc nobody can open.
 */
export function isMoveTargetBoard(doc: Y.Doc, boardId: string): boolean {
  return isValidId(boardId) && boardId !== HOME_BOARD_ID && boardId !== doc.guid && !!getLibraryEntry(boardId)?.secret
}

/** True when `ids` (with column children) can be moved into `boardId`: never a board into itself. */
export function canMoveIntoBoard(doc: Y.Doc, ids: Iterable<string>, boardId: string): boolean {
  if (!isMoveTargetBoard(doc, boardId)) return false
  for (const id of expandSelection(doc, ids)) {
    const m = getCardMap(doc, id)
    if (m?.get('type') === 'board' && m.get('boardId') === boardId) return false
  }
  return true
}

export interface MoveIntoBoardOptions {
  /** Top-left of the moved group in the target board (default: right of its content). */
  at?: { x: number; y: number }
  /** Land in the target's Unsorted drawer (default: the user's "unsorted on move" preference). */
  unsorted?: boolean
}

/** Moves cards into another board, by default to the right of its content or into its Unsorted drawer. */
export async function moveIntoBoard(doc: Y.Doc, ids: string[], boardId: string, opts: MoveIntoBoardOptions = {}) {
  if (!canMoveIntoBoard(doc, ids, boardId)) return
  const user = getUser()
  const unsorted = opts.unsorted ?? useCanvasPrefs.getState().unsortedOnMove
  await docs.withDoc(boardId, (child) => {
    // The doc may have changed while the child loaded.
    if (doc.isDestroyed || !canMoveIntoBoard(doc, ids, boardId)) return
    let at = opts.at
    if (!at) {
      let maxX = 0
      let minY = Infinity
      forEachActiveCard(child, (m) => {
        if (m.get('parent') || !onCanvas(m)) return
        const c = readCard(m)
        if (c.type === 'line') return
        maxX = Math.max(maxX, c.x + c.w)
        minY = Math.min(minY, c.y)
      })
      at = { x: snap(maxX + 40), y: snap(Number.isFinite(minY) ? minY : 40) }
    }
    // Not an object literal: the unsorted option is data's addition to the insert options.
    const insert: InsertOptions & { unsorted?: boolean } = { heightOf: renderedHeight, unsorted }
    const target = at
    trackMove(doc, child, () => moveCardsToBoard(doc, child, ids, target, user.id, insert))
  })
  useSelection.getState().clear()
}

// ---------------------------------------------------------------------------
// Zoom helpers

export function zoomTo(zoom: number, around?: { clientX: number; clientY: number }) {
  const { viewport, setViewport } = useView.getState()
  const r = canvasRect()
  const cx = around ? around.clientX - r.left : r.width / 2
  const cy = around ? around.clientY - r.top : r.height / 2
  const z = clampZoom(zoom)
  const bx = (cx - viewport.x) / viewport.zoom
  const by = (cy - viewport.y) / viewport.zoom
  setViewport({ x: cx - bx * z, y: cy - by * z, zoom: z })
}

export function zoomBy(factor: number) {
  zoomTo(useView.getState().viewport.zoom * factor)
}

/** Fits all free cards in view. */
export function zoomToFit(doc: Y.Doc) {
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  forEachActiveCard(doc, (m, id) => {
    if (m.get('parent') || !onCanvas(m)) return
    const c = readCard(m)
    if (c.type === 'line') {
      for (const p of [c.from, c.to]) {
        // Attached ends store only a last-known position; their card is already in the bounds.
        if (p.card) continue
        x1 = Math.min(x1, p.x)
        y1 = Math.min(y1, p.y)
        x2 = Math.max(x2, p.x)
        y2 = Math.max(y2, p.y)
      }
      return
    }
    const h = c.h ?? measuredSize(id)?.h ?? 120
    x1 = Math.min(x1, c.x)
    y1 = Math.min(y1, c.y)
    x2 = Math.max(x2, c.x + c.w)
    y2 = Math.max(y2, c.y + h)
  })
  if (!Number.isFinite(x1)) {
    useView.getState().setViewport({ x: 80, y: 60, zoom: 1 })
    return
  }
  zoomToRect({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }, { padding: 60, maxZoom: 1.5 })
}

/** Centres a board rect in view, zoomed to fit with `padding` screen px around it (at most maxZoom). */
export function zoomToRect(r: Rect, opts: { padding?: number; maxZoom?: number } = {}) {
  const pad = opts.padding ?? 60
  const c = canvasRect()
  const w = Math.max(1, r.w)
  const h = Math.max(1, r.h)
  const fit = Math.min((c.width - pad * 2) / w, (c.height - pad * 2) / h)
  const zoom = clampZoom(Math.min(opts.maxZoom ?? MAX_ZOOM, Number.isFinite(fit) && fit > 0 ? fit : 1))
  useView.getState().setViewport({
    x: (c.width - w * zoom) / 2 - r.x * zoom,
    y: (c.height - h * zoom) / 2 - r.y * zoom,
    zoom,
  })
}

/** Zooms to the selected cards (Shift+2). Does nothing without a selection. */
export function zoomToSelection(doc: Y.Doc) {
  const rects: Rect[] = []
  for (const id of useSelection.getState().selected) {
    const m = getCardMap(doc, id)
    if (!m || !onCanvas(m)) continue
    const r = cardBounds(indexedCard(id, readCard(m)))
    if (r) rects.push(r)
  }
  const u = unionRects(rects)
  if (u) zoomToRect(u, { padding: 60, maxZoom: 2 })
}

/** IndexedCard view of a card read straight from the doc (same shape the CardIndex produces). */
export function indexedCard(id: string, card: Card): IndexedCard {
  const { type, x, y, w, h, z, parent, order } = card
  return { id, type, x, y, w, h, z, parent, order, unsorted: card.unsorted === true, card }
}

/** Scrolls so the given board point is centred. */
export function centerOn(p: { x: number; y: number }) {
  const { viewport, setViewport } = useView.getState()
  const r = canvasRect()
  setViewport({ ...viewport, x: r.width / 2 - p.x * viewport.zoom, y: r.height / 2 - p.y * viewport.zoom })
}
