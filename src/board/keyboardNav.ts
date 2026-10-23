/**
 * Keyboard navigation between cards (Tab, Alt+Arrow), keyboard reordering inside columns, and the
 * screen-reader announcement of the card reached. The maths lives in spatialNav.ts.
 */
import { create } from 'zustand'
import * as Y from 'yjs'
import type { BoardContextValue } from './BoardContext'
import type { IndexedCard } from './cardIndex'
import { cardBounds, elementBoardRect, getCanvasElement, visibleBoardRect, type Rect } from './geometry'
import { insideInset, nextInDirection, readingOrder, tabStep, type NavCandidate, type NavDirection, type ReadingItem } from './spatialNav'
import { useSelection } from './store'
import { centerOn, viewCenter } from './actions'
import { columnChildren, insertIntoColumn, isParked } from '../model/board'
import { getDefinition } from '../cards/registry'
import { cardText } from '../ui/search/collect'
import { getUser } from '../collab/identity'
import { isPinnedComment } from '../cards/structure/attach'

/** Polite screen-reader message for the card reached by keyboard (rendered by Canvas). */
export const useAnnouncement = create<{ text: string; set: (text: string) => void }>((set) => ({
  text: '',
  set: (text) => set({ text }),
}))

const LABEL_MAX = 80

/** Accessible name of a card: its title or first line of text, else its type. */
export function cardLabel(c: { type: IndexedCard['type'] }, map: Y.Map<unknown> | undefined): string {
  const typeLabel = getDefinition(c.type)?.label ?? 'Card'
  let text = ''
  try {
    const t = map ? cardText(map) : null
    text = t ? (t.title || t.body).split('\n').find((l) => l.trim())?.trim() ?? '' : ''
  } catch {
    text = ''
  }
  if (!text) return typeLabel
  return text.length > LABEL_MAX ? text.slice(0, LABEL_MAX - 1).trimEnd() + '…' : text
}

const inLiveColumn = (board: BoardContextValue, c: IndexedCard) => !!c.parent && board.index.get(c.parent)?.type === 'column'

/** Rect of a navigable card: free cards from the index, column children from the DOM (null when not mounted). */
function navRect(board: BoardContextValue, c: IndexedCard): Rect | null {
  const lookup = (id: string) => board.index.get(id)
  // Cards hidden with the Unsorted drawer (their column or the card they are pinned to included).
  if (c.type === 'line' || isParked(lookup, c.id)) return null
  // Pinned comments are drawn as markers on their card, not as cards.
  if (isPinnedComment(c, lookup)) return null
  if (inLiveColumn(board, c)) return elementBoardRect(c.id)
  return cardBounds(c)
}

interface NavItem extends ReadingItem {
  card: IndexedCard
}

/** Active, on-canvas, non-line cards with a known rect. */
function navItems(board: BoardContextValue): NavItem[] {
  const out: NavItem[] = []
  for (const c of board.index.getSnapshot()) {
    const rect = navRect(board, c)
    if (!rect) continue
    out.push({ id: c.id, rect, parent: inLiveColumn(board, c) ? c.parent : null, order: c.order, card: c })
  }
  return out
}

/** The card keyboard navigation starts from: the focused one, else a single selected card. */
function currentCard(): string | null {
  const { kbFocus, selected } = useSelection.getState()
  if (kbFocus && selected.has(kbFocus)) return kbFocus
  if (selected.size === 1) return selected.values().next().value as string
  return null
}

