import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { Editor } from '@tiptap/core'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { createCard, getCards, getMeta, getTrash, LOCAL_ORIGIN, updateCard } from '../model/board'
import { buildExtensions } from './extensions'
import { canRedoText, canUndoText, createInertUndoManager, enableTextHistory, redoText, undoText } from './history'
import { fragmentToText } from './staticHtml'
import { toggleTaskItem } from './tasks'

const U = 'user1'

afterEach(() => vi.restoreAllMocks())

/** A board like BoardView builds it: cards + the board UndoManager (LOCAL_ORIGIN only). */
function board() {
  const doc = new Y.Doc()
  const undo = new Y.UndoManager([getCards(doc), getMeta(doc), getTrash(doc)], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 400,
  })
  const note = (text = '') => {
    const id = createCard(doc, 'note', {}, U)
    const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
    if (text) doc.transact(() => frag.insert(0, [paragraph(text)]), LOCAL_ORIGIN)
    undo.stopCapturing()
    return { id, frag }
  }
  return { doc, undo, note }
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(text)])
  return p
}

/** What the live editor writes: y-tiptap transactions carry the ySyncPluginKey origin. */
function editorWrite(doc: Y.Doc, fn: () => void, addToHistory = true) {
  doc.transact((tr) => {
    if (!addToHistory) tr.meta.set('addToHistory', false)
    fn()
  }, ySyncPluginKey)
}

/** Replaces all text of a note the way the editor does (Ctrl+A, Delete, then typing). */
function setText(doc: Y.Doc, frag: Y.XmlFragment, text: string) {
  editorWrite(doc, () => {
    frag.delete(0, frag.length)
    frag.insert(0, [paragraph(text)])
  })
}

describe('board text history', () => {
  it('lets canvas undo restore text deleted in an editor that has since closed', () => {
    const { doc, undo, note } = board()
    enableTextHistory(undo)
    const x = createCard(doc, 'note', { x: 0 }, U)
    undo.stopCapturing()
    const { frag } = note('Important text')
    // Move card X, then delete the note's text in the editor.
    updateCard(doc, x, { x: 200 }, U)
    undo.stopCapturing()
    editorWrite(doc, () => frag.delete(0, frag.length))
    expect(fragmentToText(frag)).toBe('')
    // The editor closes; Ctrl+Z on the canvas brings the text back and leaves the move alone.
    undo.undo()
    expect(fragmentToText(frag)).toBe('Important text')
    expect(getCards(doc).get(x)!.get('x')).toBe(200)
  })

  it('keeps text history across editing sessions of the same note', () => {
    const { doc, undo, note } = board()
    enableTextHistory(undo)
    const { frag } = note('v1')
    undo.stopCapturing()
    setText(doc, frag, 'v2')
    // A new editor for the same note can still undo the earlier session.
    expect(canUndoText(undo, frag)).toBe(true)
    expect(undoText(undo, frag)).toBe(true)
    expect(fragmentToText(frag)).toBe('v1')
    expect(canRedoText(undo, frag)).toBe(true)
    expect(redoText(undo, frag)).toBe(true)
    expect(fragmentToText(frag)).toBe('v2')
  })

  it('never undoes canvas actions or other notes from inside an editor', () => {
    const { doc, undo, note } = board()
    enableTextHistory(undo)
    const a = note('a1')
    const b = note('b1')
    setText(doc, a.frag, 'a2')
    undo.stopCapturing()
    const moved = createCard(doc, 'note', {}, U)
    undo.stopCapturing()
    // Newest step is a canvas action: the editor's Ctrl+Z does nothing.
    expect(canUndoText(undo, a.frag)).toBe(false)
    expect(undoText(undo, a.frag)).toBe(false)
    expect(getCards(doc).has(moved)).toBe(true)
    // Undo the canvas action from the canvas, then the text step is next.
    undo.undo()
    expect(canUndoText(undo, a.frag)).toBe(true)
    expect(canUndoText(undo, b.frag)).toBe(false)
    expect(undoText(undo, b.frag)).toBe(false)
    expect(undoText(undo, a.frag)).toBe(true)
    expect(fragmentToText(a.frag)).toBe('a1')
    expect(fragmentToText(b.frag)).toBe('b1')
  })

  it('tags checkbox toggles made without an editor', () => {
    const { doc, undo } = board()
    enableTextHistory(undo)
    const id = createCard(doc, 'todo', {}, U)
    const frag = getCards(doc).get(id)!.get('content') as Y.XmlFragment
    doc.transact(() => {
      const list = new Y.XmlElement('taskList')
      const item = new Y.XmlElement('taskItem')
      item.insert(0, [paragraph('task')])
      list.insert(0, [item])
      frag.insert(0, [list])
    }, LOCAL_ORIGIN)
    undo.stopCapturing()
    toggleTaskItem(frag, 0, { checked: true })
    expect(canUndoText(undo, frag)).toBe(true)
  })

  it('leaves edits marked addToHistory: false out of the history', () => {
    const { doc, undo, note } = board()
    enableTextHistory(undo)
    const { frag } = note()
    const before = undo.undoStack.length
    editorWrite(doc, () => frag.insert(0, [new Y.XmlElement('taskList')]), false)
    expect(undo.undoStack.length).toBe(before)
    expect(canUndoText(undo, frag)).toBe(false)
  })

  it('is idempotent and keeps tracking canvas edits', () => {
    const { doc, undo } = board()
    enableTextHistory(undo)
    enableTextHistory(undo)
    expect(undo.trackedOrigins.has(LOCAL_ORIGIN)).toBe(true)
    expect(undo.trackedOrigins.has(ySyncPluginKey)).toBe(true)
    createCard(doc, 'note', {}, U)
    expect(undo.undoStack.length).toBe(1)
  })

  it('gives y-tiptap a manager that records nothing', () => {
    const { doc, note } = board()
    const { frag } = note()
    const inert = createInertUndoManager(frag)
    setText(doc, frag, 'typed')
    expect(inert.undoStack.length).toBe(0)
    inert.destroy()
  })

  it('wires the board history into the editor before Collaboration', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { undo, note } = board()
    const { frag } = note()
    const editor = new Editor({
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
      extensions: buildExtensions({ variant: 'note', fragment: frag, undoManager: undo }),
    })
    const names = editor.extensionManager.extensions.map((e) => e.name)
    expect(names.indexOf('boardTextHistory')).toBeGreaterThanOrEqual(0)
    // Its keyboard shortcuts must run before Collaboration's own (per-editor) undo commands.
    expect(names.indexOf('boardTextHistory')).toBeLessThan(names.indexOf('collaboration'))
    expect(new Set(names).size).toBe(names.length)
    expect(editor.extensionManager.plugins.length).toBeGreaterThan(0)
    expect(warn).not.toHaveBeenCalled()
    editor.destroy()
  })
})
