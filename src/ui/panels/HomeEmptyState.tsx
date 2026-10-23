/** Welcome card on an empty Home board: create a first board (blank or from a template) or join a teammate's. */
import { useEffect, useState } from 'react'
import { ImagePlus, Keyboard, LayoutGrid, LayoutTemplate, LogIn, MousePointerClick, Plus } from 'lucide-react'
import { useCardIndex, type BoardContextValue } from '../../board/BoardContext'
import { addCard } from '../../board/actions'
import { usePanels } from '../../board/store'
import { openBoard } from '../../app/router'
import { docs } from '../../collab/docs'
import { getCards } from '../../model/board'
import { APP_NAME } from '../../config'
import { useDialogs } from '../uiStore'
import { keepControlKeys } from '../keyGuard'
import './panels.css'

/** True once the board's local data has loaded, so an empty board is really empty. */
function useDocLoaded(boardId: string): boolean {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let alive = true
    setLoaded(false)
    void docs.withDoc(boardId, () => {}).then(() => {
      if (alive) setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [boardId])
  return loaded
}

export function HomeEmptyState({ ctx }: { ctx: BoardContextValue }) {
  const cards = useCardIndex()
  const presenting = usePanels((s) => s.presenting)
  const loaded = useDocLoaded(ctx.boardId)
  if (!ctx.isHome || cards.length > 0 || !loaded || presenting) return null

  const createBoard = () => {
    const id = addCard(ctx.doc, 'board', { title: 'My first board' })
    const boardId = getCards(ctx.doc).get(id)?.get('boardId')
    if (typeof boardId === 'string' && boardId) openBoard(boardId)
  }

  return (
    <div className="home-empty" onKeyDown={keepControlKeys}>
      <section className="home-empty__card" aria-labelledby="home-empty-title">
        <span className="home-empty__mark" aria-hidden>
          <LayoutGrid size={26} strokeWidth={1.6} />
        </span>
        <h1 id="home-empty-title" className="home-empty__title">
          Welcome to {APP_NAME}
        </h1>
        <p className="home-empty__pitch">Free visual boards for your team. Real-time collaboration, no accounts, no limits.</p>
        <div className="home-empty__actions">
          {!ctx.readOnly && (
            <>
              <button type="button" className="btn btn--primary home-empty__btn" onClick={createBoard}>
                <Plus size={16} strokeWidth={2} aria-hidden />
                Create a board
              </button>
              <button type="button" className="btn home-empty__btn" onClick={() => useDialogs.getState().open('templates')}>
                <LayoutTemplate size={16} strokeWidth={1.75} aria-hidden />
                Start from a template
              </button>
            </>
          )}
          <button type="button" className="btn home-empty__btn" onClick={() => useDialogs.getState().open('join')}>
            <LogIn size={16} strokeWidth={1.75} aria-hidden />
            Join a board
          </button>
        </div>
        <ul className="home-empty__tips">
          <li>
            <MousePointerClick size={15} strokeWidth={1.75} aria-hidden />
            Double-click anywhere to add a note
          </li>
          <li>
            <ImagePlus size={15} strokeWidth={1.75} aria-hidden />
            Drag images and files in from your computer
          </li>
          <li>
            <Keyboard size={15} strokeWidth={1.75} aria-hidden />
            Press <kbd>N</kbd>, <kbd>T</kbd> or <kbd>B</kbd> for a note, to-do or board
          </li>
        </ul>
      </section>
    </div>
  )
}
