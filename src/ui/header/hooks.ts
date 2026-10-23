import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { getMeta, readMeta } from '../../model/board'
import type { BoardMeta } from '../../model/types'

/** Live board meta (title, icon, relay...). Re-renders only when meta changes. */
export function useBoardMeta(doc: Y.Doc): BoardMeta & { loaded: boolean } {
  const store = useMemo(() => {
    const read = () => ({ ...readMeta(doc), loaded: getMeta(doc).get('id') !== undefined })
    let snap = read()
    return {
      subscribe: (cb: () => void) => {
        const m = getMeta(doc)
        const h = () => {
          snap = read()
          cb()
        }
        m.observe(h)
        return () => m.unobserve(h)
      },
      get: () => snap,
    }
  }, [doc])
  return useSyncExternalStore(store.subscribe, store.get)
}

/** canUndo / canRedo of the board UndoManager. */
export function useUndoState(undo: Y.UndoManager): { canUndo: boolean; canRedo: boolean } {
  const store = useMemo(() => {
    let snap = { canUndo: undo.canUndo(), canRedo: undo.canRedo() }
    return {
      subscribe: (cb: () => void) => {
        const h = () => {
          const next = { canUndo: undo.canUndo(), canRedo: undo.canRedo() }
          if (next.canUndo !== snap.canUndo || next.canRedo !== snap.canRedo) {
            snap = next
            cb()
          }
        }
        undo.on('stack-item-added', h)
        undo.on('stack-item-popped', h)
        undo.on('stack-cleared', h)
        return () => {
          undo.off('stack-item-added', h)
          undo.off('stack-item-popped', h)
          undo.off('stack-cleared', h)
        }
      },
      get: () => snap,
    }
  }, [undo])
  return useSyncExternalStore(store.subscribe, store.get)
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
/** Label of the platform's command modifier. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'
