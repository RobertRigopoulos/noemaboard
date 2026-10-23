import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { Editor } from '@tiptap/core'
import { buildExtensions, getStaticSchema, safeCodeLanguage } from './extensions'

// JSON content: the default (an HTML string) needs a DOM, which tests do not have.
const EMPTY = { type: 'doc', content: [{ type: 'paragraph' }] }

afterEach(() => vi.restoreAllMocks())

describe('editor extensions', () => {
  it('static schema has every block and mark the format menu offers', () => {
    const schema = getStaticSchema()
    for (const node of ['paragraph', 'heading', 'codeBlock', 'blockquote', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'horizontalRule', 'hardBreak']) {
      expect(schema.nodes[node], node).toBeDefined()
    }
    for (const mark of ['bold', 'italic', 'underline', 'strike', 'code', 'highlight', 'textStyle', 'link']) {
      expect(schema.marks[mark], mark).toBeDefined()
    }
    expect(schema.marks.link.spec.attrs).toHaveProperty('href')
    // rel/target/class are never stored, so peers cannot inject them.
    expect(schema.marks.link.spec.attrs).not.toHaveProperty('class')
    expect(schema.nodes.heading.spec.attrs).toHaveProperty('textAlign')
  })

  it('builds a collaborative editor without duplicate or conflicting extensions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const doc = new Y.Doc()
    const card = new Y.Map<unknown>()
    doc.getMap('cards').set('n1', card)
    const fragment = new Y.XmlFragment()
    card.set('content', fragment)
    const awareness = new Awareness(doc)
    const editor = new Editor({ content: EMPTY, extensions: buildExtensions({ variant: 'note', fragment, awareness, user: { name: 'Ada', color: '#30a46c' } }) })
    const names = editor.extensionManager.extensions.map((e) => e.name)
    expect(names).toContain('collaboration')
    expect(names).toContain('remoteCarets')
    expect(names).not.toContain('undoRedo')
    expect(names).not.toContain('trailingNode')
    expect(new Set(names).size).toBe(names.length)
    // Plugins are normally built when the view mounts; build them here (no DOM in tests).
    expect(editor.extensionManager.plugins.length).toBeGreaterThan(0)
    expect(warn).not.toHaveBeenCalled()
    // The awareness user is only filled in when presence has not set one.
    expect((awareness.getLocalState() as { user?: { name: string } }).user?.name).toBe('Ada')
    editor.destroy()
    awareness.destroy()
  })

  it('renders a code block language as one safe class, live and when copied', () => {
    expect(safeCodeLanguage('typescript')).toBe('typescript')
    expect(safeCodeLanguage('c++')).toBe('c++')
    expect(safeCodeLanguage('x world no-drag')).toBeNull()
    expect(safeCodeLanguage('a'.repeat(33))).toBeNull()
    expect(safeCodeLanguage(42)).toBeNull()
    const schema = getStaticSchema()
    const toDOM = schema.nodes.codeBlock.spec.toDOM!
    const evil = schema.nodes.codeBlock.create({ language: 'x world no-drag' })
    expect(JSON.stringify(toDOM(evil))).not.toMatch(/world|no-drag/)
    const ok = schema.nodes.codeBlock.create({ language: 'ts' })
    expect(JSON.stringify(toDOM(ok))).toContain('language-ts')
  })

  it('does not overwrite a user already published by board presence', () => {
    const doc = new Y.Doc()
    const fragment = doc.getXmlFragment('f')
    const awareness = new Awareness(doc)
    awareness.setLocalStateField('user', { id: 'u1', name: 'Grace', color: '#0090ff' })
    const editor = new Editor({ content: EMPTY, extensions: buildExtensions({ variant: 'document', fragment, awareness, user: { name: 'Other', color: '#000000' } }) })
    expect(editor.extensionManager.plugins.length).toBeGreaterThan(0)
    expect(awareness.getLocalState()?.user).toEqual({ id: 'u1', name: 'Grace', color: '#0090ff' })
    editor.destroy()
    awareness.destroy()
  })
})
