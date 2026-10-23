/**
 * Board -> Markdown / plain text. Walks the TipTap/ProseMirror structure stored in each card's
 * Y.XmlFragment (paragraph, heading, lists, task lists, quotes, code) so headings and lists keep
 * their meaning, and lays cards out in reading order (top-to-bottom, then left-to-right). Cards in
 * the board's Unsorted drawer follow at the end, under their own heading.
 * Pure: no DOM, safe to run in tests and workers.
 */
import * as Y from 'yjs'
import { columnChildren, getCards, isTrashed, readCard, readMeta } from '../../model/board'
import { memberName } from '../../model/members'
import type { Card, CardMap } from '../../model/types'
import { readAlt } from '../../cards/media/altText'
import { cleanMentionLabel } from '../../editor/mentionAttrs'
import { cleanAssignee, cleanDue, dueDate, dueTime } from '../../editor/taskMeta'

type Mode = 'md' | 'text'

export interface ExportOptions {
  /** Relative path written for image/file references (Markdown only). */
  assetPath?: (kind: 'image' | 'file', hash: string, name: string, mime: string) => string
}

// ---------------------------------------------------------------------------
// Reading order

export interface Positioned {
  id: string
  x: number
  y: number
}

/** Cards whose tops are within this many board units are read as one row, left to right. */
export const ROW_TOLERANCE = 40

export function readingOrder<T extends Positioned>(items: readonly T[], tolerance = ROW_TOLERANCE): T[] {
  const byY = [...items].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1))
  const out: T[] = []
  let i = 0
  while (i < byY.length) {
    const rowTop = byY[i].y
    const row: T[] = []
    while (i < byY.length && byY[i].y - rowTop <= tolerance) row.push(byY[i++])
    row.sort((a, b) => a.x - b.x || a.y - b.y || (a.id < b.id ? -1 : 1))
    out.push(...row)
  }
  return out
}

// ---------------------------------------------------------------------------
// Escaping

