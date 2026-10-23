import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { Editor } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment } from '@tiptap/y-tiptap'
import { buildExtensions, getStaticSchema } from './extensions'
import { cleanMentionId, cleanMentionLabel, matchMentionTrigger, MENTION_TRIGGER, nameMatches } from './mentionAttrs'
import { activeMention, dismissMention, mentionSuggestKey } from './mention'
import { fragmentToHtml, fragmentToText, isFragmentProjectable } from './staticHtml'
import { mentionItems } from './MentionList'

describe('mention trigger', () => {
  it('matches "@query" at the start or after whitespace', () => {
    expect(matchMentionTrigger('@')).toEqual({ query: '', length: 1 })
    expect(matchMentionTrigger('@ad')).toEqual({ query: 'ad', length: 3 })
    expect(matchMentionTrigger('hello @gr')).toEqual({ query: 'gr', length: 3 })
    expect(matchMentionTrigger('line\n@x')).toEqual({ query: 'x', length: 2 })
    expect(matchMentionTrigger('tab\t@Zoë')).toEqual({ query: 'Zoë', length: 4 })
  })

  it('ignores email addresses, spaces after the query and long runs', () => {
    expect(matchMentionTrigger('ada@example')).toBeNull()
    expect(matchMentionTrigger('mail me at ada@ex')).toBeNull()
    expect(matchMentionTrigger('@ada ')).toBeNull()
    expect(matchMentionTrigger('@@ada')).toBeNull()
    expect(matchMentionTrigger(`@${'a'.repeat(31)}`)).toBeNull()
    expect(matchMentionTrigger('no at sign')).toBeNull()
    expect(MENTION_TRIGGER.test('(@ada')).toBe(false)
  })

  it('prefix-matches any word of a name, ignoring case and accents', () => {
    expect(nameMatches('Ada Lovelace', 'love')).toBe(true)
    expect(nameMatches('Ada Lovelace', 'ADA')).toBe(true)
    expect(nameMatches('Zoë Smith-Jones', 'zoe')).toBe(true)
    expect(nameMatches('Zoë Smith-Jones', 'jon')).toBe(true)
    expect(nameMatches('Ada Lovelace', 'velace')).toBe(false)
    expect(nameMatches('anyone', '')).toBe(true)
  })

  it('lists at most 8 people, the current user last', () => {
    const people = Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, color: '#000000', seenAt: 0 }))
    const items = mentionItems(people, 'per', 'u0')
    expect(items).toHaveLength(8)
    expect(items[0].id).toBe('u1')
    const few = mentionItems(people.slice(0, 3), '', 'u0')
    expect(few.map((p) => p.id)).toEqual(['u1', 'u2', 'u0'])
  })
})

describe('mention attributes', () => {
  it('accepts member ids only', () => {
    expect(cleanMentionId('abc_DEF-1')).toBe('abc_DEF-1')
    expect(cleanMentionId('a'.repeat(65))).toBeNull()
    expect(cleanMentionId('x" onclick="y')).toBeNull()
    expect(cleanMentionId('')).toBeNull()
    expect(cleanMentionId(42)).toBeNull()
  })

  it('strips control and direction characters from labels and caps them at 60', () => {
    const rlo = String.fromCharCode(0x202e)
    const zw = String.fromCharCode(0x200b)
    expect(cleanMentionLabel(`Ada${rlo}ecalevol${zw}\n`)).toBe('Adaecalevol')
    expect(cleanMentionLabel('x'.repeat(100))).toHaveLength(60)
    expect(cleanMentionLabel(null)).toBe('')
  })
})

function fragmentWith(content: unknown[]): Y.XmlFragment {
  const doc = new Y.Doc()
  const card = new Y.Map<unknown>()
  doc.getMap('cards').set('c', card)
  const frag = new Y.XmlFragment()
  card.set('content', frag)
  prosemirrorJSONToYXmlFragment(getStaticSchema(), { type: 'doc', content }, frag)
  return frag
}

