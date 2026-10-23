import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { getStaticSchema } from './extensions'
import { fragmentToHtml, fragmentToText, isFragmentEmpty, isFragmentProjectable, textToHtml } from './staticHtml'

/** A fragment nested in a card map, like real cards. */
function cardFragment(): { doc: Y.Doc; frag: Y.XmlFragment } {
  const doc = new Y.Doc()
  const card = new Y.Map<unknown>()
  doc.getMap('cards').set('c1', card)
  const frag = new Y.XmlFragment()
  card.set('content', frag)
  return { doc, frag }
}

function fromJSON(content: unknown[]): Y.XmlFragment {
  const { frag } = cardFragment()
  prosemirrorJSONToYXmlFragment(getStaticSchema(), { type: 'doc', content }, frag)
  return frag
}

const p = (...content: unknown[]) => ({ type: 'paragraph', content })
const t = (text: string, marks?: unknown[]) => (marks ? { type: 'text', text, marks } : { type: 'text', text })

describe('fragmentToHtml', () => {
  it('renders paragraphs, empty lines and escapes text', () => {
    const frag = fromJSON([p(t('Hello')), { type: 'paragraph' }, p(t('<script>alert("x")</script> & co'))])
    expect(fragmentToHtml(frag)).toBe(
      '<p>Hello</p><p><br></p><p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co</p>',
    )
  })

  it('renders headings 1-3 and alignment', () => {
    const frag = fromJSON([
      { type: 'heading', attrs: { level: 1 }, content: [t('Big')] },
      { type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('Mid')] },
      { type: 'heading', attrs: { level: 3 }, content: [t('Small')] },
    ])
    expect(fragmentToHtml(frag)).toBe('<h1>Big</h1><h2 style="text-align: center">Mid</h2><h3>Small</h3>')
  })

  it('keeps shared marks open across neighbouring text like ProseMirror', () => {
    const frag = fromJSON([p(t('a', [{ type: 'bold' }]), t('b', [{ type: 'bold' }, { type: 'italic' }]), t('c'))])
    expect(fragmentToHtml(frag)).toBe('<p><strong>a<em>b</em></strong>c</p>')
  })

  it('renders bullet and ordered lists', () => {
    const li = (text: string) => ({ type: 'listItem', content: [p(t(text))] })
    const frag = fromJSON([
      { type: 'bulletList', content: [li('one'), li('two')] },
      { type: 'orderedList', attrs: { start: 3 }, content: [li('three')] },
    ])
    const html = fragmentToHtml(frag)
    expect(html).toContain('<ul><li><p>one</p></li><li><p>two</p></li></ul>')
    expect(html).toMatch(/<ol start="3"[^>]*><li><p>three<\/p><\/li><\/ol>/)
  })

  it('renders task lists with checkbox state', () => {
    const frag = fromJSON([
      {
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { checked: true }, content: [p(t('done'))] },
          { type: 'taskItem', attrs: { checked: false }, content: [p(t('todo'))] },
        ],
      },
    ])
    const html = fragmentToHtml(frag)
    expect(html).toContain('<ul data-type="taskList">')
    expect(html).toContain(
      '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked aria-label="Mark as not done"><span></span></label><div><p>done</p></div></li>',
    )
    expect(html).toContain('<li data-type="taskItem" data-checked="false"><label><input type="checkbox" aria-label="Mark as done">')
  })

  it('renders safe links with forced rel/target and normalises scheme-less hrefs', () => {
    const frag = fromJSON([
      p(t('site', [{ type: 'link', attrs: { href: 'https://example.com/a?b=1&c=2' } }])),
      p(t('bare', [{ type: 'link', attrs: { href: 'example.org' } }])),
    ])
    const html = fragmentToHtml(frag)
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site</a>')
    expect(html).toContain('<a href="https://example.org" target="_blank" rel="noopener noreferrer nofollow">bare</a>')
  })

  it('never emits javascript: or data: hrefs, even when written directly by a peer', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    para.insert(0, [text])
    frag.insert(0, [para])
    text.insert(0, 'click', { link: { href: 'javascript:alert(1)' } })
    text.insert(5, ' and ', {})
    text.insert(10, 'data', { link: { href: 'data:text/html,<script>alert(1)</script>' } })
    text.insert(14, ' and ', {})
    text.insert(19, 'tab', { link: { href: 'java\tscript:alert(1)' } })
    const html = fragmentToHtml(frag)
    expect(html).not.toMatch(/javascript|data:|href=/i)
    expect(html).toContain('>click</a>')
  })

  it('drops style injection in colors and keeps palette colors', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    para.insert(0, [text])
    frag.insert(0, [para])
    text.insert(0, 'bad', { textStyle: { color: 'red; background-image: url(https://evil.example/x)' } })
    text.insert(3, 'good', { textStyle: { color: 'var(--rt-tx-red)' } })
    text.insert(7, 'hl', { highlight: { color: 'var(--rt-hl-yellow)' } })
    const html = fragmentToHtml(frag)
    expect(html).not.toContain('url(')
    expect(html).not.toContain('evil')
    expect(html).toContain('<span style="color: var(--rt-tx-red)">good</span>')
    expect(html).toContain('<mark style="background-color: var(--rt-hl-yellow); color: inherit">hl</mark>')
  })

  it('renders code blocks, quotes and rules', () => {
    const frag = fromJSON([
      { type: 'codeBlock', content: [t('const a = 1 < 2')] },
      { type: 'blockquote', content: [p(t('quoted'))] },
      { type: 'horizontalRule' },
    ])
    const html = fragmentToHtml(frag)
    expect(html).toContain('<pre><code>const a = 1 &lt; 2</code></pre>')
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>')
    expect(html).toContain('<hr>')
  })

  it('falls back to plain text for unknown node types (newer app versions)', () => {
    const { frag } = cardFragment()
    const known = new Y.XmlElement('paragraph')
    known.insert(0, [new Y.XmlText('Intro')])
    const unknown = new Y.XmlElement('mysteryWidget')
    unknown.insert(0, [new Y.XmlText('Secret <b>')])
    frag.insert(0, [known, unknown])
    expect(fragmentToHtml(frag)).toBe('<p>Intro</p><p>Secret &lt;b&gt;</p>')
    expect(isFragmentProjectable(frag)).toBe(false)
  })

  it('falls back to plain text for unknown marks', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    para.insert(0, [text])
    frag.insert(0, [para])
    text.insert(0, 'glow', { sparkle: {} })
    expect(fragmentToHtml(frag)).toBe('<p>glow</p>')
  })

  it('invalidates the cache when the fragment changes', () => {
    const frag = fromJSON([p(t('one'))])
    expect(fragmentToHtml(frag)).toBe('<p>one</p>')
    expect(isFragmentProjectable(frag)).toBe(true)
    const para = new Y.XmlElement('paragraph')
    para.insert(0, [new Y.XmlText('two')])
    frag.insert(1, [para])
    expect(fragmentToHtml(frag)).toBe('<p>one</p><p>two</p>')
  })

  it('renders an empty fragment as an empty string', () => {
    expect(fragmentToHtml(cardFragment().frag)).toBe('')
  })
})

