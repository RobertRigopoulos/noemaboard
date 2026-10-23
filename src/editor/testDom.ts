/**
 * A tiny DOM for unit tests of HTML import (tests run in Node without a browser DOM). It parses with
 * htmlparser2 and implements just what ProseMirror's DOMParser and TipTap's parse rules read:
 * the node tree, attributes, inline styles, simple selectors (tag, [attr], [attr="v"], .class).
 * Only imported by *.test.ts files.
 */
import { parseDocument } from 'htmlparser2'

type AnyNode = { type: string; name?: string; attribs?: Record<string, string>; children?: AnyNode[]; data?: string }

class FakeDocument {
  createTextNode(text: string): FakeText {
    return new FakeText(text, this)
  }
}

class FakeNode {
  parentNode: FakeElement | null = null
  childNodes: FakeNode[] = []
  readonly nodeType: number
  readonly nodeName: string
  readonly ownerDocument: FakeDocument

  constructor(nodeType: number, nodeName: string, doc: FakeDocument) {
    this.nodeType = nodeType
    this.nodeName = nodeName
    this.ownerDocument = doc
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null
  }
  get nextSibling(): FakeNode | null {
    const p = this.parentNode
    return p ? (p.childNodes[p.childNodes.indexOf(this) + 1] ?? null) : null
  }
  get previousSibling(): FakeNode | null {
    const p = this.parentNode
    return p ? (p.childNodes[p.childNodes.indexOf(this) - 1] ?? null) : null
  }
  get parentElement(): FakeElement | null {
    return this.parentNode
  }
  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('')
  }
  removeChild(child: FakeNode): FakeNode {
    const i = this.childNodes.indexOf(child)
    if (i >= 0) this.childNodes.splice(i, 1)
    child.parentNode = null
    return child
  }
  appendChild(child: FakeNode): FakeNode {
    child.parentNode?.removeChild(child)
    this.childNodes.push(child)
    child.parentNode = this as unknown as FakeElement
    return child
  }
}

class FakeText extends FakeNode {
  nodeValue: string
  constructor(text: string, doc: FakeDocument) {
    super(3, '#text', doc)
    this.nodeValue = text
  }
  get textContent(): string {
    return this.nodeValue
  }
}

class FakeComment extends FakeNode {
  nodeValue: string
  constructor(text: string, doc: FakeDocument) {
    super(8, '#comment', doc)
    this.nodeValue = text
  }
  get textContent(): string {
    return ''
  }
}

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const decl of style.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const name = decl.slice(0, i).trim().toLowerCase()
    const value = decl.slice(i + 1).trim()
    if (name && value) out.set(name, value)
  }
  return out
}

interface SimpleSelector {
  tag: string | null
  attrs: { name: string; value: string | null }[]
  classes: string[]
}

function parseSelector(sel: string): SimpleSelector[] {
  return sel.split(',').map((part) => {
    const s = part.trim()
    const tag = /^[a-z][a-z0-9-]*/i.exec(s)?.[0]?.toLowerCase() ?? null
    const attrs: SimpleSelector['attrs'] = []
    for (const m of s.matchAll(/\[([a-z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/gi)) attrs.push({ name: m[1].toLowerCase(), value: m[2] ?? null })
    const classes = Array.from(s.replace(/\[[^\]]*\]/g, '').matchAll(/\.([a-z0-9_-]+)/gi), (m) => m[1])
    return { tag, attrs, classes }
  })
}

class FakeElement extends FakeNode {
  readonly tagName: string
  private attrs = new Map<string, string>()

  constructor(name: string, attribs: Record<string, string>, doc: FakeDocument) {
    super(1, name.toUpperCase(), doc)
    this.tagName = name.toUpperCase()
    for (const [k, v] of Object.entries(attribs)) this.attrs.set(k.toLowerCase(), v)
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name.toLowerCase())
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name.toLowerCase(), String(value))
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name.toLowerCase())
  }
  get attributes(): { name: string; value: string }[] {
    return Array.from(this.attrs, ([name, value]) => ({ name, value }))
  }
  get style(): Record<string, unknown> & { length: number; getPropertyValue: (name: string) => string } {
    const map = parseStyle(this.getAttribute('style') ?? '')
    const base = { length: map.size, getPropertyValue: (name: string) => map.get(name.toLowerCase()) ?? '' }
    return new Proxy(base as Record<string, unknown> & typeof base, {
      get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : typeof prop === 'string' ? (map.get(kebab(prop)) ?? '') : undefined),
    })
  }
  get classList(): string[] & { contains: (c: string) => boolean } {
    const tokens = (this.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    return Object.assign(tokens, { contains: (c: string) => tokens.includes(c) })
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement)
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null
  }
  matches(selector: string): boolean {
    return parseSelector(selector).some(
      (s) =>
        (!s.tag || s.tag === '*' || s.tag === this.tagName.toLowerCase()) &&
        s.attrs.every((a) => (a.value === null ? this.hasAttribute(a.name) : this.getAttribute(a.name) === a.value)) &&
        s.classes.every((c) => this.classList.contains(c)),
    )
  }
  querySelector(selector: string): FakeElement | null {
    for (const child of this.children) {
      if (child.matches(selector)) return child
      const deeper = child.querySelector(selector)
      if (deeper) return deeper
    }
    return null
  }
  closest(selector: string): FakeElement | null {
    if (this.matches(selector)) return this
    return this.parentNode ? this.parentNode.closest(selector) : null
  }
}

function build(node: AnyNode, doc: FakeDocument): FakeNode | null {
  switch (node.type) {
    case 'text':
      return new FakeText(node.data ?? '', doc)
    case 'comment':
      return new FakeComment(node.data ?? '', doc)
    case 'tag':
    case 'script':
    case 'style': {
      const el = new FakeElement(node.name ?? 'div', node.attribs ?? {}, doc)
      for (const child of node.children ?? []) {
        const c = build(child, doc)
        if (c) el.appendChild(c)
      }
      return el
    }
    default:
      return null
  }
}

/** Parses HTML into a fake <body> element usable where the import code expects a DOM. */
export function fakeHtmlBody(html: string): ParentNode {
  const doc = new FakeDocument()
  const body = new FakeElement('body', {}, doc)
  const parsed = parseDocument(html) as unknown as AnyNode
  const add = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      // Like a browser: <html>, <head> and <body> wrappers are unwrapped into the body.
      if (n.type === 'tag' && (n.name === 'html' || n.name === 'body')) add(n.children ?? [])
      else if (n.type === 'tag' && n.name === 'head') continue
      else {
        const c = build(n, doc)
        if (c) body.appendChild(c)
      }
    }
  }
  add(parsed.children ?? [])
  return body as unknown as ParentNode
}
