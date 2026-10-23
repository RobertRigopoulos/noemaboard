import { useCallback, useLayoutEffect, useRef } from 'react'
import type { CardProps } from '../types'
import type { NoteCard as NoteCardData } from '../../model/types'
import { useBoard } from '../../board/BoardContext'
import { addCardBelow } from '../../board/actions'
import { RichText } from '../../editor/RichText'
import { isFragmentEmpty } from '../../editor/staticHtml'
import { importBelowCard } from '../media/importBelow'
import { useCardFragment } from './hooks'
import { useDiscardIfLeftEmpty } from './discardEmpty'
// Registers the text cards' actions (convert, completed tasks) with the menus.
import './actions'
import './text-cards.css'

/** Free-form rich-text note. Grows with its content; width is set by the shell. */
export function NoteCard({ id, card, map, editing, readOnly, stopEditing }: CardProps<NoteCardData>) {
  const { doc } = useBoard()
  const fragment = useCardFragment(map, 'content', readOnly)
  // A note made by a stray double-click and left without text goes away again.
  useDiscardIfLeftEmpty(id, card, editing, readOnly, () => !fragment || isFragmentEmpty(fragment))
  const stopEditingRef = useRef(stopEditing)
  useLayoutEffect(() => {
    stopEditingRef.current = stopEditing
  })
  // Mod+Enter: done with this note, start the next one below it.
  const createNext = useCallback(() => {
    stopEditingRef.current()
    addCardBelow(doc, id)
    return true
  }, [doc, id])
  const pasteFiles = useCallback((files: File[]) => void importBelowCard(doc, id, files), [doc, id])
  return (
    <div className="text-card note-card">
      {fragment ? (
        <RichText
          fragment={fragment}
          editing={editing && !readOnly}
          variant="note"
          placeholder="Type something…"
          readOnly={readOnly}
          onExit={stopEditing}
          cardId={id}
          onPasteFiles={pasteFiles}
          onCreateNext={createNext}
          emptyText="Empty note"
        />
      ) : (
        <div className="rich-text">
          <div className="rich-text__content rich-text__empty">
            <p>Empty note</p>
          </div>
        </div>
      )}
    </div>
  )
}
