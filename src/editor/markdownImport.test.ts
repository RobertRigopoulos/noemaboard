import { describe, expect, it } from 'vitest'
import type { Node as PMNode } from '@tiptap/pm/model'
import { looksLikeMarkdown, markdownToPmDoc, parseInline } from './markdownImport'

const md = (text: string) => markdownToPmDoc(text)!

/** Compact pre-order outline of a document: "type(attrs)" per node, ":text" for text blocks. */
function outline(doc: PMNode): string[] {
  const out: string[] = []
  doc.descendants((node) => {
    if (node.isText) return false
    const extra =
      node.type.name === 'heading'
        ? `(${node.attrs.level})`
        : node.type.name === 'taskItem'
          ? `(${node.attrs.checked ? 'x' : ' '})`
          : node.type.name === 'orderedList'
            ? `(${node.attrs.start})`
            : node.type.name === 'codeBlock'
              ? `(${node.attrs.language ?? ''})`
              : ''
    out.push(node.isTextblock ? `${node.type.name}${extra}:${node.textContent}` : `${node.type.name}${extra}`)
    return true
  })
  return out
}

function marksOf(doc: PMNode, text: string): string[] {
  let marks: string[] = []
  doc.descendants((n) => {
    if (n.isText && n.text === text) marks = n.marks.map((m) => m.type.name).sort()
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

describe('looksLikeMarkdown', () => {
  it('needs two or more lines with block markers', () => {
    expect(looksLikeMarkdown('# Title\n- item')).toBe(true)
    expect(looksLikeMarkdown('- one\n- two')).toBe(true)
    expect(looksLikeMarkdown('1. one\n2. two')).toBe(true)
    expect(looksLikeMarkdown('- [ ] task\n- [x] done')).toBe(true)
    expect(looksLikeMarkdown('> quote\n> more')).toBe(true)
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('## Notes\n\nsome text\n* point')).toBe(true)
  })

  it('leaves ordinary text alone', () => {
    expect(looksLikeMarkdown('Hello there')).toBe(false)
    expect(looksLikeMarkdown('# just one heading')).toBe(false)
    expect(looksLikeMarkdown('Dear Ada,\nthanks for the notes.\nBest')).toBe(false)
    expect(looksLikeMarkdown('#hashtag\n#another')).toBe(false)
    expect(looksLikeMarkdown('- only one item\nand then prose')).toBe(false)
  })

  it('does not take headings alone for Markdown unless prose follows one', () => {
    expect(looksLikeMarkdown('# first comment\n# second comment')).toBe(false)
    expect(looksLikeMarkdown('# Title\nIntro text\n## Part two\nMore text')).toBe(true)
    expect(looksLikeMarkdown('# Title\n\nIntro text\n\n## Part two')).toBe(true)
  })

  it('leaves code and configuration alone', () => {
    const python = [
      '# Settings for the run',
      'class Runner:',
      '    def __init__(self, *args, **kwargs):',
      '        # keep the arguments',
      '        self.args = args',
    ].join('\n')
    expect(looksLikeMarkdown(python)).toBe(false)
    expect(looksLikeMarkdown('#!/bin/bash\n# build\n- not a list\n- really')).toBe(false)
    expect(looksLikeMarkdown('# install\nnpm install\n# start\nnpm start')).toBe(false)
    expect(looksLikeMarkdown('# compute\ntotal = a + b\n# show\nprint(total)')).toBe(false)
    const yaml = ['# CI', 'name: build', 'on: [push]', 'jobs:', '  test:', '    steps:', '      - uses: actions/checkout@v4', '      - run: npm test'].join('\n')
    expect(looksLikeMarkdown(yaml)).toBe(false)
    const js = ['// helpers', '- not markdown', 'const x = 1;', 'function f() {', '  return x', '}', '- either'].join('\n')
    expect(looksLikeMarkdown(js)).toBe(false)
  })

  it('still reads Markdown that shows code in fences, or lists with labels', () => {
    const readme = ['# Noema', '', 'A free board app.', '', '## Install', '', '```bash', 'npm install', 'npm start', '```', '', '- fast', '- free'].join('\n')
    expect(looksLikeMarkdown(readme)).toBe(true)
    const fencedPython = ['## Example', '```python', '# a comment', 'def f(x):', '    return x', '```', '- see above'].join('\n')
    expect(looksLikeMarkdown(fencedPython)).toBe(true)
    expect(looksLikeMarkdown('## Plan\nThings to do:\n- buy milk\n- call Ada\nLater:\n- rest')).toBe(true)
    expect(looksLikeMarkdown('## Week\n- Monday: gym\n- Tuesday: swim\n- Wednesday: rest')).toBe(true)
  })
})

describe('markdownToPmDoc blocks', () => {
  it('converts headings 1-3 (deeper levels become 3)', () => {
    expect(outline(md('# One\n## Two\n### Three\n#### Four\n####### not a heading'))).toEqual([
      'heading(1):One',
      'heading(2):Two',
      'heading(3):Three',
      'heading(3):Four',
      'paragraph:####### not a heading',
    ])
  })

  it('converts bullet, numbered and task lists with nesting', () => {
    const doc = md('- a\n  - a1\n  - a2\n- b\n\n3. three\n4. four\n\n- [ ] open\n- [x] done\n  - [X] nested done')
    expect(outline(doc)).toEqual([
      'bulletList',
      'listItem',
      'paragraph:a',
      'bulletList',
      'listItem',
      'paragraph:a1',
      'listItem',
      'paragraph:a2',
      'listItem',
      'paragraph:b',
      'orderedList(3)',
      'listItem',
      'paragraph:three',
      'listItem',
      'paragraph:four',
      'taskList',
      'taskItem( )',
      'paragraph:open',
      'taskItem(x)',
      'paragraph:done',
      'taskList',
      'taskItem(x)',
      'paragraph:nested done',
    ])
  })

  it('converts quotes, fenced code and rules', () => {
    const doc = md('> quoted **text**\n> - in a list\n\n```ts\nconst a = 1 < 2\n  indented\n```\n\n---\nafter')
    expect(outline(doc)).toEqual([
      'blockquote',
      'paragraph:quoted text',
      'bulletList',
      'listItem',
      'paragraph:in a list',
      'codeBlock(ts):const a = 1 < 2\n  indented',
      'horizontalRule',
      'paragraph:after',
    ])
  })

  it('keeps paragraph lines as hard breaks', () => {
    const doc = md('# T\nline one\nline two')
    const para = doc.child(1)
    expect(para.type.name).toBe('paragraph')
    expect(para.childCount).toBe(3)
    expect(para.child(1).type.name).toBe('hardBreak')
  })

  it('drops an unsafe fence language', () => {
    const doc = md('```x" onload="y\ncode\n```\n- a')
    expect(doc.child(0).attrs.language).toBeNull()
  })
})

describe('markdownToPmDoc inline', () => {
  it('converts bold, italic, strike and code', () => {
    const doc = md('# T\n**bold** *it* _also_ ~~gone~~ `x < y` __strong__')
    expect(marksOf(doc, 'bold')).toEqual(['bold'])
    expect(marksOf(doc, 'it')).toEqual(['italic'])
    expect(marksOf(doc, 'also')).toEqual(['italic'])
    expect(marksOf(doc, 'gone')).toEqual(['strike'])
    expect(marksOf(doc, 'x < y')).toEqual(['code'])
    expect(marksOf(doc, 'strong')).toEqual(['bold'])
  })

  it('nests marks and leaves snake_case and lone stars alone', () => {
    const nodes = parseInline('**bold _both_** snake_case_name 2 * 3 = 6')
    const json = JSON.stringify(nodes)
    expect(json).toContain('"text":"both","marks":[{"type":"bold"},{"type":"italic"}]')
    expect(nodes.map((n) => n.text).join('')).toBe('bold both snake_case_name 2 * 3 = 6')
  })

  it('keeps http(s) and mailto links only', () => {
    const doc = md(
      '- [site](https://example.com/a_b) and [mail](mailto:ada@example.com)\n- [evil](javascript:alert(1)) [data](data:text/html,x) [rel](#top) [bare](example.org)',
    )
    expect(hrefOf(doc, 'site')).toBe('https://example.com/a_b')
    expect(hrefOf(doc, 'mail')).toBe('mailto:ada@example.com')
    expect(hrefOf(doc, 'evil')).toBeNull()
    expect(hrefOf(doc, 'data')).toBeNull()
    expect(hrefOf(doc, 'rel')).toBeNull()
    expect(hrefOf(doc, 'bare')).toBe('https://example.org')
    expect(doc.textContent).toContain('evil')
  })

  it('honours backslash escapes', () => {
    expect(parseInline('\\*not italic\\*').map((n) => n.text).join('')).toBe('*not italic*')
  })
})

describe('markdownToPmDoc edge cases', () => {
  it('returns null for empty text', () => {
    expect(markdownToPmDoc('')).toBeNull()
    expect(markdownToPmDoc('   \n  ')).toBeNull()
  })

  it('never throws on odd input', () => {
    for (const s of ['```', '> ', '- ', '1.', '[x](', '**', '- [ ]', '#', '\t- a\n- b\n\t\t- c']) {
      expect(() => markdownToPmDoc(s)).not.toThrow()
    }
  })
})
