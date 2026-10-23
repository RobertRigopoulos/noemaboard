import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { getCards, readCard, xmlToText } from '../../model/board'
import { createLinkCard, createNoteFromText, linkFields, MAX_NOTE_CHARS, prepareNoteText } from './create'
import { needsPreview, STALE_LOADING_MS, ERROR_RETRY_MS, isLoadingStale, isPreviewStale, loadingSince, previewOwner } from './previewPolicy'

const U = 'user1'
const board = () => new Y.Doc({ guid: 'board-media-test' })

function paragraphs(doc: Y.Doc, id: string): string[] {
  const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
  return (frag.toArray() as Y.XmlElement[]).map((p) => {
    expect(p.nodeName).toBe('paragraph')
    return (p.toArray() as Y.XmlText[]).map((t) => t.toString()).join('')
  })
}

describe('notes from pasted/dropped text', () => {
  it('creates one paragraph per line, preserving blank lines', () => {
    const doc = board()
    const id = createNoteFromText(doc, 'first line\r\nsecond line\n\nafter blank\rold mac', { x: 10, y: 20 }, U)
    expect(paragraphs(doc, id)).toEqual(['first line', 'second line', '', 'after blank', 'old mac'])
    const card = readCard(getCards(doc).get(id)!)
    expect(card).toMatchObject({ type: 'note', x: 10, y: 20, createdBy: U })
    expect(xmlToText(getCards(doc).get(id)!.get('content') as Y.XmlFragment)).toBe('first line\nsecond line\n\nafter blank\nold mac')
  })

  it('drops leading/trailing blank lines but keeps indentation', () => {
    const doc = board()
    const id = createNoteFromText(doc, '\n\n  indented\n    more\n\n\n', {}, U)
    expect(paragraphs(doc, id)).toEqual(['  indented', '    more'])
  })

  it('strips control characters but keeps tabs', () => {
    expect(prepareNoteText('a\u0000b\tc\u0007').text).toBe('ab\tc')
  })

  it('creates nothing for whitespace-only text', () => {
    const doc = board()
    expect(createNoteFromText(doc, ' \n\t\n ', {}, U)).toBe('')
    expect(getCards(doc).size).toBe(0)
  })

  it('caps very long text', () => {
    const r = prepareNoteText('x'.repeat(MAX_NOTE_CHARS + 10))
    expect(r.truncated).toBe(true)
    expect(r.text).toHaveLength(MAX_NOTE_CHARS)
    expect(prepareNoteText('short').truncated).toBe(false)
  })
})

describe('link cards', () => {
  it('stores the URL, the detected embed and an idle preview owned by the creator', () => {
    const doc = board()
    const id = createLinkCard(doc, 'https://youtu.be/dQw4w9WgXcQ', { x: 0, y: 0 }, U)
    const m = getCards(doc).get(id)!
    const card = readCard(m) as unknown as Record<string, unknown>
    expect(card).toMatchObject({ type: 'link', url: 'https://youtu.be/dQw4w9WgXcQ', previewState: 'idle', previewBy: U, title: '' })
    expect(card.embed).toEqual({ provider: 'youtube', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', aspect: 16 / 9 })
    expect(m.get('caption')).toBeInstanceOf(Y.XmlFragment)
  })

  it('has no embed for ordinary pages', () => {
    expect(linkFields('https://example.com/', U).embed).toBeNull()
  })
})

describe('preview policy', () => {
  const now = 1_000_000_000
  const base = { url: 'https://example.com/', createdBy: U, updatedAt: now, previewState: 'idle' }

  it('lets only the responsible person fetch', () => {
    expect(needsPreview(base, U, now)).toBe(true)
    expect(needsPreview(base, 'someone-else', now)).toBe(false)
    expect(needsPreview({ ...base, previewBy: 'editor' }, 'editor', now)).toBe(true)
    expect(needsPreview({ ...base, previewBy: 'editor' }, U, now)).toBe(false)
    expect(previewOwner({ createdBy: U })).toBe(U)
    expect(needsPreview(base, '', now)).toBe(false)
  })

  it('needs a URL', () => {
    expect(needsPreview({ ...base, url: '' }, U, now)).toBe(false)
    expect(needsPreview({ ...base, url: 42 }, U, now)).toBe(false)
  })

  it('does not refetch finished previews of the same URL', () => {
    expect(needsPreview({ ...base, previewState: 'done', previewFor: base.url }, U, now)).toBe(false)
    expect(needsPreview({ ...base, previewState: 'done' }, U, now)).toBe(false)
    expect(needsPreview({ ...base, previewState: 'loading' }, U, now)).toBe(false)
  })

  it('refetches stale previews, stuck loads and old errors', () => {
    expect(isPreviewStale({ url: 'https://b.com/', previewFor: 'https://a.com/' })).toBe(true)
    expect(needsPreview({ ...base, previewState: 'done', previewFor: 'https://other.com/' }, U, now)).toBe(true)
    expect(needsPreview({ ...base, previewState: 'loading', updatedAt: now - STALE_LOADING_MS - 1 }, U, now)).toBe(true)
    expect(needsPreview({ ...base, previewState: 'error', previewFor: base.url }, U, now)).toBe(false)
    expect(needsPreview({ ...base, previewState: 'error', previewFor: base.url, updatedAt: now - ERROR_RETRY_MS - 1 }, U, now)).toBe(true)
  })
})

describe('preview policy: basic previews and abandoned fetches', () => {
  const now = 1_000_000_000
  const base = { url: 'https://example.com/', createdBy: U, updatedAt: now, previewState: 'idle' }

  it('does not refetch a basic (browser-made) preview of the same URL automatically', () => {
    expect(needsPreview({ ...base, previewState: 'basic', previewFor: base.url }, U, now)).toBe(false)
    expect(needsPreview({ ...base, previewState: 'basic', previewFor: 'https://other.com/' }, U, now)).toBe(true)
  })

  it('times a fetch from when it started, not from the last unrelated change to the card', () => {
    const started = now - STALE_LOADING_MS - 1
    const moved = { ...base, previewState: 'loading', previewStartedAt: started, updatedAt: now }
    expect(loadingSince(moved)).toBe(started)
    expect(isLoadingStale(moved, now)).toBe(true)
    expect(needsPreview(moved, U, now)).toBe(true)
    expect(isLoadingStale({ ...moved, previewStartedAt: now - 1000 }, now)).toBe(false)
    // Older clients do not write previewStartedAt.
    expect(loadingSince({ ...base, previewState: 'loading' })).toBe(now)
    expect(isLoadingStale({ ...base, previewState: 'done', previewStartedAt: 0 }, now)).toBe(false)
  })
})
