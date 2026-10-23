import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import {
  columnChildren,
  forEachActiveCard,
  getCardMap,
  getCards,
  initBoardDoc,
  isValidOrderKey,
  LOCAL_ORIGIN,
  readCard,
  SYSTEM_ORIGIN,
} from '../model/board'
import { CARD_COLORS, CARD_TYPES, COLUMN_CHILD_TYPES, GRID, type Card, type CardType } from '../model/types'
import { getStaticSchema } from '../editor/extensions'
import { fragmentToHtml, isFragmentProjectable } from '../editor/staticHtml'
import { readThread } from '../cards/structure/thread'
import { isHex6 } from '../cards/creative/color'
import { sanitizeIcon } from '../cards/structure/helpers'
import { BLANK_BOARD, getTemplate, TEMPLATE_CHOICES, TEMPLATES, TEMPLATE_IDS, type BoardTemplate, type TemplateId } from './registry'
import { estimateCardHeight } from './writer'

function buildBoard(t: BoardTemplate): Y.Doc {
  const doc = new Y.Doc({ guid: 'board-' + t.id })
  initBoardDoc(doc, { id: doc.guid, title: t.name }, 'me')
  t.build(doc, 'me')
  return doc
}

function activeCards(doc: Y.Doc): Card[] {
  const out: Card[] = []
  forEachActiveCard(doc, (m) => out.push(readCard(m)))
  return out
}

function fragments(doc: Y.Doc): Y.XmlFragment[] {
  const out: Y.XmlFragment[] = []
  forEachActiveCard(doc, (m) => {
    for (const field of ['content', 'caption']) {
      const f = m.get(field)
      if (f instanceof Y.XmlFragment && f.length) out.push(f)
    }
  })
  return out
}

/** Element names, attributes and text deltas of a fragment, in order. */
function dump(node: Y.XmlFragment | Y.XmlElement): unknown[] {
  return node.toArray().map((c) =>
    c instanceof Y.XmlElement
      ? { name: c.nodeName, attrs: c.getAttributes(), children: dump(c) }
      : { text: (c as Y.XmlText).toDelta() },
  )
}

const allHtml = (doc: Y.Doc) => fragments(doc).map(fragmentToHtml).join('\n')

const isFree = (c: Card) => c.parent === null && c.type !== 'line'

const EXPECTED_HEADINGS: Record<TemplateId, string[]> = {
  'project-plan': ['<h1>Project plan</h1>', '<h3>Research</h3>'],
  'weekly-planner': ['<h1>Weekly planner</h1>'],
  brainstorm: ['<h1>Main topic</h1>', '<h3>What if…?</h3>', '<h3>Wild card</h3>'],
  moodboard: ['<h1>Moodboard</h1>', '<h3>Tone</h3>', '<h3>Typography</h3>', '<h3>Drag images here</h3>'],
  'meeting-notes': ['<h1>Meeting notes</h1>', '<h2>Agenda</h2>', '<h2>Notes</h2>', '<h2>Decisions</h2>'],
  retrospective: ['<h1>Retrospective</h1>'],
  storyboard: ['<h1>Storyboard</h1>', '<h1>1</h1>', '<h1>6</h1>', '<h3>Hook</h3>'],
}

describe('template registry', () => {
  it('offers the blank board and seven templates with unique ids', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([...TEMPLATE_IDS])
    expect(TEMPLATE_CHOICES[0]).toBe(BLANK_BOARD)
    expect(new Set(TEMPLATE_CHOICES.map((t) => t.id)).size).toBe(TEMPLATE_CHOICES.length)
    for (const t of TEMPLATE_CHOICES) expect(getTemplate(t.id)).toBe(t)
    expect(getTemplate('nope')).toBeUndefined()
  })

  it('gives every template a name, description, valid color and a valid board icon', () => {
    for (const t of TEMPLATE_CHOICES) {
      expect(t.name).toBeTruthy()
      expect(t.description.length).toBeGreaterThan(10)
      expect(t.description.length).toBeLessThanOrEqual(60)
      expect(t.icon).toBeTruthy()
      if (t.color !== null) expect(CARD_COLORS).toContain(t.color)
      if (t.boardIcon !== null) expect(sanitizeIcon(t.boardIcon)).toBe(t.boardIcon)
    }
  })

  it('the blank board stays empty', () => {
    const doc = buildBoard(BLANK_BOARD)
    expect(getCards(doc).size).toBe(0)
  })
})

