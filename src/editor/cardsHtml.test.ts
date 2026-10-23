import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { createCard, getCardMap } from '../model/board'
import { getMembers } from '../model/members'
import { getStaticSchema } from './extensions'
import { cardsToHtml } from './cardsHtml'

function setText(doc: Y.Doc, id: string, field: string, content: unknown[]) {
  const frag = getCardMap(doc, id)!.get(field) as Y.XmlFragment
  prosemirrorJSONToYXmlFragment(getStaticSchema(), { type: 'doc', content }, frag)
}

const p = (text: string, marks?: unknown[]) => ({ type: 'paragraph', content: [marks ? { type: 'text', text, marks } : { type: 'text', text }] })

describe('cardsToHtml', () => {
  it('renders text cards with their formatting', () => {
    const doc = new Y.Doc()
    const note = createCard(doc, 'note', {}, 'u1')
    setText(doc, note, 'content', [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] }, p('bold', [{ type: 'bold' }])])
    const html = cardsToHtml(doc, [note])
    expect(html).toBe('<h2>Plan</h2><p><strong>bold</strong></p>')
  })

  it('escapes titles and plain fields and never adds the app marker', () => {
    const doc = new Y.Doc()
    const todo = createCard(doc, 'todo', { title: '<script>alert("t")</script>' }, 'u1')
    const board = createCard(doc, 'board', { title: '<img src=x onerror=alert(1)>' }, 'u1')
    const swatch = createCard(doc, 'swatch', { name: '<b>Coral</b>', hex: '#ff7f50' }, 'u1')
    const html = cardsToHtml(doc, [todo, board, swatch])
    expect(html).toContain('<h3>&lt;script&gt;alert(&quot;t&quot;)&lt;/script&gt;</h3>')
    expect(html).toContain('<h3>&lt;img src=x onerror=alert(1)&gt;</h3>')
    expect(html).toContain('<p>&lt;b&gt;Coral&lt;/b&gt; #ff7f50</p>')
    expect(html).not.toMatch(/<script|<img|<b>/)
    expect(html).not.toMatch(/noema-cards|<meta/i)
  })

  it('renders links with safe hrefs only', () => {
    const doc = new Y.Doc()
    const ok = createCard(doc, 'link', { url: 'https://example.com/?a=1&b=2', title: 'Example', description: 'A <site>' }, 'u1')
    const bad = createCard(doc, 'link', { url: 'javascript:alert(1)', title: 'Click me' }, 'u1')
    const html = cardsToHtml(doc, [ok, bad])
    expect(html).toContain('<p><a href="https://example.com/?a=1&amp;b=2">Example</a></p><p>A &lt;site&gt;</p>')
    expect(html).toContain('<p>Click me</p>')
    expect(html).not.toContain('javascript')
  })

  it('renders images as their label or caption', () => {
    const doc = new Y.Doc()
    const withAlt = createCard(doc, 'image', { alt: 'A red <bicycle>', name: 'IMG_0001.jpg' }, 'u1')
    const withCaption = createCard(doc, 'image', { name: 'Pasted image 2026-10-22 10.00.00.png' }, 'u1')
    setText(doc, withCaption, 'caption', [p('Team photo')])
    const html = cardsToHtml(doc, [withAlt, withCaption])
    expect(html).toContain('<p>A red &lt;bicycle&gt;</p>')
    expect(html).toContain('<p>Team photo</p>')
    expect(html).not.toContain('<img')
  })

  it('names assignees of tasks and drops hostile attribute values', () => {
    const doc = new Y.Doc()
    getMembers(doc).set('ada', { name: 'Ada <Lovelace>', color: '#30a46c', seenAt: 1 })
    const todo = createCard(doc, 'todo', { title: 'Launch' }, 'u1')
    setText(doc, todo, 'content', [
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false, due: '2026-10-22', assignee: 'ada' }, content: [p('Ship it')] }],
      },
    ])
    const html = cardsToHtml(doc, [todo])
    expect(html).toContain('data-assignee="ada"')
    expect(html).toContain('<span class="task-chip task-chip--assignee">@Ada &lt;Lovelace&gt;</span>')
    expect(html).toContain('class="task-chip task-chip--due"')
  })

  it('includes the cards inside a selected column', () => {
    const doc = new Y.Doc()
    const col = createCard(doc, 'column', { title: 'Ideas' }, 'u1')
    const inner = createCard(doc, 'note', { parent: col, order: 'a0' }, 'u1')
    setText(doc, inner, 'content', [p('inside')])
    const html = cardsToHtml(doc, [col])
    expect(html).toContain('<h3>Ideas</h3>')
    expect(html).toContain('<p>inside</p>')
  })
})
