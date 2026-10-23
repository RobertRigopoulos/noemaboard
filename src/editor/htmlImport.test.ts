import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Node as PMNode } from '@tiptap/pm/model'
import { getStaticSchema } from './extensions'
import { capDoc, docText, hasFormatting, htmlToPmDoc } from './htmlImport'
import { createRichNote, isCodeEditorHtml, markdownPaste, richContent } from './richNote'
import { endPlainPaste, notePasteKey } from './plainPaste'
import { fakeHtmlBody } from './testDom'
import { fragmentToHtml } from './staticHtml'
import { getCardMap, LOCAL_ORIGIN } from '../model/board'

const parse = (html: string) => htmlToPmDoc(html, fakeHtmlBody)

function types(doc: PMNode): string[] {
  const out: string[] = []
  doc.descendants((n) => {
    out.push(n.type.name)
  })
  return out
}

function marksOf(doc: PMNode, text: string): string[] {
  let marks: string[] = []
  doc.descendants((n) => {
    if (n.isText && n.text === text) marks = n.marks.map((m) => m.type.name)
  })
  return marks
}

function hrefOf(doc: PMNode, text: string): string | null {
  let href: string | null = null
  doc.descendants((n) => {
    if (n.isText && n.text === text) href = (n.marks.find((m) => m.type.name === 'link')?.attrs.href as string) ?? null
  })
  return href
}

