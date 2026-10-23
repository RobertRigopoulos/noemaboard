import { describe, expect, it } from 'vitest'
import { insertMention, linkify, matchPeople, mentionQueryAt, safeHref, trimTrailing } from './linkify'

const links = (text: string) => linkify(text).filter((s) => s.kind === 'link')

describe('linkify', () => {
  it('returns plain text unchanged', () => {
    expect(linkify('hello world')).toEqual([{ kind: 'text', text: 'hello world' }])
    expect(linkify('')).toEqual([])
  })

  it('finds http(s) links and keeps surrounding text', () => {
    expect(linkify('see https://example.com/a?b=1 now')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: ' now' },
    ])
  })

  it('round-trips the original text', () => {
    const text = 'Links: https://a.io/x, www.b.com. Mail me@c.org (or http://d.net/p_(1)).\nDone!'
    expect(
      linkify(text)
        .map((s) => s.text)
        .join(''),
    ).toBe(text)
  })

  it('strips trailing punctuation and unbalanced brackets', () => {
    expect(links('Go to https://example.com.')[0]).toMatchObject({ text: 'https://example.com' })
    expect(links('(see https://example.com/page)')[0]).toMatchObject({ text: 'https://example.com/page' })
    expect(links('wiki https://en.wikipedia.org/wiki/Foo_(bar) ok')[0]).toMatchObject({
      text: 'https://en.wikipedia.org/wiki/Foo_(bar)',
    })
  })

  it('turns www. into https and bare e-mails into mailto', () => {
    expect(links('www.example.com')[0]).toMatchObject({ href: 'https://www.example.com/' })
    expect(links('mail jane.doe@example.co.uk please')[0]).toMatchObject({
      text: 'jane.doe@example.co.uk',
      href: 'mailto:jane.doe@example.co.uk',
    })
    expect(links('mailto:team@example.com')[0]).toMatchObject({ href: 'mailto:team@example.com' })
  })

  it('never produces javascript:, data: or other unsafe links', () => {
    for (const evil of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(document.cookie)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '<a href="javascript:alert(1)">x</a>',
    ]) {
      for (const seg of linkify(evil)) {
        if (seg.kind === 'link') expect(seg.href).toMatch(/^(https?:|mailto:)/)
      }
      expect(links(evil).some((s) => /javascript|data:|vbscript|file:/i.test(s.href))).toBe(false)
    }
  })

  it('only links the embedded http part of a javascript: string', () => {
    const segs = links("javascript:open('http://evil.example')")
    expect(segs).toHaveLength(1)
    expect(segs[0].href).toBe('http://evil.example/')
  })

  it('handles several links and newlines', () => {
    const segs = links('a https://x.io\nb http://y.io/z')
    expect(segs.map((s) => s.href)).toEqual(['https://x.io/', 'http://y.io/z'])
  })
})

describe('safeHref', () => {
  it('accepts only http, https and mailto', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/')
    expect(safeHref('http://example.com/x')).toBe('http://example.com/x')
    expect(safeHref('mailto:a@b.co')).toBe('mailto:a@b.co')
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('ftp://example.com')).toBeNull()
    expect(safeHref('mailto:not-an-address')).toBeNull()
    expect(safeHref('https://')).toBeNull()
    expect(safeHref('https://' + 'a'.repeat(3000) + '.com')).toBeNull()
  })
})

describe('trimTrailing', () => {
  it('keeps balanced brackets', () => {
    expect(trimTrailing('https://x.io/a_(b)')).toBe('https://x.io/a_(b)')
    expect(trimTrailing('https://x.io/a)')).toBe('https://x.io/a')
    expect(trimTrailing('https://x.io/a!?')).toBe('https://x.io/a')
  })
})

describe('mentions in linkify', () => {
  const ana = { id: 'ana1', name: 'Ana' }
  const anaLu = { id: 'analu', name: 'Ana Lu' }

  it('turns @Name into a mention only for listed people', () => {
    expect(linkify('Hi @Ana!', [ana])).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'mention', text: '@Ana', id: 'ana1' },
      { kind: 'text', text: '!' },
    ])
    // Typed by hand (nobody picked): plain text.
    expect(linkify('Hi @Ana!')).toEqual([{ kind: 'text', text: 'Hi @Ana!' }])
    expect(linkify('Hi @Ana!', [{ id: 'bob1', name: 'Bob' }])).toEqual([{ kind: 'text', text: 'Hi @Ana!' }])
  })

  it('needs the exact name standing on its own', () => {
    expect(linkify('@Anabel', [ana]).some((s) => s.kind === 'mention')).toBe(false)
    expect(linkify('x@Ana', [ana]).some((s) => s.kind === 'mention')).toBe(false)
    expect(linkify('@ana', [ana]).some((s) => s.kind === 'mention')).toBe(false)
  })

  it('prefers the longest name and keeps links working around mentions', () => {
    const segs = linkify('@Ana Lu see https://x.io and @Ana', [ana, anaLu])
    expect(segs.filter((s) => s.kind === 'mention')).toEqual([
      { kind: 'mention', text: '@Ana Lu', id: 'analu' },
      { kind: 'mention', text: '@Ana', id: 'ana1' },
    ])
    expect(segs.filter((s) => s.kind === 'link')).toEqual([{ kind: 'link', text: 'https://x.io', href: 'https://x.io/' }])
    expect(segs.map((s) => s.text).join('')).toBe('@Ana Lu see https://x.io and @Ana')
  })

  it('leaves e-mail addresses alone', () => {
    const segs = linkify('mail ana@example.com', [{ id: 'ex', name: 'example' }])
    expect(segs.some((s) => s.kind === 'mention')).toBe(false)
    expect(segs.some((s) => s.kind === 'link')).toBe(true)
  })
})

describe('typing a mention', () => {
  it('finds the query after @ at the start or after a space', () => {
    expect(mentionQueryAt('@an', 3)).toEqual({ start: 0, query: 'an' })
    expect(mentionQueryAt('hi @Ana L', 9)).toEqual({ start: 3, query: 'Ana L' })
    expect(mentionQueryAt('hi @', 4)).toEqual({ start: 3, query: '' })
    expect(mentionQueryAt('mail@x', 6)).toBeNull()
    expect(mentionQueryAt('@ x', 3)).toBeNull()
    expect(mentionQueryAt('@a\nb', 4)).toBeNull()
    expect(mentionQueryAt('no at here', 5)).toBeNull()
  })

  it('inserts @Name and a space, and puts the caret after them', () => {
    expect(insertMention('hi @an', 3, 6, 'Ana')).toEqual({ text: 'hi @Ana ', caret: 8 })
    expect(insertMention('@an there', 0, 3, 'Ana')).toEqual({ text: '@Ana there', caret: 5 })
  })

  it('matches names by prefix, then by a later word, at most 8', () => {
    const people = [{ name: 'Bob Anders' }, { name: 'Ana' }, { name: 'Carl' }, { name: 'anabel' }]
    expect(matchPeople(people, 'an').map((p) => p.name)).toEqual(['Ana', 'anabel', 'Bob Anders'])
    expect(matchPeople(people, '').map((p) => p.name)).toEqual(['Bob Anders', 'Ana', 'Carl', 'anabel'])
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `Person ${i}` }))
    expect(matchPeople(many, 'p')).toHaveLength(8)
  })
})