/** Backslash-escapes characters Markdown would treat as formatting. */
export function escapeMarkdown(s: string): string {
  return s.replace(/([\\`*_~[\]<>|])/g, '\\$1')
}

/** Escapes block syntax that only matters at the start of a line (headings, lists, quotes, rules). */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6})(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)([-+])(?=\s)/, '$1\\$2')
    .replace(/^(\s*)(\d{1,9})([.)])(?=\s)/, '$1$2\\$3')
    .replace(/^(\s*)(=+|-{3,})\s*$/, '$1\\$2')
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s]*$/i

/** Only http(s) and mailto links are exported as links; anything else becomes plain text. */
export function safeUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const u = url.trim()
  if (!u || u.length > 4000 || !SAFE_URL.test(u)) return null
  return u
}

function mdLinkTarget(url: string): string {
  return /[()<>\s]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url
}

function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  const pad = /^`|`$/.test(text) || /^ .* $/.test(text) ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

// ---------------------------------------------------------------------------
// Rich text (Y.XmlFragment) -> Markdown / text

interface Marks {
  bold: boolean
  italic: boolean
  strike: boolean
  code: boolean
  link: string | null
}

function readMarks(attrs: Record<string, unknown> | undefined): Marks {
  const m: Marks = { bold: false, italic: false, strike: false, code: false, link: null }
  if (!attrs) return m
  for (const [rawKey, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue
    // y-prosemirror stores overlapping marks of one type as `<name>--<hash>`.
    const key = rawKey.split('--')[0]
    if (key === 'bold' || key === 'strong') m.bold = true
    else if (key === 'italic' || key === 'em') m.italic = true
    else if (key === 'strike' || key === 'strikethrough') m.strike = true
    else if (key === 'code') m.code = true
    else if (key === 'link' && typeof value === 'object') m.link = safeUrl((value as { href?: unknown }).href)
  }
  return m
}

type Segment = { kind: 'text'; text: string; marks: Marks } | { kind: 'break' } | { kind: 'image'; alt: string; src: string }

const NO_MARKS: Marks = { bold: false, italic: false, strike: false, code: false, link: null }

type XNode = Y.XmlElement | Y.XmlText

function wrap(text: string, marker: string): string {
  // Emphasis markers must hug non-space characters: keep surrounding whitespace outside.
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!
  if (!m[2]) return text
  return `${m[1]}${marker}${m[2]}${marker}${m[3]}`
}

function renderSegment(seg: { text: string; marks: Marks }, mode: Mode): string {
  if (mode === 'text') return seg.text
  if (seg.marks.code) return codeSpan(seg.text)
  let t = escapeMarkdown(seg.text)
  if (seg.marks.strike) t = wrap(t, '~~')
  if (seg.marks.italic) t = wrap(t, '*')
  if (seg.marks.bold) t = wrap(t, '**')
  return t
}

/** Collects inline content; hard breaks become '\n' segments, nested inline nodes are flattened. */
function collectInline(children: XNode[], out: Segment[]) {
  for (const child of children) {
    if (child instanceof Y.XmlText) {
      for (const op of child.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        if (typeof op.insert === 'string' && op.insert) out.push({ kind: 'text', text: op.insert, marks: readMarks(op.attributes) })
      }
    } else if (child instanceof Y.XmlElement) {
      if (child.nodeName === 'hardBreak') out.push({ kind: 'break' })
      else if (child.nodeName === 'mention') {
        // An atom: the label stored when it was inserted reads well even for people who never met that member.
        out.push({ kind: 'text', text: `@${cleanMentionLabel(child.getAttribute('label')) || 'someone'}`, marks: NO_MARKS })
      } else if (child.nodeName === 'image') {
        const src = safeUrl(child.getAttribute('src'))
        // Peers write the alt: one clean, capped line, so it cannot break the ![alt](src) syntax.
        if (src) out.push({ kind: 'image', alt: readAlt(child.getAttribute('alt')), src })
      } else collectInline(child.toArray() as XNode[], out)
    }
  }
}

function inline(children: XNode[], mode: Mode): string {
  const segs: Segment[] = []
  collectInline(children, segs)
  let out = ''
  let i = 0
  while (i < segs.length) {
    const seg = segs[i]
    if (seg.kind === 'image') {
      out += mode === 'md' ? `![${escapeMarkdown(seg.alt)}](${mdLinkTarget(seg.src)})` : seg.alt || seg.src
      i++
      continue
    }
    if (seg.kind === 'break') {
      out += mode === 'md' ? '\\\n' : '\n'
      i++
      continue
    }
    const link = seg.marks.link
    if (!link) {
      out += renderSegment(seg, mode)
      i++
      continue
    }
    // Consecutive segments sharing one link become a single [text](url).
    let label = ''
    while (i < segs.length) {
      const s = segs[i]
      if (s.kind !== 'text' || s.marks.link !== link) break
      label += renderSegment(s, mode)
      i++
    }
    if (mode === 'md') out += `[${label}](${mdLinkTarget(link)})`
    else out += label.trim() === link ? link : `${label} (${link})`
  }
  return out
}

function paragraphText(children: XNode[], mode: Mode): string {
  const text = inline(children, mode)
  if (mode === 'text') return text
  return text
    .split('\n')
    .map((line) => escapeLineStart(line))
    .join('\n')
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((l, i) => (i === 0 || !l ? l : pad + l))
    .join('\n')
}

function rawText(el: Y.XmlElement | Y.XmlFragment): string {
  let s = ''
  for (const c of el.toArray() as XNode[]) {
    if (c instanceof Y.XmlText) {
      for (const op of c.toDelta() as { insert: unknown }[]) if (typeof op.insert === 'string') s += op.insert
    } else if (c instanceof Y.XmlElement) s += c.nodeName === 'hardBreak' ? '\n' : rawText(c)
  }
  return s
}

function intAttr(el: Y.XmlElement, name: string, d: number): number {
  const v = Number(el.getAttribute(name))
  return Number.isFinite(v) ? Math.trunc(v) : d
}

function isChecked(el: Y.XmlElement): boolean {
  const v = el.getAttribute('checked') as unknown
  return v === true || v === 'true'
}

interface WalkCtx {
  mode: Mode
  headingOffset: number
}

function renderBlocks(children: XNode[], ctx: WalkCtx, sep = '\n\n'): string {
  const parts: string[] = []
  let loose: XNode[] = []
  const flushLoose = () => {
    // Text directly inside a container (malformed or foreign docs) is treated as a paragraph.
    if (loose.length) {
      const t = paragraphText(loose, ctx.mode)
      if (t.trim()) parts.push(t)
      loose = []
    }
  }
  for (const child of children) {
    if (child instanceof Y.XmlText || (child instanceof Y.XmlElement && child.nodeName === 'hardBreak')) {
      loose.push(child)
      continue
    }
    flushLoose()
    const b = renderBlock(child, ctx)
    if (b !== null && b.trim() !== '') parts.push(b)
  }
  flushLoose()
  return parts.join(sep)
}

/**
 * " (due 2026-10-24 14:30, @Ada)" for a task with a due date and/or an assignee, else ''. The name
 * comes from the board's member roster; both attributes arrive from peers and are validated.
 */
export function taskMetaSuffix(item: Y.XmlElement, mode: Mode = 'md'): string {
  const parts: string[] = []
  const due = cleanDue(item.getAttribute('due'))
  if (due) {
    const time = dueTime(due)
    parts.push(`due ${dueDate(due)}${time ? ` ${time}` : ''}`)
  }
  const assignee = cleanAssignee(item.getAttribute('assignee'))
  if (assignee) {
    const name = (item.doc && memberName(item.doc, assignee)) || 'someone'
    parts.push(`@${mode === 'md' ? escapeMarkdown(name) : name}`)
  }
  return parts.length ? ` (${parts.join(', ')})` : ''
}

/** A task's own line with its due date and assignee appended, then any nested content. */
function taskBody(item: Y.XmlElement, ctx: WalkCtx): string {
  const children = item.toArray() as XNode[]
  const suffix = taskMetaSuffix(item, ctx.mode)
  const first = children[0]
  if (!suffix || !(first instanceof Y.XmlElement) || first.nodeName !== 'paragraph') {
    const body = renderBlocks(children, ctx, '\n')
    return suffix ? `${body}${suffix}`.trim() : body
  }
  const line = `${paragraphText(first.toArray() as XNode[], ctx.mode)}${suffix}`.trim()
  const rest = renderBlocks(children.slice(1), ctx, '\n')
  return rest ? `${line}\n${rest}` : line
}

function renderList(el: Y.XmlElement, ctx: WalkCtx): string {
  const kind = el.nodeName
  const start = kind === 'orderedList' ? Math.max(0, intAttr(el, 'start', 1)) : 1
  const items = (el.toArray() as XNode[]).filter((c): c is Y.XmlElement => c instanceof Y.XmlElement)
  const lines: string[] = []
  items.forEach((item, i) => {
    let marker: string
    if (kind === 'orderedList') marker = `${start + i}. `
    else if (kind === 'taskList' || item.nodeName === 'taskItem')
      marker = ctx.mode === 'md' ? `- [${isChecked(item) ? 'x' : ' '}] ` : `[${isChecked(item) ? 'x' : ' '}] `
    else marker = ctx.mode === 'md' ? '- ' : '• '
    const body = item.nodeName === 'taskItem' ? taskBody(item, ctx) : renderBlocks(item.toArray() as XNode[], ctx, '\n')
    // Continuation lines align under the item text (CommonMark: marker width).
    const contentIndent = kind === 'orderedList' ? marker.length : 2
    lines.push(marker + indent(body, contentIndent))
  })
  return lines.join('\n')
}

function renderBlock(el: Y.XmlElement, ctx: WalkCtx): string | null {
  const { mode } = ctx
  const children = el.toArray() as XNode[]
  switch (el.nodeName) {
    case 'paragraph':
      return paragraphText(children, mode)
    case 'heading': {
      const text = inline(children, mode)
      if (!text.trim()) return null
      if (mode === 'text') return text
      const level = Math.min(6, Math.max(1, intAttr(el, 'level', 1) + ctx.headingOffset))
      return `${'#'.repeat(level)} ${text.replace(/\\\n/g, ' ')}`
    }
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return renderList(el, ctx)
    case 'listItem':
    case 'taskItem':
      return renderBlocks(children, ctx, '\n')
    case 'blockquote': {
      const inner = renderBlocks(children, ctx)
      return inner
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n')
    }
    case 'codeBlock': {
      const text = rawText(el)
      if (mode === 'text') return text
      const lang = String(el.getAttribute('language') ?? '')
      const safeLang = /^[\w+#.-]{1,30}$/.test(lang) ? lang : ''
      const longest = Math.max(0, ...(text.match(/`{3,}/g) ?? []).map((m) => m.length))
      const fence = '`'.repeat(Math.max(3, longest + 1))
      return `${fence}${safeLang}\n${text}\n${fence}`
    }
    case 'horizontalRule':
      return mode === 'md' ? '---' : '———'
    case 'image': {
      const src = safeUrl(el.getAttribute('src'))
      const alt = readAlt(el.getAttribute('alt'))
      if (!src) return null
      return mode === 'md' ? `![${escapeMarkdown(alt)}](${mdLinkTarget(src)})` : alt || src
    }
    default: {
      // Unknown node: keep its content rather than dropping text.
      const hasBlocks = children.some((c) => c instanceof Y.XmlElement && c.nodeName !== 'hardBreak')
      return hasBlocks ? renderBlocks(children, ctx) : paragraphText(children, mode)
    }
  }
}

