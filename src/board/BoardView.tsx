/**
 * Opens a board doc, wires presence + undo, and renders the canvas with the board chrome.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as Y from 'yjs'
import { docs } from '../collab/docs'
import { acquireAwareness, setLocalPresence } from '../collab/presence'
import { getUser, useIdentity } from '../collab/identity'
import type { Awareness } from 'y-protocols/awareness'
import type { UserProfile } from '../model/types'
import { getCards, getMeta, getTrash, LOCAL_ORIGIN, watchMovedCards } from '../model/board'
import { BoardContext, type BoardContextValue } from './BoardContext'
import { CardIndex } from './cardIndex'
import { Canvas } from './Canvas'
import { useSelection, useView, hasSavedViewport, useDrag, usePanels } from './store'
import { useBoardShortcuts } from './shortcuts'
import { clearLayoutCaches } from './geometry'
import { clearActiveUndo, setActiveUndo, zoomToFit } from './actions'
import { attachMoveUndo } from './moveUndo'
import { purgeExpiredTrashLocally } from './trashClock'
import { HOME_BOARD_ID } from '../config'
import { upsertMember } from '../model/members'

interface Props {
  boardId: string
  /** Chrome rendered around/over the canvas (header, toolbar, panels) by the app layer. */
  renderChrome?: (ctx: BoardContextValue) => ReactNode
  readOnly?: boolean
}

export function BoardView({ boardId, renderChrome, readOnly = false }: Props) {
  const [state, setState] = useState<{ doc: Y.Doc; ready: boolean } | null>(null)

  useEffect(() => {
    const h = docs.open(boardId)
    let cancelled = false
    setState({ doc: h.doc, ready: false })
    h.ready.then(() => {
      if (!cancelled) setState({ doc: h.doc, ready: true })
    })
    useSelection.getState().clear()
    useSelection.getState().setTool('select')
    useDrag.getState().setDrag(null)
    usePanels.getState().setExpanded(null)
    useView.getState().resetFor(boardId)
    clearLayoutCaches()
    return () => {
      cancelled = true
      h.release()
    }
  }, [boardId])

  if (!state || state.doc.guid !== boardId) return <div className="board-loading" />
  return (
    <BoardInner key={boardId} boardId={boardId} doc={state.doc} ready={state.ready} renderChrome={renderChrome} readOnly={readOnly} />
  )
}

function BoardInner({
  boardId,
  doc,
  ready,
  renderChrome,
  readOnly,
}: {
  boardId: string
  doc: Y.Doc
  ready: boolean
  renderChrome?: (ctx: BoardContextValue) => ReactNode
  readOnly: boolean
}) {
  const user = useIdentity((s) => s.user)
  // Created in an effect (not useMemo) so React StrictMode's mount/unmount/mount cycle stays correct.
  const [parts, setParts] = useState<{ awareness: Awareness; index: CardIndex; undo: Y.UndoManager } | null>(null)
  useEffect(() => {
    const aw = acquireAwareness(boardId, doc)
    const index = new CardIndex(doc)
    const undo = new Y.UndoManager([getCards(doc), getMeta(doc), getTrash(doc)], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 400,
    })
    const detachMoveUndo = attachMoveUndo(doc, undo)
    setParts({ awareness: aw.awareness, index, undo })
    return () => {
      detachMoveUndo()
      undo.destroy()
      index.destroy()
      aw.release()
    }
  }, [boardId, doc])
  if (!parts) return null
  return <BoardReady boardId={boardId} doc={doc} ready={ready} renderChrome={renderChrome} readOnly={readOnly} user={user} {...parts} />
}

function BoardReady({
  boardId,
  doc,
  ready,
  renderChrome,
  readOnly,
  user,
  awareness,
  index,
  undo,
}: {
  boardId: string
  doc: Y.Doc
  ready: boolean
  renderChrome?: (ctx: BoardContextValue) => ReactNode
  readOnly: boolean
  user: UserProfile
  awareness: Awareness
  index: CardIndex
  undo: Y.UndoManager
}) {
  // Publish who we are on this board.
  useEffect(() => {
    setLocalPresence(awareness, { user, pointer: null, selection: [], editing: null, drag: null })
  }, [awareness, user])

  // Mirror selection/editing into presence.
  useEffect(
    () =>
      useSelection.subscribe((s, prev) => {
        if (s.selected !== prev.selected || s.editing !== prev.editing) {
          setLocalPresence(awareness, { selection: Array.from(s.selected), editing: s.editing })
        }
      }),
    [awareness],
  )

  // Edits that reach cards after they were moved to another board come back as trash entries,
  // then trash older than the retention period is dropped (idempotent on every peer).
  useEffect(() => {
    if (!ready || readOnly) return
    const unwatch = watchMovedCards(doc)
    purgeExpiredTrashLocally(doc, boardId)
    return unwatch
  }, [ready, readOnly, doc, boardId])

  // Board actions that only get the doc (Mod+Enter from an editor) end undo groups through this.
  useEffect(() => {
    setActiveUndo(undo)
    return () => clearActiveUndo(undo)
  }, [undo])

  // Member roster: everyone who opened the board, refreshed when the local name or colour changes.
  const isHome = boardId === HOME_BOARD_ID
  useEffect(() => {
    if (!ready || readOnly || isHome) return
    upsertMember(doc, getUser())
  }, [ready, readOnly, isHome, doc, user.name, user.color])

  // First visit to a board with content: fit it in view.
  useEffect(() => {
    if (!ready || hasSavedViewport(boardId)) return
    if (getCards(doc).size > 0) requestAnimationFrame(() => zoomToFit(doc))
  }, [ready, boardId, doc])

  const ctx = useMemo<BoardContextValue>(
    () => ({ boardId, doc, cards: getCards(doc), index, awareness, undo, readOnly, isHome }),
    [boardId, doc, index, awareness, undo, readOnly, isHome],
  )

  useBoardShortcuts(ctx)

  return (
    <BoardContext.Provider value={ctx}>
      <div className="board-view">
        <Canvas />
        {renderChrome?.(ctx)}
      </div>
    </BoardContext.Provider>
  )
}