describe('static mention rendering', () => {
  it('renders a mention chip and plain text', () => {
    const frag = fragmentWith([
      { type: 'paragraph', content: [{ type: 'text', text: 'Hi ' }, { type: 'mention', attrs: { id: 'ada', label: 'Ada' } }, { type: 'text', text: '!' }] },
    ])
    expect(fragmentToHtml(frag)).toBe('<p>Hi <span data-type="mention" class="mention" data-id="ada">@Ada</span>!</p>')
    expect(fragmentToText(frag)).toBe('Hi @Ada!')
    expect(isFragmentProjectable(frag)).toBe(true)
  })

  it('neutralises a hostile id and label written directly by a peer', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('f')
    const para = new Y.XmlElement('paragraph')
    const mention = new Y.XmlElement('mention')
    mention.setAttribute('id', '"><img src=x onerror=alert(1)>')
    mention.setAttribute('label', '<script>alert(1)</script>' + 'x'.repeat(100))
    para.insert(0, [mention])
    frag.insert(0, [para])
    const html = fragmentToHtml(frag)
    expect(html).not.toMatch(/<img|<script|onerror=/)
    expect(html).not.toContain('data-id')
    expect(html).toContain('@&lt;script&gt;alert(1)&lt;/script&gt;')
    // Label capped at 60 characters.
    expect(html).not.toContain('x'.repeat(40))
    expect(fragmentToText(frag).length).toBeLessThanOrEqual(61)
  })

  it('keeps mentions read-only for versions that do not know them (unknown node)', () => {
    const doc = new Y.Doc()
    const frag = doc.getXmlFragment('f')
    const para = new Y.XmlElement('paragraph')
    const future = new Y.XmlElement('mentionV2')
    para.insert(0, [future])
    frag.insert(0, [para])
    expect(isFragmentProjectable(frag)).toBe(false)
  })
})

describe('mention suggestion plugin', () => {
  // A headless editor builds the plugins; the state is driven by hand (no DOM in tests).
  const host = new Editor({ content: { type: 'doc', content: [{ type: 'paragraph' }] }, extensions: buildExtensions({ variant: 'note' }) })
  const plugins = host.extensionManager.plugins

  function viewWith(block: unknown) {
    const doc = host.schema.nodeFromJSON({ type: 'doc', content: [block] })
    let state = EditorState.create({ doc, plugins })
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, doc.content.size - 1)))
    const view = {
      get state() {
        return state
      },
      dispatch(tr: Transaction) {
        state = state.apply(tr)
      },
      type(text: string) {
        this.dispatch(state.tr.insertText(text))
      },
    }
    return view
  }
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })

  it('tracks the query before the caret', () => {
    const view = viewWith(para('Hello @ad'))
    expect(activeMention(view.state)).toMatchObject({ query: 'ad', from: 7, to: 10 })
    view.type('a')
    expect(activeMention(view.state)).toMatchObject({ query: 'ada' })
    view.type(' ')
    expect(activeMention(view.state)).toBeNull()
  })

  it('opens at the start of a soft line (after Shift+Enter) but not right after a mention', () => {
    const afterBreak = viewWith({ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }, { type: 'hardBreak' }, { type: 'text', text: '@gr' }] })
    expect(activeMention(afterBreak.state)).toMatchObject({ query: 'gr' })
    const afterMention = viewWith({
      type: 'paragraph',
      content: [{ type: 'mention', attrs: { id: 'u1', label: 'Ada' } }, { type: 'text', text: '@gr' }],
    })
    expect(activeMention(afterMention.state)).toBeNull()
  })

  it('does not trigger inside email addresses or code', () => {
    expect(activeMention(viewWith(para('ada@exa')).state)).toBeNull()
    expect(activeMention(viewWith({ type: 'codeBlock', content: [{ type: 'text', text: 'x @a' }] }).state)).toBeNull()
    expect(activeMention(viewWith({ type: 'paragraph', content: [{ type: 'text', text: 'x @a', marks: [{ type: 'code' }] }] }).state)).toBeNull()
  })

  it('stays closed after Escape until the @ changes', () => {
    const view = viewWith(para('Hi @a'))
    expect(activeMention(view.state)).not.toBeNull()
    dismissMention(view as unknown as EditorView)
    expect(activeMention(view.state)).toBeNull()
    // Position of the "@" (the paragraph's text starts at 1).
    expect(mentionSuggestKey.getState(view.state)?.dismissed).toBe(4)
    view.type('d')
    expect(activeMention(view.state)).toBeNull()
    view.type(' @')
    expect(activeMention(view.state)).toMatchObject({ query: '' })
  })
})
