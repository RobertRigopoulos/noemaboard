import { beforeEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard } from '../../model/board'
import { useToasts } from '../../ui/toast'
import { copyImageCardToClipboard, copyImageMessage, imageClipboardHtml } from './clipboardImage'

describe('copyImageMessage', () => {
  it('explains every failure of the explicit Copy image action', () => {
    expect(copyImageMessage('unsupported', true)?.kind).toBe('error')
    expect(copyImageMessage('failed', true)?.kind).toBe('error')
    expect(copyImageMessage('not-here', true)?.text).toMatch(/isn’t on this device/)
  })

  it('says nothing alarming when the card itself was copied', () => {
    expect(copyImageMessage('unsupported', false)).toBeNull()
    expect(copyImageMessage('failed', false)).toBeNull()
    expect(copyImageMessage('not-here', false)).toMatchObject({ kind: 'info', text: expect.stringMatching(/^Copied the card/) })
  })
})

describe('copyImageCardToClipboard', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }))
  const imageCard = () => {
    const doc = new Y.Doc()
    const id = createCard(doc, 'image', { x: 0, y: 0, blob: 'a'.repeat(64), mime: 'image/png', name: 'Beach.png' }, 'u')
    return { doc, id }
  }

  it('fails quietly (no image clipboard here) when copying the card', async () => {
    const { doc, id } = imageCard()
    expect(await copyImageCardToClipboard(doc, id, 'board')).toBe(false)
    expect(useToasts.getState().toasts).toEqual([])
  })

  it('tells the person when they asked to copy the image', async () => {
    const { doc, id } = imageCard()
    expect(await copyImageCardToClipboard(doc, id, 'board', { explain: true })).toBe(false)
    expect(useToasts.getState().toasts.map((t) => t.kind)).toEqual(['error'])
  })
})

/** The pattern pasteCards (board/actions.ts) looks for before anything else. */
const PASTE_MARKER = /<meta name="noema-cards" content="([A-Za-z0-9_-]+)">/

describe('imageClipboardHtml', () => {
  it('starts with the card marker that pasting back into the board recognises', () => {
    const html = imageClipboardHtml('AbC-12_xyz', 'Beach')
    expect(html.match(PASTE_MARKER)?.[1]).toBe('AbC-12_xyz')
    expect(html.startsWith('<meta name="noema-cards"')).toBe(true)
    expect(html).toBe('<meta name="noema-cards" content="AbC-12_xyz"><img alt="Beach">')
  })

  it('escapes the label', () => {
    const html = imageClipboardHtml('x', `"><script>alert('1')</script>&`)
    expect(html).toContain('alt="&quot;&gt;&lt;script&gt;alert(&#39;1&#39;)&lt;/script&gt;&amp;"')
    expect(html).not.toContain('<script')
  })

  it('keeps only base64url characters in the marker', () => {
    const html = imageClipboardHtml('ab"><img src=x onerror=1>cd', 'Image')
    expect(html.match(PASTE_MARKER)?.[1]).toBe('abimgsrcxonerror1cd')
    expect(html.match(/<img/g)).toHaveLength(1)
  })
})
