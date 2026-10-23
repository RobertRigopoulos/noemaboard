/**
 * Places template cards on a board doc through the model helpers.
 *
 * Notes, to-dos and comments have no stored height (it depends on how they render), so layouts
 * stack cards using a deliberately generous estimate of their rendered height: a little extra
 * space between cards is fine, overlapping cards are not.
 */
import * as Y from 'yjs'
import {
  columnChildren,
  createCard,
  getCardMap,
  getCards,
  insertIntoColumn,
  readCard,
  SYSTEM_ORIGIN,
  updateCard,
} from '../model/board'
import { GRID, type CardColor, type CardType } from '../model/types'
import { resolveLine, type Rect } from '../board/lines/geometry'
import { addComment } from '../cards/structure/thread'
import { writeBlocks, type Block } from './richText'

// `|| 0` keeps -0 out of the doc.
export const snapGrid = (v: number) => Math.round(v / GRID) * GRID || 0
const snapUp = (v: number) => Math.ceil(v / GRID) * GRID || 0

// ---------------------------------------------------------------------------
// Height estimates (board units). Based on the card and rich-text CSS, rounded up.

const LINE = 21
const CHAR = 7.6
const HEADINGS: Record<number, { line: number; char: number; margin: number }> = {
  1: { line: 28, char: 12.5, margin: 16 },
  2: { line: 24, char: 10.5, margin: 13 },
  3: { line: 21, char: 8.6, margin: 10 },
}

function textOf(node: Y.XmlElement | Y.XmlText): string {
  if (node instanceof Y.XmlText) {
    let s = ''
    for (const op of node.toDelta() as { insert?: unknown }[]) if (typeof op.insert === 'string') s += op.insert
    return s
  }
  return (node.toArray() as (Y.XmlElement | Y.XmlText)[]).map(textOf).join('')
}

function lineCount(text: string, width: number, char: number): number {
  return Math.max(1, Math.ceil((text.length * char) / Math.max(40, width)))
}

function itemsOf(el: Y.XmlElement): Y.XmlElement[] {
  return el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
}

function blockHeight(el: Y.XmlElement, width: number, taskGap: number): number {
  switch (el.nodeName) {
    case 'paragraph':
      return lineCount(textOf(el), width, CHAR) * LINE + 6
    case 'heading': {
      const h = HEADINGS[Number(el.getAttribute('level'))] ?? HEADINGS[3]
      return lineCount(textOf(el), width, h.char) * h.line + h.margin
    }
    case 'bulletList':
    case 'orderedList':
      return itemsOf(el).reduce((sum, li) => sum + lineCount(textOf(li), width - 22, CHAR) * LINE + 2, 6)
    case 'taskList':
      return itemsOf(el).reduce((sum, li) => sum + lineCount(textOf(li), width - 26, CHAR) * LINE + taskGap, 6)
    case 'blockquote':
      return itemsOf(el).reduce((sum, c) => sum + blockHeight(c, width - 16, taskGap), 12)
    default:
      return lineCount(textOf(el), width, CHAR) * LINE + 12
  }
}

/** Estimated rendered height of rich-text content laid out `width` units wide. */
export function estimateContentHeight(frag: Y.XmlFragment, width: number, taskGap = 6): number {
  const blocks = frag.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
  return blocks.reduce((sum, el) => sum + blockHeight(el, width, taskGap), 0)
}

/** Estimated rendered height of a card (stored height for explicitly sized cards). */
export function estimateCardHeight(doc: Y.Doc, id: string): number {
  const m = getCardMap(doc, id)
  if (!m) return 0
  const c = readCard(m)
  if (c.h !== undefined) return c.h
  const colorPad = c.color ? 3 : 0
  const content = m.get('content')
  const frag = content instanceof Y.XmlFragment ? content : null
  switch (c.type) {
    case 'note':
      return snapUp(28 + colorPad + (frag ? estimateContentHeight(frag, c.w - 32) : LINE))
    case 'todo': {
      const title = c.title ? 29 : 0
      const progress = frag && frag.length ? 22 : 0
      return snapUp(25 + colorPad + title + progress + (frag ? estimateContentHeight(frag, c.w - 28, 8) : LINE))
    }
    case 'comment': {
      const thread = m.get('thread')
      const text = thread instanceof Y.Array ? thread.toArray().map((t) => (t instanceof Y.Map ? String(t.get('text') ?? '') : '')).join(' ') : ''
      return snapUp(100 + lineCount(text, c.w - 60, CHAR) * 20)
    }
    case 'column': {
      const kids = columnChildren(doc, id)
      return snapUp(kids.reduce((sum, k) => sum + estimateCardHeight(doc, k) + 8, 50))
    }
    case 'board':
      return 80
    default:
      return 120
  }
}