describe('isFragmentEmpty', () => {
  it('treats empty paragraphs and empty lists as empty', () => {
    expect(isFragmentEmpty(cardFragment().frag)).toBe(true)
    expect(isFragmentEmpty(fromJSON([{ type: 'paragraph' }, { type: 'paragraph' }]))).toBe(true)
    expect(
      isFragmentEmpty(fromJSON([{ type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'paragraph' }] }] }])),
    ).toBe(true)
  })

  it('detects text and visible leaf blocks', () => {
    expect(isFragmentEmpty(fromJSON([p(t('x'))]))).toBe(false)
    expect(isFragmentEmpty(fromJSON([{ type: 'horizontalRule' }]))).toBe(false)
  })
})

describe('fragmentToText', () => {
  it('gives one line per block and keeps literal angle brackets', () => {
    const li = (text: string) => ({ type: 'listItem', content: [p(t(text))] })
    const frag = fromJSON([
      { type: 'heading', attrs: { level: 1 }, content: [t('Title')] },
      p(t('a < b', [{ type: 'bold' }]), t(' and <c>')),
      { type: 'bulletList', content: [li('one'), li('two')] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('task'))] }] },
    ])
    expect(fragmentToText(frag)).toBe('Title\na < b and <c>\none\ntwo\ntask')
  })
})

describe('textToHtml', () => {
  it('escapes and keeps blank lines', () => {
    expect(textToHtml('a<b\n\nc')).toBe('<p>a&lt;b</p><p><br></p><p>c</p>')
    expect(textToHtml('')).toBe('')
  })
})

describe('projectability of incomplete content', () => {
  it('treats an empty fragment as editable', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('f')
    expect(isFragmentProjectable(frag)).toBe(true)
    expect(fragmentToHtml(frag)).toBe('')
  })

  it('treats an emptied list as editable (known types only)', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('f')
    frag.insert(0, [new Y.XmlElement('taskList')])
    expect(isFragmentProjectable(frag)).toBe(true)
  })
})