describe('htmlToPmDoc', () => {
  it('keeps headings, lists, quotes and code', () => {
    const doc = parse(
      '<h1>Plan</h1><h2>Week</h2><h4>Deep</h4><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>' +
        '<ol start="3"><li>three</li></ol><blockquote><p>quoted</p></blockquote><pre><code>let a = 1\nlet b = 2</code></pre><hr>',
    )!
    expect(doc).not.toBeNull()
    const t = types(doc)
    expect(t.filter((n) => n === 'heading')).toHaveLength(3)
    expect(doc.child(0).attrs.level).toBe(1)
    expect(doc.child(1).attrs.level).toBe(2)
    expect(t).toContain('bulletList')
    expect(t).toContain('orderedList')
    expect(t).toContain('blockquote')
    expect(t).toContain('codeBlock')
    expect(t).toContain('horizontalRule')
    expect(docText(doc)).toContain('nested')
    let code = ''
    doc.descendants((n) => {
      if (n.type.name === 'codeBlock') code = n.textContent
    })
    expect(code).toBe('let a = 1\nlet b = 2')
  })

  it('keeps bold, italic, underline, strike, inline code and safe links', () => {
    const doc = parse(
      '<p><strong>bold</strong> <em>italic</em> <u>under</u> <s>gone</s> <code>x()</code> ' +
        '<a href="https://example.com/a?b=1">site</a> <a href="mailto:ada@example.com">mail</a></p>' +
        '<p><span style="font-weight: 700">heavy</span></p>',
    )!
    expect(marksOf(doc, 'bold')).toEqual(['bold'])
    expect(marksOf(doc, 'italic')).toEqual(['italic'])
    expect(marksOf(doc, 'under')).toEqual(['underline'])
    expect(marksOf(doc, 'gone')).toEqual(['strike'])
    expect(marksOf(doc, 'x()')).toEqual(['code'])
    expect(hrefOf(doc, 'site')).toBe('https://example.com/a?b=1')
    expect(hrefOf(doc, 'mail')).toBe('mailto:ada@example.com')
    expect(marksOf(doc, 'heavy')).toContain('bold')
  })

  it('keeps task lists written by this app', () => {
    const doc = parse(
      '<ul data-type="taskList"><li data-type="taskItem" data-checked="true" data-due="2026-10-22"><label><input type="checkbox" checked><span></span></label><div><p>done</p></div>' +
        '<span class="task-meta" contenteditable="false"><span class="task-chip task-chip--due">Oct 22</span></span></li>' +
        '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label><div><p>todo</p></div></li></ul>',
    )!
    const items: PMNode[] = []
    doc.descendants((n) => {
      if (n.type.name === 'taskItem') items.push(n)
    })
    expect(items.map((i) => [i.textContent, i.attrs.checked, i.attrs.due])).toEqual([
      ['done', true, '2026-10-22'],
      ['todo', false, null],
    ])
    // The chip text is not content.
    expect(docText(doc)).not.toContain('Oct 22')
  })

  it('drops javascript: and other unsafe links but keeps their text', () => {
    const doc = parse(
      '<p><a href="javascript:alert(1)">evil</a> <a href="data:text/html,<b>x</b>">data</a> <a href="vbscript:x">vb</a> <a href=" java&#9;script:alert(1)">tab</a></p>',
    )!
    expect(docText(doc)).toContain('evil')
    for (const t of ['evil', 'data', 'vb', 'tab']) expect(hrefOf(doc, t)).toBeNull()
  })

  it('drops foreign colours and keeps palette colours', () => {
    const doc = parse(
      '<p><span style="color: rgb(255, 0, 0)">red</span> <span style="color: var(--rt-tx-blue)">blue</span> ' +
        '<mark style="background-color: #ff0">hl</mark> <span style="color: red; background-image: url(https://evil.example/x)">bad</span></p>',
    )!
    let blue: unknown = null
    let redMarks: string[] | null = null
    doc.descendants((n) => {
      if (!n.isText) return
      const style = n.marks.find((m) => m.type.name === 'textStyle')
      if (n.text === 'blue') blue = style?.attrs.color
      // The colour is gone, so "red" merges with the plain text around it.
      if (n.text!.includes('red')) redMarks = n.marks.map((m) => m.type.name)
    })
    expect(blue).toBe('var(--rt-tx-blue)')
    expect(redMarks).toEqual([])
    expect(JSON.stringify(doc.toJSON())).not.toMatch(/rgb\(|evil|url\(/)
  })

  it('removes images, scripts, styles and comments', () => {
    const doc = parse(
      '<p>before<img src="https://tracker.example/p.gif" alt="pixel"></p><script>alert(1)</script><style>p{color:red}</style>' +
        '<!-- secret comment --><p>after</p><svg><text>vector</text></svg>',
    )!
    const text = docText(doc)
    expect(text).toContain('before')
    expect(text).toContain('after')
    expect(text).not.toMatch(/alert|color:red|secret|vector|pixel/)
    expect(types(doc)).not.toContain('image')
  })

  it('returns null for empty, text-less or unparsable input', () => {
    expect(parse('')).toBeNull()
    expect(parse('<p>   </p><img src="x.png">')).toBeNull()
    expect(htmlToPmDoc('<p>x</p>', () => null)).toBeNull()
    // Without a DOM (Node tests), the default parser is unavailable.
    expect(htmlToPmDoc('<p>x</p>')).toBeNull()
  })

  it('reads word-processor markup: styled spans, a non-bold <b> wrapper, unknown tags', () => {
    const doc = parse(
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-size:11pt;color:#000000;font-weight:400">Plain</span>' +
        '<span style="font-weight:700">Strong</span></p><o:p></o:p></b>',
    )!
    expect(docText(doc)).toBe('PlainStrong')
    expect(marksOf(doc, 'Plain')).toEqual([])
    expect(marksOf(doc, 'Strong')).toEqual(['bold'])
    expect(hasFormatting(parse('<p><span style="color:#123456">plain</span></p>')!)).toBe(false)
  })

  it('tells formatted content from plain paragraphs', () => {
    expect(hasFormatting(parse('<p>one</p><p>two</p>')!)).toBe(false)
    expect(hasFormatting(parse('<div>line<br>line</div>')!)).toBe(false)
    expect(hasFormatting(parse('<p>one <b>two</b></p>')!)).toBe(true)
    expect(hasFormatting(parse('<ul><li>x</li></ul>')!)).toBe(true)
    expect(hasFormatting(parse('<h2>x</h2>')!)).toBe(true)
  })
})

describe('capDoc', () => {
  it('cuts long documents at the character limit', () => {
    const schema = getStaticSchema()
    const doc = schema.nodeFromJSON({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'abcde' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'fghij' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'klm' }] }] }] },
      ],
    })
    expect(capDoc(doc, 100).truncated).toBe(false)
    const cut = capDoc(doc, 7)
    expect(cut.truncated).toBe(true)
    expect(cut.doc.textContent).toBe('abcdefg')
    const atList = capDoc(doc, 11)
    expect(atList.doc.textContent).toBe('abcdefghij')
    expect(atList.doc.childCount).toBe(2)
  })
})