describe.each(TEMPLATES.map((t) => [t.id, t] as const))('template %s', (id, template) => {
  it('builds into a fresh doc with only known card types', () => {
    const doc = buildBoard(template)
    const cards = activeCards(doc)
    expect(cards.length).toBeGreaterThanOrEqual(3)
    const known = new Set<string>(CARD_TYPES)
    for (const c of cards) expect(known.has(c.type)).toBe(true)
    for (const c of cards) if (c.color !== null) expect(CARD_COLORS).toContain(c.color)
  })

  it('writes everything in one non-undoable transaction', () => {
    const doc = new Y.Doc()
    initBoardDoc(doc, { id: 'b1' }, 'me')
    const undo = new Y.UndoManager([getCards(doc)], { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    template.build(doc, 'me')
    expect(origins).toEqual([SYSTEM_ORIGIN])
    expect(undo.undoStack.length).toBe(0)
  })

  it('leaves a board that already has cards alone', () => {
    const doc = buildBoard(template)
    const before = Y.encodeStateVector(doc)
    template.build(doc, 'me')
    expect(Y.encodeStateVector(doc)).toEqual(before)
  })

  it('attaches both ends of every line to existing cards', () => {
    const doc = buildBoard(template)
    const cards = activeCards(doc)
    const ids = new Set(cards.filter((c) => c.type !== 'line').map((c) => c.id))
    for (const c of cards) {
      if (c.type !== 'line') continue
      expect(c.from.card && ids.has(c.from.card)).toBe(true)
      expect(c.to.card && ids.has(c.to.card)).toBe(true)
      expect(c.from.card).not.toBe(c.to.card)
    }
  })

  it('stacks column children with valid, distinct order keys', () => {
    const doc = buildBoard(template)
    const cards = activeCards(doc)
    const columns = new Set(cards.filter((c) => c.type === 'column').map((c) => c.id))
    for (const c of cards) {
      if (c.parent === null) continue
      expect(columns.has(c.parent)).toBe(true)
      expect(COLUMN_CHILD_TYPES.has(c.type as CardType)).toBe(true)
      expect(isValidOrderKey(c.order)).toBe(true)
    }
    for (const col of columns) {
      const kids = columnChildren(doc, col)
      const keys = kids.map((k) => readCard(getCardMap(doc, k)!).order)
      expect(new Set(keys).size).toBe(keys.length)
      expect([...keys].sort()).toEqual(keys)
    }
  })

  it('renders its rich text with the expected headings', () => {
    const doc = buildBoard(template)
    const html = allHtml(doc)
    for (const h of EXPECTED_HEADINGS[id as TemplateId]) expect(html).toContain(h)
    for (const f of fragments(doc)) {
      expect(isFragmentProjectable(f)).toBe(true)
      expect(fragmentToHtml(f)).not.toBe('')
    }
  })

  it('writes rich text exactly as the editor binding would (nothing to rewrite on first edit)', () => {
    const doc = buildBoard(template)
    for (const f of fragments(doc)) {
      const scratch = new Y.Doc()
      const copy = scratch.getXmlFragment('copy')
      prosemirrorJSONToYXmlFragment(getStaticSchema(), yXmlFragmentToProsemirrorJSON(f), copy)
      expect(dump(f)).toEqual(dump(copy))
    }
  })

  it('places free cards on the grid without overlapping', () => {
    const doc = buildBoard(template)
    const free = activeCards(doc).filter(isFree)
    const spots = new Set<string>()
    for (const c of free) {
      expect(c.x % GRID === 0).toBe(true)
      expect(c.y % GRID === 0).toBe(true)
      const key = `${c.x},${c.y}`
      expect(spots.has(key)).toBe(false)
      spots.add(key)
    }
    const rects = free.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: estimateCardHeight(doc, c.id) }))
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]
        const b = rects[j]
        const overlap = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
        expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false)
      }
    }
  })
})