/** Converts a rich-text fragment to Markdown. `headingOffset` pushes headings down (h1 -> h3 with 2). */
export function fragmentToMarkdown(frag: Y.XmlFragment | Y.XmlElement, headingOffset = 0): string {
  return renderBlocks(frag.toArray() as XNode[], { mode: 'md', headingOffset }).trim()
}

/** Plain text with list markers kept ("• item", "1. item", "[x] done"). */
export function fragmentToText(frag: Y.XmlFragment | Y.XmlElement): string {
  return renderBlocks(frag.toArray() as XNode[], { mode: 'text', headingOffset: 0 }).trim()
}

// ---------------------------------------------------------------------------
// Cards

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'application/pdf': '.pdf',
}

/** File extension from the original name (sanitised) or the MIME type. */
export function extensionFor(name: string, mime: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name)
  if (m) return `.${m[1].toLowerCase()}`
  return MIME_EXT[mime] ?? ''
}

export const defaultAssetPath = (kind: 'image' | 'file', hash: string, name: string, mime: string) =>
  `${kind === 'image' ? 'images' : 'files'}/${hash}${extensionFor(name, mime)}`

const str = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.slice(0, max) : '')
const isHash = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)

function fragmentField(map: CardMap, field: string): Y.XmlFragment | null {
  const v = map.get(field)
  return v instanceof Y.XmlFragment ? v : null
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let n = bytes
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

interface CardCtx {
  mode: Mode
  /** Heading level for card titles (3 on the board, 4 inside a column). */
  titleLevel: number
  opts: ExportOptions
}

function title(text: string, ctx: CardCtx): string {
  if (ctx.mode === 'text') return text
  return `${'#'.repeat(Math.min(6, ctx.titleLevel))} ${escapeMarkdown(text)}`
}

function esc(text: string, mode: Mode): string {
  return mode === 'md' ? escapeMarkdown(text) : text
}

function quote(text: string): string {
  return text
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n')
}

function richField(map: CardMap, field: string, ctx: CardCtx, offset: number): string {
  const frag = fragmentField(map, field)
  if (!frag) return ''
  return ctx.mode === 'md' ? fragmentToMarkdown(frag, offset) : fragmentToText(frag)
}

/** Renders one (non-column, non-line) card. Returns '' for cards with nothing to show. */
function renderCard(map: CardMap, card: Card, ctx: CardCtx): string {
  const { mode } = ctx
  const raw = card as Card & Record<string, unknown>
  const parts: string[] = []
  const offset = ctx.titleLevel - 1
  switch (card.type) {
    case 'note': {
      parts.push(richField(map, 'content', ctx, offset))
      break
    }
    case 'todo':
    case 'document': {
      const t = str(raw.title, 500).trim()
      if (t) parts.push(title(t, ctx))
      parts.push(richField(map, 'content', ctx, card.type === 'document' ? ctx.titleLevel : offset))
      break
    }
    case 'link': {
      const url = safeUrl(raw.url)
      const t = str(raw.title, 500).trim()
      const label = t || url || str(raw.url, 500)
      if (url && mode === 'md') parts.push(`[${escapeMarkdown(label)}](${mdLinkTarget(url)})`)
      else if (url) parts.push(t && t !== url ? `${t}\n${url}` : url)
      else if (label) parts.push(esc(label, mode))
      const desc = str(raw.description, 2000).trim()
      if (desc) parts.push(esc(desc, mode))
      parts.push(richField(map, 'caption', ctx, offset))
      break
    }
    case 'image': {
      const name = str(raw.name, 300) || 'Image'
      // Alt text describes the picture; the file name is the fallback. One clean line either way.
      const alt = readAlt(raw.alt) || readAlt(name) || 'Image'
      const hash = raw.blob
      if (mode === 'md' && isHash(hash)) {
        const path = (ctx.opts.assetPath ?? defaultAssetPath)('image', hash, name, str(raw.mime, 100))
        parts.push(`![${escapeMarkdown(alt)}](${mdLinkTarget(path)})`)
      } else parts.push(mode === 'md' ? `*[Image: ${escapeMarkdown(alt)}]*` : `[Image: ${alt}]`)
      parts.push(richField(map, 'caption', ctx, offset))
      break
    }
    case 'file': {
      const name = str(raw.name, 300) || 'File'
      const size = formatSize(typeof raw.size === 'number' ? raw.size : 0)
      const hash = raw.blob
      if (mode === 'md' && isHash(hash)) {
        const path = (ctx.opts.assetPath ?? defaultAssetPath)('file', hash, name, str(raw.mime, 100))
        parts.push(`[${escapeMarkdown(name)}](${mdLinkTarget(path)})${size ? ` (${size})` : ''}`)
      } else parts.push(`[File: ${esc(name, mode)}${size ? `, ${size}` : ''}]`)
      break
    }
    case 'board': {
      // Board icons are icon ids, which mean nothing as text: only the title is exported.
      const t = str(raw.title, 300).trim() || 'Untitled board'
      parts.push(mode === 'md' ? `**${escapeMarkdown(t)}** *(board)*` : `[Board: ${t}]`)
      break
    }
    case 'comment': {
      const thread = map.get('thread')
      const lines: string[] = []
      if (thread instanceof Y.Array) {
        for (const msg of thread.toArray().slice(0, 1000)) {
          if (!(msg instanceof Y.Map)) continue
          const author = str(msg.get('authorName'), 80).trim() || 'Someone'
          const text = str(msg.get('text'), 10_000).trim()
          if (!text) continue
          lines.push(mode === 'md' ? `**${escapeMarkdown(author)}:** ${escapeMarkdown(text)}` : `${author}: ${text}`)
        }
      }
      if (!lines.length) break
      const head = raw.resolved === true ? 'Comment (resolved)' : 'Comment'
      if (mode === 'md') parts.push(quote([`*${head}*`, ...lines].join('\n\n')))
      else parts.push([`${head}:`, ...lines.map((l) => `  ${l}`)].join('\n'))
      break
    }
    case 'swatch': {
      const hex = /^#[0-9a-fA-F]{3,8}$/.test(str(raw.hex, 20)) ? str(raw.hex, 20) : ''
      const name = str(raw.name, 200).trim()
      const label = [name, hex].filter(Boolean).join(' ')
      if (label) parts.push(mode === 'md' ? `**Color:** ${name ? `${escapeMarkdown(name)} ` : ''}${hex ? `\`${hex}\`` : ''}`.trim() : `Color: ${label}`)
      break
    }
    case 'sketch':
      parts.push(mode === 'md' ? '*[Sketch]*' : '[Sketch]')
      break
  }
  return parts.filter((p) => p.trim()).join('\n\n')
}

/** Short label for a card, used to describe connections. */
function cardLabel(map: CardMap, card: Card): string {
  const raw = card as Card & Record<string, unknown>
  let t = str(raw.title, 200) || str(raw.name, 200) || str(raw.label, 200)
  if (!t) {
    const frag = fragmentField(map, 'content')
    if (frag) t = fragmentToText(frag).split('\n').find((l) => l.trim()) ?? ''
  }
  if (!t && card.type === 'link') t = str(raw.url, 200)
  if (!t && card.type === 'swatch') t = str(raw.hex, 20)
  t = t.replace(/\s+/g, ' ').trim()
  if (t.length > 48) t = `${t.slice(0, 47)}…`
  return t || ({ note: 'Note', column: 'Column', image: 'Image', sketch: 'Sketch', comment: 'Comment' } as Record<string, string>)[card.type] || 'Card'
}

interface Entry {
  id: string
  x: number
  y: number
  map: CardMap
  card: Card
}

function render(doc: Y.Doc, mode: Mode, opts: ExportOptions): string {
  const meta = readMeta(doc)
  const cards = getCards(doc)
  const active = new Map<string, Entry>()
  cards.forEach((map, id) => {
    if (!(map instanceof Y.Map) || isTrashed(map)) return
    const card = readCard(map)
    active.set(id, { id, x: card.x, y: card.y, map, card })
  })

  const out: string[] = []
  const boardTitle = meta.title.trim() || 'Untitled board'
  out.push(mode === 'md' ? `# ${escapeMarkdown(boardTitle)}` : `${boardTitle}\n${'='.repeat(Math.min(60, Math.max(3, boardTitle.length)))}`)

  const isColumnChild = (e: Entry) => {
    const p = e.card.parent
    return !!p && active.get(p)?.card.type === 'column'
  }
  const topLevel = Array.from(active.values()).filter((e) => e.card.type !== 'line' && !isColumnChild(e))
  const inDrawer = (e: Entry) => e.card.unsorted === true
  const top = readingOrder(topLevel.filter((e) => !inDrawer(e)))
  const drawer = topLevel.filter(inDrawer).sort((a, b) => (a.card.order < b.card.order ? -1 : a.card.order > b.card.order ? 1 : a.id < b.id ? -1 : 1))

  /** A column becomes a section (heading `level`) with its cards; any other card renders on its own. */
  const renderTop = (e: Entry, level: number): string => {
    if (e.card.type !== 'column') return renderCard(e.map, e.card, { mode, titleLevel: level + 1, opts })
    const t = str((e.card as Card & Record<string, unknown>).title, 300).trim() || 'Untitled column'
    const heading = mode === 'md' ? `${'#'.repeat(level)} ${escapeMarkdown(t)}` : `${t}\n${'-'.repeat(Math.min(60, Math.max(3, t.length)))}`
    const section: string[] = [heading]
    for (const childId of columnChildren(doc, e.id)) {
      const child = active.get(childId)
      if (!child || child.card.type === 'line' || child.card.type === 'column') continue
      const r = renderCard(child.map, child.card, { mode, titleLevel: level + 2, opts })
      if (r) section.push(r)
    }
    if (section.length === 1) section.push(mode === 'md' ? '*Empty column*' : '(empty column)')
    return section.join('\n\n')
  }

  const blocks: string[] = []
  for (const e of top) {
    const r = renderTop(e, 2)
    if (r) blocks.push(r)
  }
  if (!blocks.length && !drawer.length) blocks.push(mode === 'md' ? '*This board is empty.*' : '(This board is empty.)')
  out.push(...blocks)

  // Lines between cards read as "A → B: label".
  const connections: string[] = []
  for (const e of active.values()) {
    if (e.card.type !== 'line') continue
    const from = e.card.from.card ? active.get(e.card.from.card) : undefined
    const to = e.card.to.card ? active.get(e.card.to.card) : undefined
    const label = e.card.label.trim()
    if (!from || !to) {
      if (label) connections.push(mode === 'md' ? `- ${escapeMarkdown(label)}` : `- ${label}`)
      continue
    }
    const arrow = e.card.arrowStart && e.card.arrowEnd ? '↔' : e.card.arrowStart ? '←' : e.card.arrowEnd ? '→' : '—'
    const a = cardLabel(from.map, from.card)
    const b = cardLabel(to.map, to.card)
    const line = `${a} ${arrow} ${b}${label ? `: ${label}` : ''}`
    connections.push(mode === 'md' ? `- ${escapeMarkdown(line)}` : `- ${line}`)
  }
  if (connections.length) {
    out.push(mode === 'md' ? '## Connections' : 'Connections\n-----------')
    out.push(connections.join('\n'))
  }

  // Cards waiting in the Unsorted drawer, in drawer order, last.
  const unsorted: string[] = []
  for (const e of drawer) {
    const r = renderTop(e, 3)
    if (r) unsorted.push(r)
  }
  if (unsorted.length) {
    out.push(mode === 'md' ? '## Unsorted' : 'Unsorted\n--------')
    out.push(...unsorted)
  }
  return `${out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/** The whole board as Markdown: columns become sections, cards follow in reading order. */
export function exportMarkdown(doc: Y.Doc, opts: ExportOptions = {}): string {
  return render(doc, 'md', opts)
}

/** The whole board as plain text. */
export function exportPlainText(doc: Y.Doc): string {
  return render(doc, 'text', {})
}

/** Blob hashes of images/files referenced by active cards, for bundling next to the Markdown. */
export function referencedAssets(doc: Y.Doc): { kind: 'image' | 'file'; hash: string; name: string; mime: string }[] {
  const out: { kind: 'image' | 'file'; hash: string; name: string; mime: string }[] = []
  const seen = new Set<string>()
  getCards(doc).forEach((map) => {
    if (!(map instanceof Y.Map) || isTrashed(map)) return
    const type = map.get('type')
    if (type !== 'image' && type !== 'file') return
    const hash = map.get('blob')
    if (!isHash(hash) || seen.has(hash)) return
    seen.add(hash)
    out.push({ kind: type, hash, name: str(map.get('name'), 300), mime: str(map.get('mime'), 100) })
  })
  return out
}