// ---------------------------------------------------------------------------
// Writer

export type Place = { x: number; y: number } | { column: string }

export interface CardStyle {
  w?: number
  color?: CardColor | null
}

export interface LineStyle {
  arrowEnd?: boolean
  dashed?: boolean
  color?: CardColor | null
}

/** Author shown on comments that come with a template. */
const TIP_AUTHOR = { name: 'Tip', color: '#8b8d98' }

export class BoardWriter {
  readonly doc: Y.Doc
  readonly userId: string

  constructor(doc: Y.Doc, userId: string) {
    this.doc = doc
    this.userId = userId
  }

  private create(type: CardType, place: Place, fields: Record<string, unknown>): string {
    let x: number
    let y: number
    if ('column' in place) {
      // Ignored while the card sits in the column; the column's corner is a sensible fallback.
      const col = getCardMap(this.doc, place.column)
      x = Number(col?.get('x')) || 0
      y = Number(col?.get('y')) || 0
    } else {
      x = place.x
      y = place.y
    }
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
    const id = createCard(this.doc, type, { ...clean, x: snapGrid(x), y: snapGrid(y) }, this.userId)
    if ('column' in place) insertIntoColumn(this.doc, [id], place.column, Number.MAX_SAFE_INTEGER, this.userId)
    return id
  }

  private fill(id: string, blocks: Block[]) {
    const frag = getCardMap(this.doc, id)?.get('content')
    if (frag instanceof Y.XmlFragment) writeBlocks(frag, blocks)
  }

  note(place: Place, blocks: Block[], style: CardStyle = {}): string {
    const id = this.create('note', place, { w: style.w, color: style.color ?? null })
    this.fill(id, blocks)
    return id
  }

  /** A to-do card; `list` is a task list built with tasks(). */
  todo(place: Place, title: string, list: Block, style: CardStyle = {}): string {
    const id = this.create('todo', place, { title, w: style.w, color: style.color ?? null })
    this.fill(id, [list])
    return id
  }

  column(at: { x: number; y: number }, title: string, style: CardStyle = {}): string {
    return this.create('column', at, { title, w: style.w, color: style.color ?? null })
  }

  swatch(at: { x: number; y: number }, hex: string, name: string): string {
    return this.create('swatch', at, { hex: hex.toLowerCase(), name })
  }

  /** A comment card opened with one message by the template's "Tip" author. */
  comment(at: { x: number; y: number }, text: string, style: CardStyle = {}): string {
    const id = this.create('comment', at, { w: style.w, color: style.color ?? null })
    const m = getCardMap(this.doc, id)
    if (m) addComment(this.doc, m, { id: this.userId, ...TIP_AUTHOR }, text)
    return id
  }

  /** A line attached to two cards; the stored end points are where it meets their edges now. */
  line(from: string, to: string, style: LineStyle = {}): string {
    const r = resolveLine({ from: { card: from, x: 0, y: 0 }, to: { card: to, x: 0, y: 0 }, bend: 0 }, (id) => this.rect(id))
    return this.create(
      'line',
      { x: 0, y: 0 },
      {
        from: { card: from, x: Math.round(r.a.x), y: Math.round(r.a.y) },
        to: { card: to, x: Math.round(r.b.x), y: Math.round(r.b.y) },
        arrowEnd: style.arrowEnd ?? true,
        dashed: style.dashed ?? false,
        color: style.color ?? null,
      },
    )
  }

  /** Moves a free card so its estimated centre is at (cx, cy). */
  centerOn(id: string, cx: number, cy: number) {
    const r = this.rect(id)
    if (!r) return
    updateCard(this.doc, id, { x: snapGrid(cx - r.w / 2), y: snapGrid(cy - r.h / 2) }, this.userId)
  }

  /** Estimated board rect of a free card. */
  rect(id: string): Rect | null {
    const m = getCardMap(this.doc, id)
    if (!m) return null
    const c = readCard(m)
    return { x: c.x, y: c.y, w: c.w, h: estimateCardHeight(this.doc, id) }
  }

  /** Grid-aligned y just below a card, `gap` units further down. */
  below(id: string, gap = 40): number {
    const r = this.rect(id)
    return r ? snapUp(r.y + r.h + gap) : 0
  }
}

/**
 * Turns a layout into a template build function: it only fills an empty doc, and writes in one
 * SYSTEM_ORIGIN transaction so the content is never undone as a single giant step.
 */
export function layout(fn: (w: BoardWriter) => void): (doc: Y.Doc, userId: string) => void {
  return (doc, userId) => {
    if (getCards(doc).size > 0) return
    doc.transact(() => fn(new BoardWriter(doc, userId)), SYSTEM_ORIGIN)
  }
}