/** Selects a card reached by keyboard, scrolls it into view and announces it. */
export function focusCardByKeyboard(board: BoardContextValue, id: string, order?: readonly string[]) {
  const sel = useSelection.getState()
  if (sel.editing) sel.setEditing(null)
  sel.select([id])
  sel.setKbFocus(id)
  const canvas = getCanvasElement()
  if (canvas && document.activeElement !== canvas) canvas.focus({ preventScroll: true })
  const c = board.index.get(id)
  const rect = c ? navRect(board, c) : null
  if (rect && !insideInset(rect, visibleBoardRect(), 40)) centerOn({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })
  if (!c) return
  const list = order ?? readingOrder(navItems(board))
  const pos = list.indexOf(id)
  const type = getDefinition(c.type)?.label ?? 'Card'
  const label = cardLabel(c, board.cards.get(id))
  const where = pos >= 0 ? ` ${pos + 1} of ${list.length}` : ''
  const locked = c.card.locked === true ? ', locked' : ''
  useAnnouncement.getState().set(`${type}${where}: ${label}${locked}`)
}

/**
 * Tab / Shift+Tab. Returns false at either end, and for Shift+Tab with no current card, so the key
 * can move focus out of the canvas.
 */
export function tabToCard(board: BoardContextValue, back: boolean): boolean {
  const order = readingOrder(navItems(board))
  const i = tabStep(order, currentCard(), back)
  if (i === null) return false
  focusCardByKeyboard(board, order[i], order)
  return true
}

/** Alt+Arrow: the nearest card in a direction, or the card nearest the view centre with no start. */
export function moveFocus(board: BoardContextValue, dir: NavDirection): boolean {
  const items = navItems(board)
  if (!items.length) return false
  const fromId = currentCard()
  const from = fromId ? items.find((i) => i.id === fromId) : undefined
  if (!from) {
    const c = viewCenter()
    let best: NavItem | null = null
    let bestD = Infinity
    for (const it of items) {
      const d = Math.hypot(it.rect.x + it.rect.w / 2 - c.x, it.rect.y + it.rect.h / 2 - c.y)
      if (d < bestD) {
        bestD = d
        best = it
      }
    }
    if (!best) return false
    focusCardByKeyboard(board, best.id)
    return true
  }
  // Inside a column, up and down step through the siblings.
  if (from.parent && (dir === 'up' || dir === 'down')) {
    const siblings = items.filter((i) => i.parent === from.parent).sort((a, b) => ((a.order ?? '') < (b.order ?? '') ? -1 : 1))
    const at = siblings.findIndex((s) => s.id === from.id)
    const next = siblings[at + (dir === 'up' ? -1 : 1)]
    if (next) {
      focusCardByKeyboard(board, next.id)
      return true
    }
  }
  // Down from an open column enters it.
  if (!from.parent && from.card.type === 'column' && dir === 'down') {
    const first = items.filter((i) => i.parent === from.id).sort((a, b) => ((a.order ?? '') < (b.order ?? '') ? -1 : 1))[0]
    if (first) {
      focusCardByKeyboard(board, first.id)
      return true
    }
  }
  // Spatial search: never into the card's own column or the column's own children.
  const candidates: NavCandidate[] = items
    .filter((i) => i.id !== from.id && i.id !== from.parent && !(i.parent && i.parent === from.id))
    .map((i) => ({ id: i.id, rect: i.rect }))
  const next = nextInDirection(from.rect, candidates, dir)
  if (!next) return false
  focusCardByKeyboard(board, next)
  return true
}

/** Alt+Shift+Up/Down on one card inside a column: moves it one place up or down (one undo step). */
export function reorderInColumn(board: BoardContextValue, dir: -1 | 1): boolean {
  const { selected } = useSelection.getState()
  if (board.readOnly || selected.size !== 1) return false
  const id = selected.values().next().value as string
  const c = board.index.get(id)
  if (!c || !c.parent || board.index.get(c.parent)?.type !== 'column') return false
  if (c.card.locked === true) return true
  const siblings = columnChildren(board.doc, c.parent)
  const i = siblings.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= siblings.length) return true
  board.undo.stopCapturing()
  insertIntoColumn(board.doc, [id], c.parent, j, getUser().id)
  useSelection.getState().setKbFocus(id)
  const label = cardLabel(c, board.cards.get(id))
  useAnnouncement.getState().set(`${label} moved to position ${j + 1} of ${siblings.length}`)
  return true
}
