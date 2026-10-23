import { useEffect, useState } from 'react'
import { BoardView } from '../board/BoardView'
import { ensureHome } from '../collab/boards'
import { getLibraryEntry } from '../collab/library'
import { joinWithConfirmation } from './joinFlow'
import { decodeInvite } from '../collab/links'
import { useLibrary } from '../collab/library'
import { openBoard, useRoute } from './router'
import { canOpenBoard } from './boardAccess'
import { BoardChrome } from '../ui/BoardChrome'
import { AppOverlays } from '../ui/AppOverlays'
import { BoardUnavailable } from '../ui/panels/BoardUnavailable'
import { startSearchIndex } from '../ui/search/searchIndex'

export function App() {
  const route = useRoute()
  const [homeReady, setHomeReady] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  // Reactive: a board joined in another tab (or a key learned from a board card) opens as soon as it is known.
  const boardKnown = useLibrary((s) => route.name !== 'board' || canOpenBoard(route.boardId, s.entries))

  useEffect(() => {
    void ensureHome().then(() => {
      setHomeReady(true)
      // Keeps the local search index of every board up to date (idle-time background work).
      startSearchIndex()
    })
  }, [])

  useEffect(() => {
    if (route.name !== 'join') return
    const invite = decodeInvite(route.payload)
    if (!invite) {
      setJoinError('This invite link is not valid. Ask for a new one.')
      openBoard('home', true)
      return
    }
    void joinWithConfirmation(invite).then(
      (id) => openBoard(id, true),
      (err: unknown) => {
        setJoinError(err instanceof Error ? err.message : 'Could not join this board.')
        openBoard(getLibraryEntry(invite.b) ? invite.b : 'home', true)
      },
    )
  }, [route])

  useEffect(() => {
    if (route.name === 'board' && boardKnown) useLibrary.getState().touch(route.boardId)
  }, [route, boardKnown])

  if (!homeReady || route.name !== 'board') return <div className="app-loading" />
  return (
    <div className="app">
      {boardKnown ? (
        <BoardView key={route.boardId} boardId={route.boardId} renderChrome={(ctx) => <BoardChrome ctx={ctx} />} />
      ) : (
        // Never open (and so create) a local doc for a board this device has no key for.
        <BoardUnavailable key={route.boardId} />
      )}
      <AppOverlays joinError={joinError} onDismissJoinError={() => setJoinError(null)} />
    </div>
  )
}
