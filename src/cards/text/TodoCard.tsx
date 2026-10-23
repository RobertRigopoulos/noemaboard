import { useCallback, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import type { CardProps } from '../types'
import type { TodoCard as TodoCardData } from '../../model/types'
import { useBoard, useYVersion } from '../../board/BoardContext'
import { addCardBelow } from '../../board/actions'
import { updateCard } from '../../model/board'
import { getUser } from '../../collab/identity'
import { RichText } from '../../editor/RichText'
import { isFragmentEmpty } from '../../editor/staticHtml'
import { countHiddenDone, countOverdue, hasCheckedTasks, readHideDone, taskStats } from '../../editor/tasks'
import { useToday } from '../../editor/dayClock'
import { registerBoardOverlay } from '../cardActions'
import { importBelowCard } from '../media/importBelow'
import { cardString, useCardFragment, useDraftField } from './hooks'
import { useDiscardIfLeftEmpty } from './discardEmpty'
import { deleteCompletedTasks, setHideDone } from './actions'
import { TaskReminders } from './TaskReminders'
import { TodoMenu } from './TodoMenu'
import './text-cards.css'

registerBoardOverlay('text.taskReminders', TaskReminders)

/** Checklist card: optional serif title, progress, and a task list that can be ticked without editing. */
export function TodoCard({ id, card, map, editing, readOnly, stopEditing }: CardProps<TodoCardData>) {
  const board = useBoard()
  const { doc } = board
  const fragment = useCardFragment(map, 'content', readOnly)
  const version = useYVersion(fragment)
  const today = useToday()
  const title = cardString(card.title, 300)
  const hideDone = readHideDone(card.hideDone)
  const live = editing && !readOnly
  const summary = useMemo(
    () =>
      fragment
        ? {
            stats: taskStats(fragment),
            overdue: countOverdue(fragment, today),
            checked: hasCheckedTasks(fragment),
            hidden: hideDone && !live ? countHiddenDone(fragment) : 0,
          }
        : { stats: { total: 0, done: 0 }, overdue: 0, checked: false, hidden: 0 },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fragment, version, today, hideDone, live],
  )
  const { stats, overdue } = summary
  // A to-do list made by accident and left without a title or tasks goes away again.
  useDiscardIfLeftEmpty(id, card, editing, readOnly, () => !cardString(map.get('title'), 300).trim() && (!fragment || isFragmentEmpty(fragment)))

  const stopEditingRef = useRef(stopEditing)
  useLayoutEffect(() => {
    stopEditingRef.current = stopEditing
  })
  // Mod+Enter: done with this list, start a note below it.
  const createNext = useCallback(() => {
    stopEditingRef.current()
    addCardBelow(doc, id)
    return true
  }, [doc, id])
  const pasteFiles = useCallback((files: File[]) => void importBelowCard(doc, id, files), [doc, id])

  const editorRef = useRef<Editor | null>(null)
  const prepared = useRef<Editor | null>(null)
  const onEditor = useCallback((editor: Editor | null) => {
    editorRef.current = editor
    if (!editor || prepared.current === editor || !editor.isEditable) return
    prepared.current = editor
    // A to-do with no content starts with one empty task so typing creates a task straight away.
    // Not added to the editor's undo history: undoing should not turn the list back into a paragraph.
    const pm = editor.state.doc
    const first = pm.firstChild
    if (pm.childCount === 1 && first?.type.name === 'paragraph' && first.content.size === 0) {
      editor
        .chain()
        .command(({ tr }) => {
          tr.setMeta('addToHistory', false)
          return true
        })
        .toggleTaskList()
        .run()
    }
  }, [])

  const titleField = useDraftField(title, (next) => updateCard(doc, id, { title: next }, getUser().id), 300)

  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0
  const complete = stats.total > 0 && stats.done === stats.total
  const showMenu = !readOnly && !board.readOnly && (stats.total > 0 || summary.checked)
  // What the static list actually hides (nested and blank items too), not the progress count.
  const hiddenCount = summary.hidden

  const meta: ReactNode =
    overdue > 0 || showMenu ? (
      <>
        {overdue > 0 && (
          <span className="todo-card__overdue" title={overdue === 1 ? '1 task is past its due date' : `${overdue} tasks are past their due date`}>
            {overdue} overdue
          </span>
        )}
        {showMenu && (
          <TodoMenu
            hideDone={hideDone}
            canDelete={summary.checked}
            onToggleHide={() => setHideDone(board, id, !hideDone)}
            onDelete={() => {
              deleteCompletedTasks(board, id)
            }}
          />
        )}
      </>
    ) : null
  const head = live || !!title

  return (
    <div className={`text-card todo-card${complete ? ' is-complete' : ''}${hideDone ? ' is-hiding-done' : ''}`}>
      {live ? (
        <div className="todo-card__head">
          <input
            className="todo-card__title-input"
            value={titleField.value}
            placeholder="To-do list title"
            aria-label="To-do list title"
            maxLength={300}
            spellCheck
            onChange={(e) => titleField.onChange(e.target.value)}
            onFocus={titleField.onFocus}
            onBlur={titleField.onBlur}
            onKeyDown={(e) => {
              // Enter / arrows also confirm or pick an input-method (IME) conversion: leave those alone.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                e.stopPropagation()
                createNext()
              } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
                e.preventDefault()
                editorRef.current?.commands.focus('start')
              } else if (e.key === 'Escape') {
                e.preventDefault()
                stopEditing()
              }
            }}
          />
          {meta}
        </div>
      ) : (
        title && (
          <div className="todo-card__head">
            <h3 className="todo-card__title">{title}</h3>
            {meta}
          </div>
        )
      )}
      {stats.total > 0 && (
        <div className="todo-card__progress">
          <div
            className="todo-card__bar"
            role="progressbar"
            aria-label="Tasks completed"
            aria-valuemin={0}
            aria-valuemax={stats.total}
            aria-valuenow={stats.done}
            aria-valuetext={`${stats.done} of ${stats.total} done`}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <span className="todo-card__count" title={`${stats.done} of ${stats.total} done`}>
            {stats.done}/{stats.total}
          </span>
          {!head && meta}
        </div>
      )}
      {fragment && (
        <RichText
          fragment={fragment}
          editing={live}
          variant="todo"
          placeholder="Add a task…"
          readOnly={readOnly}
          onExit={stopEditing}
          onEditor={onEditor}
          cardId={id}
          onPasteFiles={pasteFiles}
          onCreateNext={createNext}
          emptyText={title ? 'No tasks yet' : 'Empty to-do list'}
        />
      )}
      {hiddenCount > 0 && (
        <div className="todo-card__hidden">
          <span>
            {hiddenCount} completed hidden
          </span>
          {!readOnly && !board.readOnly && (
            <>
              <span aria-hidden> · </span>
              <button
                type="button"
                className="todo-card__show no-drag"
                aria-label="Show completed tasks"
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                }}
                onClick={(e) => {
                  e.stopPropagation()
                  setHideDone(board, id, false)
                }}
              >
                Show
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
