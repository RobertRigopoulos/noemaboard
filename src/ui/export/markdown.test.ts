import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { createCard, deleteCards, getCards, initBoardDoc, insertIntoColumn } from '../../model/board'
import { getMembers } from '../../model/members'
import {
  escapeLineStart,
  escapeMarkdown,
  exportMarkdown,
  exportPlainText,
  fragmentToMarkdown,
  fragmentToText,
  readingOrder,
  referencedAssets,
  safeUrl,
  taskMetaSuffix,
} from './markdown'

const U = 'user1'
const HASH = 'a'.repeat(64)

type Child = Y.XmlElement | Y.XmlText

function el(name: string, attrs: Record<string, unknown>, children: Child[] = []): Y.XmlElement {
  const e = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) (e as Y.XmlElement<Record<string, any>>).setAttribute(k, v)
  if (children.length) e.insert(0, children)
  return e
}

function text(...runs: [string, Record<string, unknown>?][]): Y.XmlText {
  const t = new Y.XmlText()
  // Formatting can only be applied once integrated, so runs are recorded and applied later.
  ;(t as unknown as { _runs: typeof runs })._runs = runs
  return t
}

/** Integrates the blocks into a fragment of a doc, then applies the recorded text runs. */
function fragment(blocks: Y.XmlElement[]): Y.XmlFragment {
  const doc = new Y.Doc()
  const frag = doc.getXmlFragment('f')
  frag.insert(0, blocks)
  const visit = (n: Y.XmlFragment | Y.XmlElement) => {
    for (const c of n.toArray() as Child[]) {
      if (c instanceof Y.XmlText) {
        const runs = (c as unknown as { _runs?: [string, Record<string, unknown>?][] })._runs ?? []
        let at = 0
        for (const [s, attrs] of runs) {
          c.insert(at, s, attrs ?? {})
          at += s.length
        }
      } else visit(c)
    }
  }
  visit(frag)
  return frag
}

const p = (...runs: [string, Record<string, unknown>?][]) => el('paragraph', {}, [text(...runs)])

describe('fragmentToMarkdown', () => {
  it('converts headings, marks and links', () => {
    const frag = fragment([
      el('heading', { level: 2 }, [text(['Plan'])]),
      p(['Ship '], ['fast', { bold: {} }], [' and '], ['well', { italic: {} }], ['.']),
      p(['see '], ['docs', { link: { href: 'https://example.com/a_b' } }], [' and '], ['bad', { link: { href: 'javascript:alert(1)' } }]),
      p(['run '], ['npm i', { code: {} }], [' '], ['old', { strike: {} }]),
    ])
    expect(fragmentToMarkdown(frag)).toBe(
      ['## Plan', 'Ship **fast** and *well*.', 'see [docs](https://example.com/a_b) and bad', 'run `npm i` ~~old~~'].join('\n\n'),
    )
    // Heading offset nests card headings under board/column headings, capped at h6.
    expect(fragmentToMarkdown(frag, 2).startsWith('#### Plan')).toBe(true)
    expect(fragmentToMarkdown(fragment([el('heading', { level: 5 }, [text(['Deep'])])]), 3)).toBe('###### Deep')
  })

  it('keeps whitespace outside emphasis markers and merges links across marks', () => {
    const frag = fragment([p(['a'], [' bold ', { bold: {} }], ['b'], ['x', { link: { href: 'https://e.com' } }], ['y', { link: { href: 'https://e.com' }, bold: {} }])])
    expect(fragmentToMarkdown(frag)).toBe('a **bold** b[x**y**](https://e.com)')
  })

  it('handles overlapping mark keys stored with a hash suffix', () => {
    const frag = fragment([p(['x', { 'link--abc123': { href: 'https://e.com' } }])])
    expect(fragmentToMarkdown(frag)).toBe('[x](https://e.com)')
  })

  it('converts bullet, ordered, nested and task lists', () => {
    const frag = fragment([
      el('bulletList', {}, [
        el('listItem', {}, [p(['one'])]),
        el('listItem', {}, [p(['two']), el('bulletList', {}, [el('listItem', {}, [p(['two.a'])])])]),
      ]),
      el('orderedList', { start: 3 }, [el('listItem', {}, [p(['three'])]), el('listItem', {}, [p(['four'])])]),
      el('taskList', {}, [el('taskItem', { checked: true }, [p(['done'])]), el('taskItem', { checked: false }, [p(['todo'])])]),
    ])
    expect(fragmentToMarkdown(frag)).toBe(
      ['- one\n- two\n  - two.a', '3. three\n4. four', '- [x] done\n- [ ] todo'].join('\n\n'),
    )
    expect(fragmentToText(frag)).toBe(['• one\n• two\n  • two.a', '3. three\n4. four', '[x] done\n[ ] todo'].join('\n\n'))
  })

  it('converts quotes, code blocks, rules and hard breaks', () => {
    const quote = el('blockquote', {}, [p(['wise']), p(['words'])])
    const code = el('codeBlock', { language: 'ts' }, [text(['const a = `x`\nconst b = 1'])])
    const br = el('paragraph', {}, [text(['line one']), el('hardBreak', {}), text(['line two'])])
    const frag = fragment([quote, code, el('horizontalRule', {}), br])
    expect(fragmentToMarkdown(frag)).toBe(['> wise\n>\n> words', '```ts\nconst a = `x`\nconst b = 1\n```', '---', 'line one\\\nline two'].join('\n\n'))
  })

  it('escapes Markdown syntax in plain text', () => {
    const frag = fragment([p(['# not a heading']), p(['- not a list']), p(['1. not ordered']), p(['a*b_c [d]'])])
    expect(fragmentToMarkdown(frag)).toBe(['\\# not a heading', '\\- not a list', '1\\. not ordered', 'a\\*b\\_c \\[d\\]'].join('\n\n'))
  })

  it('drops empty paragraphs', () => {
    expect(fragmentToMarkdown(fragment([p(['a']), el('paragraph', {}), p(['b'])]))).toBe('a\n\nb')
  })
})

