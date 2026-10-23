/** React bindings for the board trash (soft-deleted cards grouped into entries). */
import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'
import { getCards } from '../../model/board'
import { affectsTrash, countTrashEntries, summarizeTrash, type TrashSummary } from './trashSummary'

/** Bumps whenever something that the trash shows may have changed (ignores ordinary card edits). */
export function useTrashVersion(doc: Y.Doc): number {
  const store = useMemo(() => {
    let version = 0
    const cards = getCards(doc)
    return {
      subscribe: (cb: () => void) => {
        const h = (events: Y.YEvent<any>[]) => {
          if (!affectsTrash(events, cards)) return
          version++
          cb()
        }
        cards.observeDeep(h)
        return () => cards.unobserveDeep(h)
      },
      get: () => version,
    }
  }, [doc])
  return useSyncExternalStore(store.subscribe, store.get)
}

export function useTrashCount(doc: Y.Doc): number {
  const v = useTrashVersion(doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => countTrashEntries(doc), [doc, v])
}

export function useTrashSummaries(doc: Y.Doc): TrashSummary[] {
  const v = useTrashVersion(doc)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => summarizeTrash(doc), [doc, v])
}
