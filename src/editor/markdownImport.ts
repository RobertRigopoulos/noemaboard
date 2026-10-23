/**
 * Plain text written in Markdown (pasted from a code editor, a chat or a README) as a ProseMirror
 * document of the card schema. Dependency-free and deliberately small: ATX headings (levels 4-6
 * become level 3), bullet, numbered and task lists with nesting, quotes, fenced code, rules, and
 * **bold**, *italic* / _italic_, ~~strike~~, `code` and [links](https://...). Only http(s) and
 * mailto links are kept; any other link keeps its text.
 */
import type { Node as PMNode } from '@tiptap/pm/model'
import { MAX_NOTE_CHARS } from '../cards/media/create'
import { getStaticSchema, safeCodeLanguage } from './extensions'
import { isAllowedLinkTarget, normalizeLinkInput } from './safeUrl'

interface JMark {
  type: string
  attrs?: Record<string, unknown>
}
interface JNode {
  type: string
  attrs?: Record<string, unknown>
  content?: JNode[]
  text?: string
  marks?: JMark[]
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/
const QUOTE = /^ {0,3}>[ \t]?(.*)$/
const BULLET = /^([ \t]*)([-*+])[ \t]+(.*)$/
const ORDERED = /^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$/
const TASK = /^\[([ xX])\][ \t]+(.*)$/

const FENCE_MARK = /^ {0,3}(`{3,}|~{3,})/

function isHeadingLine(line: string): boolean {
  return /^ {0,3}#{1,3}[ \t]+\S/.test(line)
}

/** List items, tasks, quotes and code fences. */
function isBlockMarkerLine(line: string): boolean {
  return BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line) || FENCE_MARK.test(line)
}

/**
 * Lines that read as program code or a shell session rather than prose. A Python or shell comment
 * ("# install") looks exactly like a heading, so text with such lines is not read as Markdown.
 */
const CODE_LINES: RegExp[] = [
  /^\s*(?:async\s+)?def\s+\w+\s*\(/,
  /^\s*class\s+\w+\s*(?:[(:{]|extends\b|implements\b)/,
  /^\s*import\s+(?:[\w.]+(?:\s*,\s*[\w.]+)*\s*;?\s*$|[\w.]+\s+as\s|[\w$]+\s+from\s|[{*"'])/,
  /^\s*from\s+[\w.]+\s+import\s/,
  /^\s*(?:export\s+)?(?:async\s+)?function\b\s*[\w$]*\s*\(/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+(?:[\w$]+|\{[^}]*\}|\[[^\]]*\])\s*(?::[^=]+)?=/,
  /^\s*(?:if|elif|else|for|while|with|try|except|finally)\b[^:]*:\s*$/,
  /^\s*(?:if|for|while|switch|catch)\s*\(/,
  /^\s*(?:fn|func)\s+[\w$]+\s*[(<]/,
  /^\s*#\s*(?:include|define|ifn?def|endif|pragma)\b/,
  /^\s*(?:sudo|npm|npx|yarn|pnpm|git|cd|mkdir|curl|wget|pip3?|docker|kubectl|brew|apt(?:-get)?|chmod|chown|echo|export)\s+\S/,
  // A shell prompt.
  /^\s*\$\s+\S/,
  // An assignment: "self.args = args", "x += 1", "KEY=value".
  /^\s*[A-Za-z_$][\w$.]*(?:\[[^\]]*\])?\s*(?:[-+*/%|&^]|\*\*|\/\/)?=(?!=)\s*\S/,
  // A call on a line of its own: "print(x)", "main();".
  /^\s*[A-Za-z_$][\w$.]*\(.*\)\s*;?\s*$/,
  // Ends like a statement or block: ";", "{", "}", "):", "=>", a line continuation.
  /(?:[;{}]|\)\s*:|=>|\\)\s*$/,
]

/** "key: value", "key:" and "- key: value" lines of YAML (keys start lowercase, unlike prose labels). */
const YAML_KEY = /^\s*(?:-\s+)?[a-z_][\w.-]*:(?:\s+\S.*)?$/

/**
 * True when text reads as code or configuration: a shebang, at least a fifth of the lines looking
 * like code, or mostly YAML keys. Fenced code blocks of a Markdown document are not looked at.
 */
function looksLikeCode(lines: readonly string[]): boolean {
  let considered = 0
  let code = 0
  let keyCandidates = 0
  let keys = 0
  let fence: string | null = null
  let first = true
  for (const line of lines) {
    if (!line.trim()) continue
    if (first) {
      first = false
      if (/^\s*#!/.test(line)) return true
    }
    const mark = FENCE_MARK.exec(line)?.[1]
    if (fence) {
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) fence = null
      continue
    }
    if (mark) {
      fence = mark
      continue
    }
    considered++
    if (CODE_LINES.some((re) => re.test(line))) code++
    if (!/^\s*#/.test(line)) {
      keyCandidates++
      if (YAML_KEY.test(line)) keys++
    }
  }
  if (!considered) return false
  if (code > 0 && code / considered >= 0.2) return true
  return keys >= 2 && keys / keyCandidates >= 0.5
}

/**
 * True when plain text looks like Markdown: two or more lines with block markers (headings up to
 * ###, list items, tasks, quotes, code fences), at least one of them not a heading or a heading
 * followed by a paragraph, and nothing that reads as code (see looksLikeCode). Two "# " lines alone
 * are as likely to be comments in a script as headings.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (typeof text !== 'string' || !text.includes('\n')) return false
  const lines = text.split(/\r\n?|\n/)
  if (looksLikeCode(lines)) return false
  let markers = 0
  let blockMarker = false
  let headingThenProse = false
  let afterHeading = false
  let fence: string | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    const mark = FENCE_MARK.exec(line)?.[1]
    if (fence) {
      // Only the fences count, not what is inside them.
      if (mark && mark[0] === fence[0] && mark.length >= fence.length) {
        fence = null
        markers++
      }
      continue
    }
    if (mark) fence = mark
    const heading = isHeadingLine(line)
    const block = !heading && isBlockMarkerLine(line)
    if (afterHeading && !heading && !block) headingThenProse = true
    afterHeading = heading
    if (heading || block) markers++
    if (block) blockMarker = true
  }
  return markers >= 2 && (blockMarker || headingThenProse)
}

// ---------------------------------------------------------------------------
// Inline

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~>|]/

function addMark(marks: JMark[], mark: JMark): JMark[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark]
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}_]/u.test(ch)
}

/** Finds the closing delimiter for emphasis starting after `from`, or -1. */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i <= s.length - delim.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > 0) i = end
      continue
    }
    if (!s.startsWith(delim, i)) continue
    // Closing: no space before it; for "_", not inside a word; a single "*" must not be part of "**".
    if (/\s/.test(s[i - 1] ?? ' ')) continue
    if (delim[0] === '_' && isWordChar(s[i + delim.length])) continue
    if (delim === '*' && s[i + 1] === '*') {
      i++
      continue
    }
    return i
  }
  return -1
}

function linkAt(s: string, i: number): { text: string; href: string; end: number } | null {
  if (s[i] !== '[') return null
  let depth = 0
  let close = -1
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') {
      j++
      continue
    }
    if (s[j] === '[') depth++
    else if (s[j] === ']' && --depth === 0) {
      close = j
      break
    }
  }
  if (close < 0 || s[close + 1] !== '(') return null
  const m = /^\(\s*<?([^\s()<>]*)>?(?:\s+["'][^"']*["'])?\s*\)/.exec(s.slice(close + 1))
  if (!m) return null
  return { text: s.slice(i + 1, close), href: m[1], end: close + 1 + m[0].length }
}

/** Inline Markdown to text nodes with marks. */
export function parseInline(s: string, marks: JMark[] = []): JNode[] {
  const out: JNode[] = []
  let buf = ''
  const flush = () => {
    if (!buf) return
    out.push(marks.length ? { type: 'text', text: buf, marks } : { type: 'text', text: buf })
    buf = ''
  }
  for (let i = 0; i < s.length; ) {
    const ch = s[i]
    if (ch === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) {
      buf += s[i + 1]
      i += 2
      continue
    }
    if (ch === '`') {
      const ticks = /^`+/.exec(s.slice(i))![0]
      const end = s.indexOf(ticks, i + ticks.length)
      if (end > i) {
        flush()
        const code = s.slice(i + ticks.length, end).replace(/^ (.+) $/, '$1')
        // Inline code excludes every other mark in this schema.
        if (code) out.push({ type: 'text', text: code, marks: [{ type: 'code' }] })
        i = end + ticks.length
        continue
      }
    }
    const link = ch === '[' ? linkAt(s, i) : null
    if (link) {
      flush()
      const href = isAllowedLinkTarget(link.href) ? normalizeLinkInput(link.href) : null
      const inner = href ? addMark(marks, { type: 'link', attrs: { href } }) : marks
      out.push(...parseInline(link.text, inner))
      i = link.end
      continue
    }
    const two = s.slice(i, i + 2)
    if (two === '**' || two === '__' || two === '~~') {
      const opensWord = two === '__' && isWordChar(s[i - 1])
      const end = !opensWord && s[i + 2] && !/\s/.test(s[i + 2]) ? findClose(s, i + 2, two) : -1
      if (end > i + 2) {
        flush()
        out.push(...parseInline(s.slice(i + 2, end), addMark(marks, { type: two === '~~' ? 'strike' : 'bold' })))
        i = end + 2
        continue
      }
    }
    if ((ch === '*' || ch === '_') && s[i + 1] !== ch) {
      const opensWord = ch === '_' && isWordChar(s[i - 1])
      const end = !opensWord && s[i + 1] && !/\s/.test(s[i + 1]) ? findClose(s, i + 1, ch) : -1
      if (end > i + 1) {
        flush()
        out.push(...parseInline(s.slice(i + 1, end), addMark(marks, { type: 'italic' })))
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flush()
  return out
}

/** Lines of a paragraph, joined with hard breaks so the text keeps its line structure. */
function inlineLines(lines: string[]): JNode[] {
  const out: JNode[] = []
  lines.forEach((line, i) => {
    if (i) out.push({ type: 'hardBreak' })
    out.push(...parseInline(line.trim()))
  })
  return out
}

function paragraph(lines: string[]): JNode {
  const content = inlineLines(lines)
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' }
}

// ---------------------------------------------------------------------------
// Blocks

interface ListLine {
  indent: number
  kind: 'bullet' | 'ordered' | 'task'
  start: number
  checked: boolean
  text: string
}

function listLine(line: string): ListLine | null {
  const width = (ws: string) => ws.replace(/\t/g, '    ').length
  const b = BULLET.exec(line)
  if (b && !RULE.test(line)) {
    const task = TASK.exec(b[3])
    if (task) return { indent: width(b[1]), kind: 'task', start: 1, checked: task[1] !== ' ', text: task[2] }
    return { indent: width(b[1]), kind: 'bullet', start: 1, checked: false, text: b[3] }
  }
  const o = ORDERED.exec(line)
  if (o) return { indent: width(o[1]), kind: 'ordered', start: Number(o[2]), checked: false, text: o[3] }
  return null
}

interface ItemDraft {
  line: ListLine
  lines: string[]
  children: ItemDraft[]
}

/** Builds nested list nodes from drafts that share an indentation level. */
function listNodes(items: ItemDraft[]): JNode[] {
  const out: JNode[] = []
  let run: ItemDraft[] = []
  const flush = () => {
    if (!run.length) return
    const kind = run[0].line.kind
    const content = run.map((it) => {
      const nested = it.children.length ? listNodes(it.children) : []
      if (kind === 'task') return { type: 'taskItem', attrs: { checked: it.line.checked }, content: [paragraph(it.lines), ...nested] }
      return { type: 'listItem', content: [paragraph(it.lines), ...nested] }
    })
    if (kind === 'task') out.push({ type: 'taskList', content })
    else if (kind === 'ordered') out.push({ type: 'orderedList', attrs: { start: run[0].line.start }, content })
    else out.push({ type: 'bulletList', content })
    run = []
  }
  for (const it of items) {
    if (run.length && run[0].line.kind !== it.line.kind) flush()
    run.push(it)
  }
  flush()
  return out
}

function parseBlocks(lines: string[]): JNode[] {
  const out: JNode[] = []
  let para: string[] = []
  const flushPara = () => {
    if (para.length) out.push(paragraph(para))
    para = []
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      flushPara()
      i++
      continue
    }
    const fence = FENCE.exec(line)
    if (fence) {
      flushPara()
      const marker = fence[1]
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`).test(lines[i])) body.push(lines[i++])
      i++
      const text = body.join('\n')
      const language = safeCodeLanguage(fence[2] || null)
      out.push({ type: 'codeBlock', attrs: { language }, ...(text ? { content: [{ type: 'text', text }] } : {}) })
      continue
    }
    if (RULE.test(line)) {
      flushPara()
      out.push({ type: 'horizontalRule' })
      i++
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      flushPara()
      const level = Math.min(3, heading[1].length)
      const content = parseInline((heading[2] ?? '').trim())
      out.push(content.length ? { type: 'heading', attrs: { level }, content } : { type: 'heading', attrs: { level } })
      i++
      continue
    }
    if (QUOTE.test(line)) {
      flushPara()
      const inner: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1])
      const blocks = parseBlocks(inner)
      out.push({ type: 'blockquote', content: blocks.length ? blocks : [{ type: 'paragraph' }] })
      continue
    }
    const first = listLine(line)
    if (first) {
      flushPara()
      // Items with their nesting, by indentation. Continuation lines join the item above.
      const roots: ItemDraft[] = []
      const stack: ItemDraft[] = []
      while (i < lines.length) {
        const l = lines[i]
        if (!l.trim()) {
          const next = lines[i + 1]
          if (next !== undefined && listLine(next)) {
            i++
            continue
          }
          break
        }
        const item = listLine(l)
        if (!item) {
          const top = stack[stack.length - 1]
          if (!top || !/^[ \t]+\S/.test(l) || FENCE.test(l) || QUOTE.test(l)) break
          top.lines.push(l.trim())
          i++
          continue
        }
        const draft: ItemDraft = { line: item, lines: [item.text], children: [] }
        while (stack.length && stack[stack.length - 1].line.indent >= item.indent) stack.pop()
        if (stack.length) stack[stack.length - 1].children.push(draft)
        else roots.push(draft)
        stack.push(draft)
        i++
      }
      out.push(...listNodes(roots))
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return out
}

/** Merges neighbouring text nodes that carry the same marks. */
function tidy(nodes: JNode[]): JNode[] {
  const out: JNode[] = []
  for (const n of nodes) {
    if (n.content) n.content = tidy(n.content)
    const prev = out[out.length - 1]
    if (prev && prev.type === 'text' && n.type === 'text' && JSON.stringify(prev.marks ?? []) === JSON.stringify(n.marks ?? [])) {
      prev.text = (prev.text ?? '') + (n.text ?? '')
    } else out.push(n)
  }
  return out
}

/** Markdown text as a document of the card schema, or null when it cannot be built or is empty. */
export function markdownToPmDoc(text: string): PMNode | null {
  if (typeof text !== 'string' || !text.trim()) return null
  try {
    const source = text.length > MAX_NOTE_CHARS ? text.slice(0, MAX_NOTE_CHARS) : text
    const blocks = tidy(parseBlocks(source.replace(/\r\n?/g, '\n').split('\n')))
    if (!blocks.length) return null
    const doc = getStaticSchema().nodeFromJSON({ type: 'doc', content: blocks })
    doc.check()
    return doc.textContent.trim() || doc.childCount > 1 ? doc : null
  } catch {
    return null
  }
}