describe('helpers', () => {
  it('orders cards top-to-bottom then left-to-right within a row', () => {
    const items = [
      { id: 'c', x: 0, y: 300 },
      { id: 'b', x: 400, y: 10 },
      { id: 'a', x: 0, y: 30 },
      { id: 'd', x: 400, y: 290 },
      { id: 'e', x: 0, y: 900 },
    ]
    // d is slightly higher than c but in the same row, so c (further left) is read first.
    expect(readingOrder(items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  it('only accepts http(s) and mailto URLs', () => {
    expect(safeUrl('https://x.y/z')).toBe('https://x.y/z')
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeUrl('javascript:alert(1)')).toBeNull()
    expect(safeUrl('data:text/html,hi')).toBeNull()
    expect(safeUrl(42)).toBeNull()
  })

  it('escapes', () => {
    expect(escapeMarkdown('a_b*c`d')).toBe('a\\_b\\*c\\`d')
    expect(escapeLineStart('## x')).toBe('\\## x')
    expect(escapeLineStart('+ x')).toBe('\\+ x')
    expect(escapeLineStart('---')).toBe('\\---')
    expect(escapeLineStart('plain - text')).toBe('plain - text')
  })
})

function boardDoc() {
  const doc = new Y.Doc({ guid: 'board1' })
  initBoardDoc(doc, { id: 'board1', title: 'Launch_plan' }, U)
  return doc
}

function setContent(doc: Y.Doc, id: string, blocks: Y.XmlElement[]) {
  const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
  frag.insert(0, blocks)
  const visit = (n: Y.XmlFragment | Y.XmlElement) => {
    for (const c of n.toArray() as Child[]) {
      if (c instanceof Y.XmlText) {
        let at = 0
        for (const [s, attrs] of (c as unknown as { _runs?: [string, Record<string, unknown>?][] })._runs ?? []) {
          c.insert(at, s, attrs ?? {})
          at += s.length
        }
      } else visit(c)
    }
  }
  visit(frag)
}

describe('exportMarkdown', () => {
  it('renders a board with columns, cards in reading order, comments and connections', () => {
    const doc = boardDoc()
    const note = createCard(doc, 'note', { x: 0, y: 0 }, U)
    setContent(doc, note, [el('heading', { level: 1 }, [text(['Intro'])]), p(['Hello'])])
    const link = createCard(doc, 'link', { x: 400, y: 10, url: 'https://example.com', title: 'Example', description: 'A site' }, U)
    const col = createCard(doc, 'column', { x: 0, y: 400, title: 'Tasks' }, U)
    const todo = createCard(doc, 'todo', { title: 'This week' }, U)
    setContent(doc, todo, [el('taskList', {}, [el('taskItem', { checked: true }, [p(['Write'])])])])
    insertIntoColumn(doc, [todo], col, 0, U)
    createCard(doc, 'image', { x: 800, y: 400, blob: HASH, name: 'photo.png', mime: 'image/png' }, U)
    const comment = createCard(doc, 'comment', { x: 0, y: 900 }, U)
    const thread = getCards(doc).get(comment)!.get('thread') as Y.Array<Y.Map<unknown>>
    const msg = new Y.Map<unknown>()
    msg.set('authorName', 'Ana')
    msg.set('text', 'Looks *good*')
    thread.push([msg])
    createCard(doc, 'line', { from: { card: note, x: 0, y: 0 }, to: { card: link, x: 0, y: 0 }, label: 'see' }, U)
    const trashed = createCard(doc, 'note', { x: 0, y: 1200 }, U)
    setContent(doc, trashed, [p(['secret trashed text'])])
    deleteCards(doc, [trashed], U)

    const md = exportMarkdown(doc)
    expect(md).toBe(
      [
        '# Launch\\_plan',
        '### Intro\n\nHello',
        '[Example](https://example.com)\n\nA site',
        '## Tasks\n\n#### This week\n\n- [x] Write',
        `![photo.png](images/${HASH}.png)`,
        '> *Comment*\n>\n> **Ana:** Looks \\*good\\*',
        '## Connections',
        '- Intro → Example: see',
      ].join('\n\n') + '\n',
    )
    expect(md).not.toContain('secret')
    expect(referencedAssets(doc)).toEqual([{ kind: 'image', hash: HASH, name: 'photo.png', mime: 'image/png' }])
  })

  it('renders plain text', () => {
    const doc = boardDoc()
    const note = createCard(doc, 'note', { x: 0, y: 0 }, U)
    setContent(doc, note, [p(['Hello ', { bold: {} }], ['world'])])
    createCard(doc, 'board', { x: 400, y: 0, title: 'Sub', boardId: 'child12345', secret: 's' }, U)
    expect(exportPlainText(doc)).toBe('Launch_plan\n===========\n\nHello world\n\n[Board: Sub]\n')
  })

  it('says when a board is empty', () => {
    expect(exportMarkdown(boardDoc())).toBe('# Launch\\_plan\n\n*This board is empty.*\n')
  })

  it('writes mentions as @label, in Markdown and in plain text', () => {
    const doc = boardDoc()
    const note = createCard(doc, 'note', { x: 0, y: 0 }, U)
    setContent(doc, note, [el('paragraph', {}, [text(['Ask ']), el('mention', { id: 'ada_1', label: 'Ada‮ L.' }), text([' today'])])])
    expect(exportMarkdown(doc)).toContain('Ask @Ada L. today')
    expect(exportPlainText(doc)).toContain('Ask @Ada L. today')
    // A mention without a usable label still reads as a mention.
    const other = createCard(doc, 'note', { x: 0, y: 300 }, U)
    setContent(doc, other, [el('paragraph', {}, [el('mention', { id: 'x' })])])
    expect(exportMarkdown(doc)).toContain('@someone')
  })

  it('adds due dates and assignees (by roster name) to tasks', () => {
    const doc = boardDoc()
    getMembers(doc).set('ada_1', { name: 'Ada_L', color: '#336699', seenAt: 1 })
    const todo = createCard(doc, 'todo', { x: 0, y: 0, title: 'Launch' }, U)
    setContent(doc, todo, [
      el('taskList', {}, [
        el('taskItem', { checked: false, due: '2026-10-24', assignee: 'ada_1' }, [p(['Book venue'])]),
        el('taskItem', { checked: true, due: '2026-10-25T09:30' }, [p(['Print flyers'])]),
        el('taskItem', { checked: false, assignee: 'stranger' }, [p(['Call press'])]),
        el('taskItem', { checked: false, due: '2026-02-30', assignee: 'bad id!' }, [p(['Ignore junk'])]),
      ]),
    ])
    const md = exportMarkdown(doc)
    expect(md).toContain(
      [
        '- [ ] Book venue (due 2026-10-24, @Ada\\_L)',
        '- [x] Print flyers (due 2026-10-25 09:30)',
        '- [ ] Call press (@someone)',
        '- [ ] Ignore junk',
      ].join('\n'),
    )
    expect(exportPlainText(doc)).toContain('[ ] Book venue (due 2026-10-24, @Ada_L)')
  })

  it('cleans the alt text of images inside rich text', () => {
    const frag = fragment([
      el('paragraph', {}, [text(['see ']), el('image', { src: 'https://e.com/a.png', alt: 'two\nlines ]' })]),
      el('image', { src: 'https://e.com/b.png', alt: { evil: true } }),
      el('image', { src: 'https://e.com/c.png', alt: 'x'.repeat(5000) }),
    ])
    const md = fragmentToMarkdown(frag)
    expect(md).toContain('see ![two lines \\]](https://e.com/a.png)')
    expect(md).toContain('![](https://e.com/b.png)')
    expect(md).not.toContain('[object Object]')
    const long = /!\[(x+)\]\(https:\/\/e\.com\/c\.png\)/.exec(md)
    expect(long?.[1].length).toBeLessThanOrEqual(1000)
  })

  it('uses alt text for images, falling back to the file name', () => {
    const doc = boardDoc()
    createCard(doc, 'image', { x: 0, y: 0, blob: HASH, name: 'IMG_1.png', mime: 'image/png', alt: 'A red [bike]\nby the sea' }, U)
    createCard(doc, 'image', { x: 400, y: 0, blob: HASH, name: 'plan.png', mime: 'image/png', alt: 42 }, U)
    const md = exportMarkdown(doc)
    expect(md).toContain(`![A red \\[bike\\] by the sea](images/${HASH}.png)`)
    expect(md).toContain(`![plan.png](images/${HASH}.png)`)
    expect(exportPlainText(doc)).toContain('[Image: A red [bike] by the sea]')
  })

  it('lists Unsorted drawer cards last, in drawer order, under their own heading', () => {
    const doc = boardDoc()
    const placed = createCard(doc, 'note', { x: 0, y: 0 }, U)
    setContent(doc, placed, [p(['On the canvas'])])
    const second = createCard(doc, 'note', { x: -500, y: -500, unsorted: true, order: 'a2' }, U)
    setContent(doc, second, [p(['Second waiting'])])
    const first = createCard(doc, 'link', { x: -900, y: -900, unsorted: true, order: 'a1', url: 'https://e.com', title: 'First waiting' }, U)
    const col = createCard(doc, 'column', { x: 0, y: 600, unsorted: true, order: 'a3', title: 'Ideas' }, U)
    const inCol = createCard(doc, 'note', {}, U)
    setContent(doc, inCol, [p(['Inside'])])
    insertIntoColumn(doc, [inCol], col, 0, U)
    // A truthy but non-boolean flag from a peer does not count.
    const fake = createCard(doc, 'note', { x: 0, y: 300, unsorted: 'yes' as unknown as boolean }, U)
    setContent(doc, fake, [p(['Not unsorted'])])
    void first

    expect(exportMarkdown(doc)).toBe(
      [
        '# Launch\\_plan',
        'On the canvas',
        'Not unsorted',
        '## Unsorted',
        '[First waiting](https://e.com)',
        'Second waiting',
        '### Ideas\n\nInside',
      ].join('\n\n') + '\n',
    )
    expect(exportPlainText(doc).endsWith('Unsorted\n--------\n\nFirst waiting\nhttps://e.com\n\nSecond waiting\n\nIdeas\n-----\n\nInside\n')).toBe(true)
  })

  it('does not call a board with only unsorted cards empty', () => {
    const doc = boardDoc()
    const n = createCard(doc, 'note', { unsorted: true, order: 'a0' }, U)
    setContent(doc, n, [p(['Later'])])
    expect(exportMarkdown(doc)).toBe('# Launch\\_plan\n\n## Unsorted\n\nLater\n')
  })
})

describe('taskMetaSuffix', () => {
  it('is empty without valid metadata', () => {
    const frag = fragment([el('taskList', {}, [el('taskItem', { due: 'soon', assignee: '' }, [p(['x'])])])])
    const item = (frag.get(0) as Y.XmlElement).get(0) as Y.XmlElement
    expect(taskMetaSuffix(item)).toBe('')
  })
})
