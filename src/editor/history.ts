/**
 * Rich-text undo through the board's UndoManager.
 *
 * y-tiptap writes editor changes with the `ySyncPluginKey` origin and, by default, records them in
 * an UndoManager that lives and dies with one editor instance. Only the card being edited mounts an
 * editor, so leaving a note threw its text history away, and canvas Ctrl+Z skipped the text edit and
 * reverted an unrelated canvas action instead.
 *
 * Instead, text edits are recorded by the board UndoManager (one linear history per open board, like
 * the canvas). Canvas Ctrl+Z / the Undo button undo a text edit after the editor has closed, and
 * reopening a note continues its history. Inside an editor, Ctrl+Z only undoes while the newest step
 * belongs to that editor's text, so it never reverts canvas actions behind the person's back.
 */
import * as Y from 'yjs'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey, yUndoPluginKey } from '@tiptap/y-tiptap'

/** stackItem.meta key: the rich-text fragments a step changed. */
const TEXT_FRAGMENTS = { key: 'noema:text-fragments' }

interface StackItemLike {
  meta: Map<unknown, unknown>
}
interface StackItemEvent {
  stackItem: StackItemLike
  changedParentTypes?: Map<Y.AbstractType<any>, unknown>
}

const enabled = new WeakSet<Y.UndoManager>()

/**
 * Lets a board UndoManager record rich-text edits made in live editors. Idempotent; safe to call for
 * every rendered text card. Edits the editor marks `addToHistory: false` (e.g. turning an empty to-do
 * into a task list) stay out of the history, like they did in the editor's own history.
 */
export function enableTextHistory(undo: Y.UndoManager): void {
  if (enabled.has(undo)) return
  enabled.add(undo)
  undo.addTrackedOrigin(ySyncPluginKey)
  const capture = undo.captureTransaction
  undo.captureTransaction = (tr: Y.Transaction) => {
    if (tr.meta.get('addToHistory') !== false) return capture(tr)
    // Like y-tiptap: what follows such an edit starts a new step instead of merging across it.
    undo.stopCapturing()
    return false
  }
  const tag = (event: StackItemEvent) => {
    const changed = event.changedParentTypes
    if (!changed) return
    let set = event.stackItem.meta.get(TEXT_FRAGMENTS) as Set<Y.XmlFragment> | undefined
    for (const type of changed.keys()) {
      // Card text lives in an XmlFragment; XmlElement extends XmlFragment, so exclude it explicitly.
      if (!(type instanceof Y.XmlFragment) || type instanceof Y.XmlElement) continue
      if (!set) {
        set = new Set()
        event.stackItem.meta.set(TEXT_FRAGMENTS, set)
      }
      set.add(type)
    }
  }
  undo.on('stack-item-added', tag)
  undo.on('stack-item-updated', tag)
}

function topTouches(stack: StackItemLike[], fragment: Y.XmlFragment): boolean {
  const top = stack[stack.length - 1]
  const set = top?.meta.get(TEXT_FRAGMENTS) as Set<Y.XmlFragment> | undefined
  return !!set && set.has(fragment)
}

/** True when the newest undo step changed this fragment's text. */
export function canUndoText(undo: Y.UndoManager, fragment: Y.XmlFragment): boolean {
  return topTouches(undo.undoStack, fragment)
}

/** True when the newest redo step changed this fragment's text. */
export function canRedoText(undo: Y.UndoManager, fragment: Y.XmlFragment): boolean {
  return topTouches(undo.redoStack, fragment)
}

/** Undoes the newest step if it belongs to this fragment. Returns whether anything was undone. */
export function undoText(undo: Y.UndoManager, fragment: Y.XmlFragment): boolean {
  if (!canUndoText(undo, fragment)) return false
  return undo.undo() !== null
}

/** Redoes the newest undone step if it belongs to this fragment. */
export function redoText(undo: Y.UndoManager, fragment: Y.XmlFragment): boolean {
  if (!canRedoText(undo, fragment)) return false
  return undo.redo() !== null
}

