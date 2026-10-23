/**
 * Full-screen editor for a document card (rendered into document.body by DocumentCard).
 * Modal: keyboard, clipboard and pointer events never reach the board underneath.
 */
import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type SyntheticEvent } from 'react'
import type * as Y from 'yjs'
import type { Editor } from '@tiptap/react'
import { FileText, X } from 'lucide-react'
import type { CardColor } from '../../model/types'
import { useBoard, usePeers, useYVersion } from '../../board/BoardContext'
import { updateCard } from '../../model/board'
import { getUser, initials } from '../../collab/identity'
import { RichText } from '../../editor/RichText'
import { TextToolbar } from '../../editor/TextToolbar'
import { fragmentToText, isFragmentEmpty } from '../../editor/staticHtml'
import { refuseStrayDrop } from '../media/dropGuard'
import { importBelowCard } from '../media/importBelow'
import { useDraftField } from './hooks'
import { countWords, formatWordCount } from './docText'

interface Props {
  id: string
  fragment: Y.XmlFragment
  title: string
  color: CardColor | null
  readOnly: boolean
  onClose: () => void
}

export const DEFAULT_DOCUMENT_TITLE = 'Untitled document'
const HEX = /^#[0-9a-fA-F]{6}$/

const stop = (e: SyntheticEvent) => e.stopPropagation()

export const DocumentEditor = memo(function DocumentEditor({ id, fragment, title, color, readOnly, onClose }: Props) {
  const { doc } = useBoard()
  const editorRef = useRef<Editor | null>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const titleField = useDraftField(title, (next) => updateCard(doc, id, { title: next }, getUser().id), 300)

  // A fresh document starts in its title; anything else continues where the text ends.
  const startInTitle = useMemo(
    () => !readOnly && (title.trim() === '' || title === DEFAULT_DOCUMENT_TITLE) && isFragmentEmpty(fragment),
    // Decided once, when the document opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => {
    if (!startInTitle) return
    const t = titleRef.current
    if (!t) return
    t.focus({ preventScroll: true })
    t.select()
  }, [startInTitle])

  // Grow the title field with its content.
  useLayoutEffect(() => {
    const t = titleRef.current
    if (!t) return
    t.style.height = '0px'
    t.style.height = `${t.scrollHeight}px`
  }, [titleField.value])

  // Nothing inside can hold focus in a read-only document; focus the dialog so Escape still works.
  useEffect(() => {
    if (readOnly) rootRef.current?.focus({ preventScroll: true })
  }, [readOnly])

  const onKeyDown = (e: KeyboardEvent) => {
    // Escape that cancels an input-method (IME) conversion must not close the document.
    if (e.key === 'Escape' && !e.defaultPrevented && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onClose()
    }
    // Board shortcuts (delete, nudge, quick-add...) must not act on the canvas behind the document.
    e.stopPropagation()
  }

  const onEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor
  }, [])
  // Pasted screenshots and files become cards below the document's tile on the board.
  const pasteFiles = useCallback((files: File[]) => void importBelowCard(doc, id, files), [doc, id])

  const shownTitle = title.trim() || DEFAULT_DOCUMENT_TITLE

  return (
    <div
      ref={rootRef}
      className="doc-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={shownTitle}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={stop}
      onMouseDown={stop}
      onClick={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
      onWheel={stop}
      onCopy={stop}
      onCut={stop}
      onPaste={stop}
      onDragEnter={refuseStrayDrop}
      onDragOver={refuseStrayDrop}
      onDrop={refuseStrayDrop}
    >
      <header className="doc-overlay__bar">
        <div className="doc-overlay__crumb">
          <FileText size={15} aria-hidden />
          <span>Document</span>
          {readOnly && <span className="doc-overlay__badge">View only</span>}
        </div>
        {!readOnly && <TextToolbar placement="bar" />}
        <div className="doc-overlay__right">
          <PeersHere id={id} />
          <WordCount fragment={fragment} />
          <button type="button" className="icon-btn doc-overlay__close" aria-label="Close document" title="Close (Esc)" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </div>
      </header>
      <div className="doc-overlay__scroll">
        <article className="doc-page" data-color={color ?? undefined}>
          {readOnly ? (
            <h1 className={`doc-page__title${title.trim() ? '' : ' is-placeholder'}`}>{shownTitle}</h1>
          ) : (
            <textarea
              ref={titleRef}
              className="doc-page__title doc-page__title-input"
              rows={1}
              value={titleField.value}
              placeholder={DEFAULT_DOCUMENT_TITLE}
              aria-label="Document title"
              maxLength={300}
              spellCheck
              onChange={(e) => titleField.onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
              onFocus={titleField.onFocus}
              onBlur={titleField.onBlur}
              onKeyDown={(e) => {
                // Enter / arrows also confirm or pick an input-method (IME) conversion: leave those alone.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return
                if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) {
                  e.preventDefault()
                  editorRef.current?.commands.focus('start')
                }
              }}
            />
          )}
          <RichText
            fragment={fragment}
            editing
            variant="document"
            placeholder="Start writing…"
            readOnly={readOnly}
            onExit={onClose}
            autofocus={startInTitle ? false : 'end'}
            onEditor={onEditor}
            cardId={id}
            onPasteFiles={pasteFiles}
          />
        </article>
      </div>
    </div>
  )
})

/** Teammates who have this document open (re-renders on presence changes without touching the editor). */
function PeersHere({ id }: { id: string }) {
  const peers = usePeers()
  const here = useMemo(
    () =>
      peers
        .filter((p) => p.state.editing === id)
        .map((p) => ({
          clientId: p.clientId,
          name: typeof p.state.user.name === 'string' && p.state.user.name.trim() ? p.state.user.name.trim().slice(0, 40) : 'Someone',
          color: typeof p.state.user.color === 'string' && HEX.test(p.state.user.color) ? p.state.user.color : '#8b8d98',
        })),
    [peers, id],
  )
  if (!here.length) return null
  return (
    <div className="doc-overlay__peers" aria-label={`Also here: ${here.map((p) => p.name).join(', ')}`}>
      {here.slice(0, 5).map((p) => (
        <span key={p.clientId} className="doc-overlay__peer" style={{ background: p.color }} title={`${p.name} is here`}>
          {initials(p.name)}
        </span>
      ))}
      {here.length > 5 && <span className="doc-overlay__peer doc-overlay__peer--more">+{here.length - 5}</span>}
    </div>
  )
}

function WordCount({ fragment }: { fragment: Y.XmlFragment }) {
  const version = useYVersion(fragment)
  const deferred = useDeferredValue(version)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const words = useMemo(() => countWords(fragmentToText(fragment)), [fragment, deferred])
  return <span className="doc-overlay__count">{formatWordCount(words)}</span>
}
