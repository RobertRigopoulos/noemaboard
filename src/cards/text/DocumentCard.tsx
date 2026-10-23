import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { FileText, Maximize2 } from 'lucide-react'
import type { CardProps } from '../types'
import type { DocumentCard as DocumentCardData } from '../../model/types'
import { useYVersion } from '../../board/BoardContext'
import { usePanels } from '../../board/store'
import { fragmentToText } from '../../editor/staticHtml'
import { countOverdue } from '../../editor/tasks'
import { useToday } from '../../editor/dayClock'
import { cardString, useCardFragment } from './hooks'
import { countWords, formatWordCount, previewText } from './docText'
import { DEFAULT_DOCUMENT_TITLE, DocumentEditor } from './DocumentEditor'
import { useExpandedOwner } from '../expanded'
import './text-cards.css'

/**
 * Long-form document. On the canvas it is a compact page tile; opening it (double-click, Enter or
 * the open button) shows a full-screen editor. The editor is shown while usePanels.expanded === id.
 */
export function DocumentCard({ id, card, map, editing, selected, readOnly, stopEditing }: CardProps<DocumentCardData>) {
  const fragment = useCardFragment(map, 'content', readOnly)
  const version = useYVersion(fragment)
  // Typing in the open document should not re-summarise the tile on every keystroke.
  const deferredVersion = useDeferredValue(version)
  const title = cardString(card.title, 300)
  const expanded = usePanels((s) => s.expanded === id)
  const today = useToday()

  const summary = useMemo(() => {
    const text = fragment ? fragmentToText(fragment) : ''
    // The tile shows none of the tasks inside, so it says when some are past their due date.
    return { preview: previewText(text, title), words: countWords(text), overdue: fragment ? countOverdue(fragment, today) : 0 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment, deferredVersion, title, today])

  // Entering edit mode (double-click / Enter from the shell, or created with edit: true) opens the document.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (editing && !wasEditing.current) usePanels.getState().setExpanded(id)
    wasEditing.current = editing
    return () => {
      wasEditing.current = false
    }
  }, [editing, id])

  // A document deleted (or moved away) by a teammate must not leave a stale overlay state behind,
  // but one a teammate merely drags into or out of a column stays open.
  useExpandedOwner(id)

  // The shell passes a new stopEditing on every render; keep onClose stable so the open editor is not re-rendered.
  const stopEditingRef = useRef(stopEditing)
  useLayoutEffect(() => {
    stopEditingRef.current = stopEditing
  })
  const open = () => usePanels.getState().setExpanded(id)
  const close = useCallback(() => {
    if (usePanels.getState().expanded === id) usePanels.getState().setExpanded(null)
    stopEditingRef.current()
  }, [id])

  const untitled = !title.trim() || title === DEFAULT_DOCUMENT_TITLE
  const shownTitle = title.trim() || DEFAULT_DOCUMENT_TITLE

  return (
    <>
      <div
        className={`doc-tile${selected ? ' is-selected' : ''}`}
        onDoubleClick={(e) => {
          // The shell only opens editable cards; read-only viewers can still read documents.
          if (!readOnly) return
          e.stopPropagation()
          open()
        }}
      >
        <div className="doc-tile__top">
          <span className="doc-tile__icon" aria-hidden>
            <FileText size={16} strokeWidth={1.9} />
          </span>
          <button
            type="button"
            className="doc-tile__open no-drag"
            aria-label={`Open document ${shownTitle}`}
            title="Open document"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
          >
            <Maximize2 size={13} aria-hidden />
          </button>
        </div>
        <h3 className={`doc-tile__title${untitled ? ' is-placeholder' : ''}`}>{shownTitle}</h3>
        {summary.preview ? <p className="doc-tile__preview">{summary.preview}</p> : <p className="doc-tile__preview is-empty">No content yet</p>}
        <div className="doc-tile__meta">
          <span className="doc-tile__kind">Document</span>
          {summary.overdue > 0 && (
            <span
              className="doc-tile__overdue"
              title={summary.overdue === 1 ? '1 task is past its due date' : `${summary.overdue} tasks are past their due date`}
            >
              {summary.overdue} overdue
            </span>
          )}
          {summary.words > 0 && <span className="doc-tile__words">{formatWordCount(summary.words)}</span>}
        </div>
      </div>
      {expanded &&
        fragment &&
        createPortal(
          <DocumentEditor id={id} fragment={fragment} title={title} color={card.color ?? null} readOnly={readOnly} onClose={close} />,
          document.body,
        )}
    </>
  )
}
