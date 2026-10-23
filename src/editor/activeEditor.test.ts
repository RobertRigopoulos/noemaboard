import { afterEach, describe, expect, it } from 'vitest'
import type { Editor } from '@tiptap/core'
import { registerEditorEscape, runEditorEscape, useActiveEditor } from './activeEditor'

describe('editor Escape closers', () => {
  it('runs the newest closer once, then falls through', () => {
    const calls: string[] = []
    const offA = registerEditorEscape(() => calls.push('a'))
    registerEditorEscape(() => calls.push('b'))
    expect(runEditorEscape()).toBe(true)
    expect(calls).toEqual(['b'])
    offA()
    expect(runEditorEscape()).toBe(false)
    expect(calls).toEqual(['b'])
  })

  it('unregistering twice or after running is harmless', () => {
    const off = registerEditorEscape(() => {})
    expect(runEditorEscape()).toBe(true)
    off()
    off()
    expect(runEditorEscape()).toBe(false)
  })
})

const fake = (name: string) => ({ name }) as unknown as Editor

afterEach(() => useActiveEditor.setState({ editor: null, variant: null, cardId: null }))

describe('active editor store', () => {
  it('stores the editor with its variant and card', () => {
    const a = fake('a')
    useActiveEditor.getState().set(a, 'note', 'card1')
    expect(useActiveEditor.getState()).toMatchObject({ editor: a, variant: 'note', cardId: 'card1' })
    useActiveEditor.getState().clear(a)
    expect(useActiveEditor.getState()).toMatchObject({ editor: null, variant: null, cardId: null })
  })

  it('keeps the newer editor when an older one is cleared late (StrictMode, quick switches)', () => {
    const older = fake('older')
    const newer = fake('newer')
    useActiveEditor.getState().set(older, 'note', 'n1')
    useActiveEditor.getState().set(newer, 'todo', 't1')
    useActiveEditor.getState().clear(older)
    expect(useActiveEditor.getState()).toMatchObject({ editor: newer, variant: 'todo', cardId: 't1' })
    useActiveEditor.getState().clear(newer)
    expect(useActiveEditor.getState().editor).toBeNull()
  })

  it('does not notify subscribers when the same editor registers again', () => {
    const a = fake('a')
    useActiveEditor.getState().set(a, 'caption', null)
    let calls = 0
    const off = useActiveEditor.subscribe(() => calls++)
    useActiveEditor.getState().set(a, 'caption', null)
    off()
    expect(calls).toBe(0)
  })
})