describe('projectability of attributes from newer versions', () => {
  it('keeps content with an unknown node attribute read-only (the editor would erase it)', () => {
    const frag = fromJSON([p(t('indented'))])
    expect(isFragmentProjectable(frag)).toBe(true)
    ;(frag.get(0) as Y.XmlElement).setAttribute('indent', '2')
    expect(isFragmentProjectable(frag)).toBe(false)
    // Still shown.
    expect(fragmentToHtml(frag)).toBe('<p>indented</p>')
  })

  it('keeps content with an unknown mark attribute read-only', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    const text = new Y.XmlText()
    para.insert(0, [text])
    frag.insert(0, [para])
    text.insert(0, 'site', { link: { href: 'https://example.com', title: null, preview: 'card' } })
    expect(fragmentToHtml(frag)).toContain('>site</a>')
    expect(isFragmentProjectable(frag)).toBe(false)
  })

  it('stays editable for known attributes and link attributes the schema drops on purpose', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    para.setAttribute('textAlign', 'center')
    const text = new Y.XmlText()
    para.insert(0, [text])
    frag.insert(0, [para])
    text.insert(0, 'a', { link: { href: 'https://example.com', target: '_blank', rel: 'noopener', class: 'x' } })
    text.insert(1, 'b', { bold: {} })
    text.insert(2, 'c', { 'textStyle--abc123': { color: 'var(--rt-tx-red)' } })
    expect(isFragmentProjectable(frag)).toBe(true)
  })
})

describe('code block language', () => {
  it('only ever renders a single language-* class', () => {
    const frag = fromJSON([
      { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('let a')] },
      { type: 'codeBlock', attrs: { language: 'x world no-drag' }, content: [t('let b')] },
    ])
    const html = fragmentToHtml(frag)
    expect(html).toContain('<pre><code class="language-ts">let a</code></pre>')
    expect(html).toContain('<pre><code>let b</code></pre>')
    expect(html).not.toMatch(/world|no-drag/)
  })

  it('drops classes on other elements even if a renderer produced them', () => {
    const { frag } = cardFragment()
    const code = new Y.XmlElement('codeBlock')
    code.setAttribute('language', 'c++ lightbox')
    code.insert(0, [new Y.XmlText('x')])
    frag.insert(0, [code])
    expect(fragmentToHtml(frag)).toBe('<pre><code>x</code></pre>')
  })
})

describe('task due dates and assignees', () => {
  /** A task list written directly as Yjs, the way a (possibly hostile) peer could. */
  function rawTask(attrs: Record<string, unknown>, text = 'Ship it'): Y.XmlFragment {
    const { frag } = cardFragment()
    const list = new Y.XmlElement('taskList')
    const item = new Y.XmlElement('taskItem')
    for (const [k, v] of Object.entries(attrs)) item.setAttribute(k, v as string)
    const para = new Y.XmlElement('paragraph')
    para.insert(0, [new Y.XmlText(text)])
    item.insert(0, [para])
    list.insert(0, [item])
    frag.insert(0, [list])
    return frag
  }

  it('renders valid metadata as data attributes and chips after the text', () => {
    const frag = rawTask({ checked: false, due: '2026-10-22T09:30', assignee: 'ada_1' })
    const html = fragmentToHtml(frag)
    expect(html).toMatch(/^<ul data-type="taskList"><li data-type="taskItem" data-checked="false" data-due="2026-10-22T09:30" data-assignee="ada_1">/)
    expect(html).toContain('<div><p>Ship it</p></div><span class="task-meta" contenteditable="false"><span class="task-chip task-chip--due" title="')
    expect(html).toContain('<span class="task-chip task-chip--assignee"></span></span></li>')
    expect(isFragmentProjectable(frag)).toBe(true)
  })

  it('renders no chips without metadata (unchanged markup)', () => {
    const html = fragmentToHtml(rawTask({ checked: true }))
    expect(html).not.toContain('task-meta')
    expect(html).not.toContain('data-due')
  })

  it('drops hostile or impossible values instead of rendering them', () => {
    const frag = rawTask({
      checked: false,
      due: '2026-02-30"><img src=x onerror=alert(1)>',
      assignee: 'x" onmouseover="alert(1)',
    })
    const html = fragmentToHtml(frag)
    expect(html).not.toMatch(/data-due|data-assignee|task-meta|onerror|onmouseover|<img/)
    expect(fragmentToHtml(rawTask({ checked: false, due: '2026-02-30' }))).not.toContain('data-due')
    expect(fragmentToHtml(rawTask({ checked: false, due: 20261022 }))).not.toContain('data-due')
  })

  it('escapes task text next to the chips', () => {
    const html = fragmentToHtml(rawTask({ checked: false, due: '2026-10-22' }, '<b>"bold"</b> & <script>'))
    expect(html).toContain('<p>&lt;b&gt;&quot;bold&quot;&lt;/b&gt; &amp; &lt;script&gt;</p>')
    expect(html).not.toContain('<script')
  })

  it('only allows data attributes where the app renders them', () => {
    const { frag } = cardFragment()
    const para = new Y.XmlElement('paragraph')
    // Unknown attributes are dropped by the schema; nothing reaches the HTML.
    para.setAttribute('data-evil', 'x')
    para.insert(0, [new Y.XmlText('hi')])
    frag.insert(0, [para])
    expect(fragmentToHtml(frag)).toBe('<p>hi</p>')
  })

  it('keeps metadata from versions that do not know it read-only', () => {
    const frag = rawTask({ checked: false, due: '2026-10-22', priority: 'high' })
    expect(isFragmentProjectable(frag)).toBe(false)
  })
})