describe('richContent and createRichNote', () => {
  it('prefers formatted HTML, then Markdown, else nothing', () => {
    expect(richContent({ html: '<h2>Title</h2><p>x</p>', text: 'Title\nx' }, fakeHtmlBody)?.firstChild?.type.name).toBe('heading')
    // HTML without formatting does not win over Markdown in the plain text.
    const md = richContent({ html: '<div># Title</div><div>- one</div>', text: '# Title\n- one' }, fakeHtmlBody)
    expect(md?.firstChild?.type.name).toBe('heading')
    expect(richContent({ html: '<p>just text</p>', text: 'just text' }, fakeHtmlBody)).toBeNull()
    expect(richContent({ text: 'one line' })).toBeNull()
  })

  it('creates the note and its text in one undoable transaction', () => {
    const doc = new Y.Doc()
    const undo = new Y.UndoManager(doc.getMap('cards'), { trackedOrigins: new Set([LOCAL_ORIGIN]) })
    const origins: unknown[] = []
    doc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const id = createRichNote(doc, { html: '<h1>Hello</h1><ul><li><b>bold</b> item</li></ul>', text: 'Hello\nbold item' }, { x: 10, y: 20 }, 'u1', fakeHtmlBody)
    expect(id).toBeTruthy()
    expect(origins).toEqual([LOCAL_ORIGIN])
    const frag = getCardMap(doc, id!)!.get('content') as Y.XmlFragment
    const html = fragmentToHtml(frag)
    expect(html).toContain('<h1>Hello</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(getCardMap(doc, id!)!.get('x')).toBe(10)
    undo.undo()
    expect(getCardMap(doc, id!)).toBeUndefined()
  })

  it('returns null for plain text so the caller takes its plain path', () => {
    const doc = new Y.Doc()
    expect(createRichNote(doc, { html: null, text: 'Buy milk' }, {}, 'u1')).toBeNull()
    expect(doc.getMap('cards').size).toBe(0)
  })

  it('keeps a code editor’s copy as plain text, Markdown or not', () => {
    const text = '# Title\n- one\n- two'
    const vscode =
      '<meta charset="utf-8"><div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, \'Courier New\', monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #6a9955;"># Title</span></div><div><span>- one</span></div><div><span>- two</span></div></div>'
    expect(isCodeEditorHtml(vscode)).toBe(true)
    expect(isCodeEditorHtml('<div style="font-family: Menlo, &quot;Courier New&quot;, monospace">x</div>')).toBe(true)
    expect(isCodeEditorHtml('<span style="white-space: pre-wrap; font-family: Arial">x</span>')).toBe(false)
    expect(isCodeEditorHtml('<p>plain</p>')).toBe(false)
    expect(richContent({ html: vscode, text }, fakeHtmlBody)).toBeNull()
    expect(markdownPaste({ html: vscode, text }, fakeHtmlBody)).toBeNull()
    // The same text from a chat or a plain text editor converts.
    expect(richContent({ html: null, text })?.firstChild?.type.name).toBe('heading')
  })

  it('gives open text the Markdown only when the editor’s own paste would not format it', () => {
    const text = '## Plan\n- [ ] book a room\n- [x] send invites'
    expect(markdownPaste({ text })?.child(1).type.name).toBe('taskList')
    expect(markdownPaste({ html: '<p>## Plan</p><p>- [ ] book a room</p>', text }, fakeHtmlBody)?.firstChild?.type.name).toBe('heading')
    // Formatted HTML: the editor reads that itself.
    expect(markdownPaste({ html: '<h2>Plan</h2><ul><li>book a room</li></ul>', text }, fakeHtmlBody)).toBeNull()
    expect(markdownPaste({ text: 'just a line\nand another' })).toBeNull()
    expect(markdownPaste({ text: '# install\nnpm install\n# start\nnpm start' })).toBeNull()
  })

  it('makes no formatted note while a Ctrl+Shift+V paste is handled', () => {
    const doc = new Y.Doc()
    const source = { html: '<h1>Hello</h1>', text: '# Hello\n- one\n- two' }
    notePasteKey({ key: 'V', code: 'KeyV', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })
    expect(createRichNote(doc, source, {}, 'u1', fakeHtmlBody)).toBeNull()
    endPlainPaste()
    expect(createRichNote(doc, source, {}, 'u1', fakeHtmlBody)).toBeTruthy()
  })
})