describe('template details', () => {
  it('moodboard has five named swatches with normalized hex colors and an Inspiration column', () => {
    const doc = buildBoard(getTemplate('moodboard')!)
    const cards = activeCards(doc)
    const swatches = cards.filter((c) => c.type === 'swatch')
    expect(swatches).toHaveLength(5)
    for (const s of swatches) {
      expect(isHex6(s.hex)).toBe(true)
      expect(s.name).toBeTruthy()
    }
    const ys = new Set(swatches.map((s) => s.y))
    expect(ys.size).toBe(1)
    const col = cards.find((c) => c.type === 'column')
    expect(col && col.type === 'column' && col.title).toBe('Inspiration')
    const kids = columnChildren(doc, col!.id)
    expect(kids).toHaveLength(1)
    expect(fragmentToHtml(getCardMap(doc, kids[0])!.get('content') as Y.XmlFragment)).toContain('Drag images here')
  })

  it('project plan and retrospective use the expected columns in order', () => {
    const titles = (id: TemplateId) =>
      activeCards(buildBoard(getTemplate(id)!))
        .filter((c) => c.type === 'column')
        .sort((a, b) => a.x - b.x)
        .map((c) => (c.type === 'column' ? c.title : ''))
    expect(titles('project-plan')).toEqual(['To do', 'In progress', 'Done'])
    expect(titles('retrospective')).toEqual(['Went well', 'To improve', 'Ideas', 'Action items'])
    expect(titles('weekly-planner')).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
  })

  it('weekly planner columns sit in one aligned row', () => {
    const cols = activeCards(buildBoard(getTemplate('weekly-planner')!)).filter((c) => c.type === 'column')
    expect(new Set(cols.map((c) => c.y)).size).toBe(1)
    const xs = cols.map((c) => c.x).sort((a, b) => a - b)
    const steps = new Set(xs.slice(1).map((x, i) => x - xs[i]))
    expect(steps.size).toBe(1)
  })

  it('brainstorm connects the main topic to six ideas', () => {
    const doc = buildBoard(getTemplate('brainstorm')!)
    const cards = activeCards(doc)
    const lines = cards.filter((c) => c.type === 'line')
    expect(lines).toHaveLength(6)
    const hubs = new Set(lines.map((l) => (l.type === 'line' ? l.from.card : null)))
    expect(hubs.size).toBe(1)
    const ideas = new Set(lines.map((l) => (l.type === 'line' ? l.to.card : null)))
    expect(ideas.size).toBe(6)
  })

  it('storyboard chains six frames left to right with arrows', () => {
    const doc = buildBoard(getTemplate('storyboard')!)
    const cards = activeCards(doc)
    const byId = new Map(cards.map((c) => [c.id, c]))
    const lines = cards.filter((c) => c.type === 'line')
    expect(lines).toHaveLength(5)
    for (const l of lines) {
      if (l.type !== 'line') continue
      expect(l.arrowEnd).toBe(true)
      const a = byId.get(l.from.card!)!
      const b = byId.get(l.to.card!)!
      expect(a.y).toBe(b.y)
      expect(b.x).toBeGreaterThan(a.x)
    }
  })

  it('meeting notes has action items and a comment with one message', () => {
    const doc = buildBoard(getTemplate('meeting-notes')!)
    const cards = activeCards(doc)
    const todo = cards.find((c) => c.type === 'todo')
    expect(todo && todo.type === 'todo' && todo.title).toBe('Action items')
    const comment = cards.find((c) => c.type === 'comment')!
    const thread = readThread(getCardMap(doc, comment.id)!.get('thread') as Y.Array<unknown>)
    expect(thread).toHaveLength(1)
    expect(thread[0].authorId).toBe('me')
    const html = fragmentToHtml(getCardMap(doc, todo!.id)!.get('content') as Y.XmlFragment)
    expect(html).toContain('<strong>@Alex</strong>')
    expect(html).toContain('data-type="taskItem"')
  })
})
