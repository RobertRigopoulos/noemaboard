import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { columnChildren, createCard, getCards, readCard, xmlToText } from '../../model/board'
import { createRichNote } from '../../editor/richNote'
import { handlePaste, isOfficeCopy } from './paste'
import { importBelowCard } from './importBelow'

// Formatted notes are the text group's: only the hand-over is tested here.
vi.mock('../../editor/richNote', () => ({ createRichNote: vi.fn(() => null) }))
// Node cannot decode pictures: any image file decodes as 40 x 30.
vi.mock('./image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./image')>()),
  processImageFile: vi.fn(async (file: Blob) => ({ blob: file, iw: 40, ih: 30, thumb: null })),
}))

function clipboard(data: { text?: string; html?: string; files?: File[] }) {
  const preventDefault = vi.fn()
  const e = {
    clipboardData: {
      files: data.files ?? [],
      items: [],
      types: [],
      getData: (t: string) => (t === 'text/plain' ? (data.text ?? '') : t === 'text/html' ? (data.html ?? '') : ''),
    },
    preventDefault,
  } as unknown as ClipboardEvent
  return { e, preventDefault }
}

const board = () => new Y.Doc({ guid: 'paste-test-board' })
const at = { x: 104, y: 57 }

describe('handlePaste', () => {
  it('turns multi-line text into a note, one paragraph per line', async () => {
    const doc = board()
    const { e, preventDefault } = clipboard({ text: 'Shopping\r\n- milk\n\n- bread' })
    const ids = await handlePaste(doc, e, at)
    expect(preventDefault).toHaveBeenCalled()
    expect(ids).toHaveLength(1)
    const m = getCards(doc).get(ids[0])!
    expect(readCard(m)).toMatchObject({ type: 'note', x: 100, y: 60 })
    expect(xmlToText(m.get('content') as Y.XmlFragment)).toBe('Shopping\n- milk\n\n- bread')
  })

  it('turns a single URL into a link card', async () => {
    const doc = board()
    const { e } = clipboard({ text: '  https://www.youtube.com/watch?v=dQw4w9WgXcQ  ' })
    const [id] = await handlePaste(doc, e, at)
    const card = readCard(getCards(doc).get(id)!) as unknown as Record<string, unknown>
    expect(card).toMatchObject({ type: 'link', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
    expect((card.embed as { provider: string }).provider).toBe('youtube')
    // Without the desktop app there is no page fetch: the host becomes the title, and 'basic' lets a
    // desktop teammate load the full preview later.
    await vi.waitFor(() => expect(getCards(doc).get(id)!.get('previewState')).toBe('basic'))
    expect(getCards(doc).get(id)!.get('title')).toBe('youtube.com')
  })

  it('keeps text that merely contains a URL as a note', async () => {
    const doc = board()
    const { e } = clipboard({ text: 'read this: https://example.com' })
    const [id] = await handlePaste(doc, e, at)
    expect(getCards(doc).get(id)!.get('type')).toBe('note')
  })

  it('stores pasted files as file cards (only the hash goes into the doc)', async () => {
    const doc = board()
    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' })
    const { e, preventDefault } = clipboard({ files: [file] })
    const [id] = await handlePaste(doc, e, at)
    expect(preventDefault).toHaveBeenCalled()
    const card = readCard(getCards(doc).get(id)!) as unknown as Record<string, unknown>
    expect(card).toMatchObject({ type: 'file', name: 'notes.txt', size: 11, mime: 'text/plain' })
    expect(card.blob).toMatch(/^[0-9a-f]{64}$/)
  })

  it('lays out several files in a grid', async () => {
    const doc = board()
    const files = [1, 2, 3, 4].map((i) => new File([`file ${i}`], `f${i}.bin`))
    const { e } = clipboard({ files })
    const ids = await handlePaste(doc, e, { x: 0, y: 0 })
    const pos = ids.map((id) => {
      const c = readCard(getCards(doc).get(id)!)
      return [c.x, c.y]
    })
    expect(pos).toEqual([
      [0, 0],
      [320, 0],
      [640, 0],
      [0, 90],
    ])
  })

  it('prefers the text of an Office copy over its picture', async () => {
    const doc = board()
    const picture = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    const { e } = clipboard({ files: [picture], text: 'A\tB\n1\t2', html: '<table><tr><td>A</td></tr></table>' })
    const [id] = await handlePaste(doc, e, at)
    expect(getCards(doc).get(id)!.get('type')).toBe('note')
  })

  it('does nothing (and lets the paste through) when there is nothing to add', async () => {
    const doc = board()
    const { e, preventDefault } = clipboard({ text: '   ', html: '<b></b>' })
    expect(await handlePaste(doc, e, at)).toEqual([])
    expect(preventDefault).not.toHaveBeenCalled()
    expect(getCards(doc).size).toBe(0)
  })

  it('hands formatted text (HTML) to createRichNote, which makes one note', async () => {
    const doc = board()
    const rich = vi.mocked(createRichNote)
    rich.mockClear()
    rich.mockImplementationOnce((d, _source, fields, userId) => createCard(d, 'note', fields, userId))
    const html = '<h1>Trip</h1><ul><li>Tickets</li><li>Hotel</li></ul>'
    const { e, preventDefault } = clipboard({ text: 'Trip\nTickets\nHotel', html })
    const ids = await handlePaste(doc, e, at)
    expect(preventDefault).toHaveBeenCalled()
    expect(rich).toHaveBeenCalledTimes(1)
    expect(rich.mock.calls[0][1]).toEqual({ html, text: 'Trip\nTickets\nHotel' })
    expect(rich.mock.calls[0][2]).toEqual({ x: 100, y: 60 })
    expect(ids).toHaveLength(1)
    expect(getCards(doc).size).toBe(1)
    expect(readCard(getCards(doc).get(ids[0])!)).toMatchObject({ type: 'note', x: 100, y: 60 })
  })

  it('keeps Office copies as plain text (no HTML handed over)', async () => {
    const doc = board()
    const rich = vi.mocked(createRichNote)
    rich.mockClear()
    const picture = new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' })
    const html = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><p>Hello</p><img src="x.png"></html>'
    expect(isOfficeCopy([picture], 'Hello', html)).toBe(true)
    const { e } = clipboard({ files: [picture], text: 'Hello', html })
    const [id] = await handlePaste(doc, e, at)
    expect(rich.mock.calls[0][1]).toEqual({ html: null, text: 'Hello' })
    expect(getCards(doc).get(id)!.get('type')).toBe('note')
  })
})

describe('importBelowCard', () => {
  const screenshot = () => new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], 'image.png', { type: 'image/png' })

  it('puts a pasted screenshot under a free note', async () => {
    const doc = board()
    const note = createCard(doc, 'note', { x: 100, y: 200, h: 80 }, 'me')
    const ids = await importBelowCard(doc, note, [screenshot()])
    expect(ids).toHaveLength(1)
    const card = readCard(getCards(doc).get(ids[0])!) as unknown as Record<string, unknown>
    // Under the note's stored height plus a 20 unit gap.
    expect(card).toMatchObject({ type: 'image', x: 100, y: 300, parent: null, iw: 40, ih: 30 })
    expect(String(card.name)).toMatch(/^Pasted image \d{4}-\d{2}-\d{2}/)
  })

  it('falls back to a default height when the note was never measured', async () => {
    const doc = board()
    const note = createCard(doc, 'note', { x: 0, y: 0 }, 'me')
    const [id] = await importBelowCard(doc, note, [screenshot()])
    expect(readCard(getCards(doc).get(id)!)).toMatchObject({ x: 0, y: 140 })
  })

  it('inserts right after a card in a column', async () => {
    const doc = board()
    const column = createCard(doc, 'column', { x: 500, y: 40 }, 'me')
    const first = createCard(doc, 'note', { parent: column, order: 'a1' }, 'me')
    const second = createCard(doc, 'note', { parent: column, order: 'a2' }, 'me')
    const [id] = await importBelowCard(doc, first, [screenshot()])
    expect(columnChildren(doc, column)).toEqual([first, id, second])
    expect(getCards(doc).get(id)!.get('type')).toBe('image')
  })

  it('adds nothing for a card that is gone', async () => {
    const doc = board()
    expect(await importBelowCard(doc, 'missing', [screenshot()])).toEqual([])
    expect(getCards(doc).size).toBe(0)
  })
})