/**
 * An UndoManager that never records anything. Handed to y-tiptap so the editor does not keep a
 * second, per-editor history next to the board's (which could undo the same edit twice).
 */
export function createInertUndoManager(fragment: Y.XmlFragment): Y.UndoManager {
  return new Y.UndoManager(fragment, { trackedOrigins: new Set(), captureTransaction: () => false })
}

export interface BoardTextHistoryOptions {
  undoManager: Y.UndoManager | null
  fragment: Y.XmlFragment | null
}

/**
 * Editor side of the shared history: Mod-z / Mod-y / Shift-Mod-z (and the browser's own undo
 * commands) go to the board UndoManager, editing sessions start and end as separate undo steps, and
 * the caret is restored the way y-tiptap restores it for its own history.
 * Runs before Collaboration (priority 1000) so its per-editor undo commands are never reached.
 */
export const BoardTextHistory = Extension.create<BoardTextHistoryOptions>({
  name: 'boardTextHistory',
  priority: 1001,

  addOptions() {
    return { undoManager: null, fragment: null }
  },

  addKeyboardShortcuts() {
    const run = (direction: 'undo' | 'redo') => () => {
      const { undoManager, fragment } = this.options
      if (!undoManager || !fragment) return false
      if (this.editor.isEditable && !blocked(this.editor.view)) {
        if (direction === 'undo') undoText(undoManager, fragment)
        else redoText(undoManager, fragment)
      }
      // Always handled: neither the browser's contenteditable undo nor another history may run.
      return true
    }
    return {
      'Mod-z': run('undo'),
      'Mod-y': run('redo'),
      'Shift-Mod-z': run('redo'),
    }
  },

  addProseMirrorPlugins() {
    const { undoManager, fragment } = this.options
    if (!undoManager || !fragment) return []
    const editor = this.editor
    return [
      new Plugin({
        key: new PluginKey('boardTextHistory'),
        // Typing right after an autoformat (e.g. "- " -> bullet) is a separate step, so Ctrl+Z
        // reverts the autoformat first, as in y-tiptap.
        filterTransaction: (tr) => {
          if (tr.getMeta('inputRule')) undoManager.stopCapturing()
          return true
        },
        props: {
          handleDOMEvents: {
            // Edit menu "Undo" / "Redo" (and other platform gestures) arrive as beforeinput.
            beforeinput: (view, event) => {
              const type = (event as InputEvent).inputType
              if (type !== 'historyUndo' && type !== 'historyRedo') return false
              event.preventDefault()
              if (editor.isEditable && !blocked(view)) {
                if (type === 'historyUndo') undoText(undoManager, fragment)
                else redoText(undoManager, fragment)
              }
              return true
            },
          },
        },
        view: (view) => {
          // The editing session neither merges with the canvas action before it nor with what follows.
          undoManager.stopCapturing()
          const binding = () => ySyncPluginKey.getState(view.state)?.binding ?? null
          const onAdded = ({ stackItem }: StackItemEvent) => {
            const b = binding()
            if (b) stackItem.meta.set(b, yUndoPluginKey.getState(view.state)?.prevSel ?? null)
          }
          const onPopped = ({ stackItem }: StackItemEvent) => {
            const b = binding()
            const saved = b ? stackItem.meta.get(b) : null
            if (b && saved) b.beforeTransactionSelection = saved as typeof b.beforeTransactionSelection
          }
          undoManager.on('stack-item-added', onAdded)
          undoManager.on('stack-item-popped', onPopped)
          return {
            destroy: () => {
              undoManager.off('stack-item-added', onAdded)
              undoManager.off('stack-item-popped', onPopped)
              undoManager.stopCapturing()
            },
          }
        },
      }),
    ]
  },
})

/** Content the editor cannot represent (or a snapshot view) must not be changed by undo. */
function blocked(view: EditorView): boolean {
  const sync = ySyncPluginKey.getState(view.state)
  return !sync || sync.binding?.projectionError != null || sync.snapshot != null || sync.prevSnapshot != null
}
