/**
 * Popover for a task's due date (date, optional time, quick picks, clear) or assignee (people on
 * the board, unassign). Used by the live editor's task chips and buttons, and by the chips of text
 * that is not being edited.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useDismiss, useFloating, useInteractions, type VirtualElement } from '@floating-ui/react'
import { Calendar, Check, UserRound, X } from 'lucide-react'
import { useBoard, usePeers } from '../board/BoardContext'
import { useIdentity } from '../collab/identity'
import { mentionCandidates, type Member } from '../model/members'
import { dueDate, dueTime, isPlausibleDueDate, joinDue, quickDates } from './taskMeta'
import type { TaskAttrPatch } from './tasks'
import type { TaskMetaKind } from './taskItem'
import { memberInitials } from './taskItem'
import { nameMatches } from './mentionAttrs'
import { focusRovingItem, moveRovingFocus, ROVING_ITEM, rovingItems } from './toolbarFocus'

export type TaskMetaCloseReason = 'escape' | 'done' | 'outside'

export interface TaskMetaPopoverProps {
  mode: TaskMetaKind
  /**
   * Chip or button the popover belongs to, a caret rectangle, or something that measures one. The
   * position is re-measured every frame: the board pans and zooms with transforms, which fire no
   * scroll or resize events.
   */
  anchor: Element | DOMRect | VirtualElement
  due: string | null
  assignee: string | null
  onChange: (patch: TaskAttrPatch) => void
  onClose: (reason: TaskMetaCloseReason) => void
}

/** Board members, live peers and the current user, deduplicated (the current user first). */
export function useAssignablePeople(): Member[] {
  const board = useBoard()
  const peers = usePeers()
  const me = useIdentity((s) => s.user)
  return useMemo(() => {
    const extra = [
      { id: me.id, name: me.name || 'Me', color: me.color },
      ...peers.map((p) => ({ id: p.state.user.id, name: p.state.user.name, color: p.state.user.color })),
    ]
    return mentionCandidates(board.doc, extra, me.id)
  }, [board.doc, peers, me])
}

const keyDate = (key: string) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)))
const weekday = (key: string) => new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(keyDate(key))
const shortDate = (key: string) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(keyDate(key))

/** Saves (true) or drops (false) what the due date fields hold but have not written yet. */
type DraftSettle = (commit: boolean) => void

export function TaskMetaPopover({ mode, anchor, due, assignee, onChange, onClose }: TaskMetaPopoverProps) {
  const reference = useMemo<Element | VirtualElement>(() => {
    if (anchor instanceof Element) return anchor
    if (anchor instanceof DOMRect) return { getBoundingClientRect: () => anchor }
    return anchor
  }, [anchor])
  const settleDraft = useRef<DraftSettle | null>(null)
  // Escape cancels a half-entered date; closing any other way keeps it.
  const close = useCallback(
    (reason: TaskMetaCloseReason) => {
      settleDraft.current?.(reason !== 'escape')
      onClose(reason)
    },
    [onClose],
  )
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) close('outside')
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, Math.min(420, availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: (ref, floating, update) => autoUpdate(ref, floating, update, { animationFrame: true }),
  })
  useLayoutEffect(() => {
    // A real element also counts as "inside" for outside-press dismissal.
    if (reference instanceof Element) refs.setReference(reference)
    else refs.setPositionReference(reference)
  }, [refs, reference])
  const dismiss = useDismiss(context, { escapeKey: false })
  const { getFloatingProps } = useInteractions([dismiss])
  const titleId = useId()

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      close('escape')
    }
    // Typing here must never reach the editor, the card or the board shortcuts.
    e.stopPropagation()
  }

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="tm-pop"
        role="dialog"
        aria-labelledby={titleId}
        {...getFloatingProps({
          onKeyDown,
          // Tabbing out of the popover closes it, like a click elsewhere does.
          onBlur: (e: React.FocusEvent) => {
            const next = e.relatedTarget as Node | null
            if (next && !(e.currentTarget as HTMLElement).contains(next)) close('outside')
          },
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
          onClick: (e: React.MouseEvent) => e.stopPropagation(),
          onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
          onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
        })}
      >
        {mode === 'due' ? (
          <DuePanel titleId={titleId} due={due} onChange={onChange} onClose={close} settleRef={settleDraft} />
        ) : (
          <AssignPanel titleId={titleId} assignee={assignee} onChange={onChange} onClose={close} />
        )}
      </div>
    </FloatingPortal>
  )
}

interface DueDraft {
  date: string
  time: string
  /** The field holds a half-typed value, which browsers report as ''. */
  dateIncomplete: boolean
  timeIncomplete: boolean
  /** Edited since it was last written or reset. */
  dirty: boolean
}

const fieldsOf = (due: string | null) => ({ date: due ? dueDate(due) : '', time: due ? (dueTime(due) ?? '') : '' })

/**
 * The date and time fields are a draft, written once on Enter, Done, a quick pick or closing the
 * popover: a date input reports every step of a year being typed (0002, 0020, 0202...), and each
 * step would otherwise reach every peer and the history.
 */
function DuePanel({
  titleId,
  due,
  onChange,
  onClose,
  settleRef,
}: {
  titleId: string
  due: string | null
  onChange: (patch: TaskAttrPatch) => void
  onClose: (reason: TaskMetaCloseReason) => void
  settleRef: RefObject<DraftSettle | null>
}) {
  const [date, setDate] = useState(() => fieldsOf(due).date)
  const [time, setTime] = useState(() => fieldsOf(due).time)
  const draft = useRef<DueDraft>({ ...fieldsOf(due), dateIncomplete: false, timeIncomplete: false, dirty: false })
  const dueRef = useRef(due)
  const dateRef = useRef<HTMLInputElement>(null)
  const picks = useMemo(() => quickDates(new Date()), [])

  useLayoutEffect(() => {
    dateRef.current?.focus({ preventScroll: true })
  }, [])

  // Changed elsewhere (a teammate, undo) while the fields are untouched: show the new value.
  useEffect(() => {
    dueRef.current = due
    if (draft.current.dirty) return
    const fields = fieldsOf(due)
    draft.current = { ...fields, dateIncomplete: false, timeIncomplete: false, dirty: false }
    setDate(fields.date)
    setTime(fields.time)
  }, [due])

  useLayoutEffect(() => {
    settleRef.current = (commit) => {
      const d = draft.current
      if (!d.dirty) return
      draft.current = { ...d, dirty: false }
      if (!commit || d.dateIncomplete || d.timeIncomplete) return
      const current = dueRef.current
      if (!d.date) {
        if (current) onChange({ due: null })
        return
      }
      if (!isPlausibleDueDate(d.date)) return
      const next = joinDue(d.date, d.time || null)
      if (next && next !== current) onChange({ due: next })
    }
    return () => {
      settleRef.current = null
    }
  })

  const edit = (field: 'date' | 'time', e: ChangeEvent<HTMLInputElement>) => {
    const { value, validity } = e.currentTarget
    const incomplete = !value && validity.badInput
    draft.current =
      field === 'date'
        ? { ...draft.current, date: value, dateIncomplete: incomplete, dirty: true }
        : { ...draft.current, time: value, timeIncomplete: incomplete, dirty: true }
    if (field === 'date') setDate(value)
    else setTime(value)
  }

  const quick = (key: string) => {
    const d = draft.current
    draft.current = { ...d, dirty: false }
    onChange({ due: joinDue(key, d.timeIncomplete ? null : d.time || null) ?? key })
    onClose('done')
  }

  return (
    <>
      <div className="tm-pop__head" id={titleId}>
        <Calendar size={14} aria-hidden />
        Due date
      </div>
      <div className="tm-pop__fields">
        <label className="tm-field">
          <span className="tm-field__label">Date</span>
          <input
            ref={dateRef}
            type="date"
            className="tm-field__input"
            value={date}
            onChange={(e) => edit('date', e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onClose('done')
              }
            }}
          />
        </label>
        <label className="tm-field">
          <span className="tm-field__label">
            Time <span className="tm-field__hint">(optional)</span>
          </span>
          <input
            type="time"
            className="tm-field__input"
            value={time}
            disabled={!date}
            onChange={(e) => edit('time', e)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                onClose('done')
              }
            }}
          />
        </label>
      </div>
      <div className="tm-pop__quick" role="group" aria-label="Quick dates">
        <button type="button" className="tm-quick" onClick={() => quick(picks.today)}>
          <span>Today</span>
          <span className="tm-quick__day">{weekday(picks.today)}</span>
        </button>
        <button type="button" className="tm-quick" onClick={() => quick(picks.tomorrow)}>
          <span>Tomorrow</span>
          <span className="tm-quick__day">{weekday(picks.tomorrow)}</span>
        </button>
        <button type="button" className="tm-quick" onClick={() => quick(picks.nextMonday)}>
          <span>Next Monday</span>
          <span className="tm-quick__day">{shortDate(picks.nextMonday)}</span>
        </button>
      </div>
      <div className="tm-pop__foot">
        <button
          type="button"
          className="tm-btn tm-btn--danger"
          disabled={!due}
          onClick={() => {
            draft.current = { ...draft.current, dirty: false }
            onChange({ due: null })
            onClose('done')
          }}
        >
          <X size={14} aria-hidden />
          Clear
        </button>
        <button type="button" className="tm-btn tm-btn--primary" onClick={() => onClose('done')}>
          Done
        </button>
      </div>
    </>
  )
}

const FILTER_FROM = 7

function AssignPanel({
  titleId,
  assignee,
  onChange,
  onClose,
}: {
  titleId: string
  assignee: string | null
  onChange: (patch: TaskAttrPatch) => void
  onClose: (reason: TaskMetaCloseReason) => void
}) {
  const people = useAssignablePeople()
  const meId = useIdentity((s) => s.user.id)
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const shown = useMemo(() => people.filter((p) => nameMatches(p.name, query.trim())), [people, query])
  const withFilter = people.length >= FILTER_FROM
  const known = !assignee || people.some((p) => p.id === assignee)

  useLayoutEffect(() => {
    if (withFilter) {
      filterRef.current?.focus({ preventScroll: true })
      return
    }
    const list = listRef.current
    if (!list) return
    const items = rovingItems(list)
    const target = items.find((el) => el.getAttribute('aria-selected') === 'true') ?? items[0]
    if (target) focusRovingItem(list, target)
    // Focus once, when the popover opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep exactly one option in the tab order as the filter changes the list.
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const items = rovingItems(list)
    if (items.length && !items.some((el) => el.tabIndex === 0)) items[0].tabIndex = 0
  }, [shown])

  const pick = (id: string) => {
    if (id !== assignee) onChange({ assignee: id })
    onClose('done')
  }

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current
    if (!list) return
    if (e.key === 'ArrowUp' && withFilter && rovingItems(list)[0] === document.activeElement) {
      e.preventDefault()
      filterRef.current?.focus()
      return
    }
    if (moveRovingFocus(list, e.key)) e.preventDefault()
  }

  return (
    <>
      <div className="tm-pop__head" id={titleId}>
        <UserRound size={14} aria-hidden />
        Assign to
      </div>
      {withFilter && (
        <input
          ref={filterRef}
          type="search"
          className="tm-field__input tm-filter"
          placeholder="Find a person…"
          aria-label="Find a person"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown' || e.key === 'Enter') {
              const list = listRef.current
              const first = list ? rovingItems(list)[0] : null
              if (!first) return
              e.preventDefault()
              if (e.key === 'Enter' && shown.length === 1) pick(shown[0].id)
              else focusRovingItem(list!, first)
            }
          }}
        />
      )}
      <div ref={listRef} className="tm-people" role="listbox" aria-label="People on this board" onKeyDown={onListKeyDown}>
        {shown.map((p, i) => {
          const selected = p.id === assignee
          return (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={(assignee ? selected : i === 0) ? 0 : -1}
              {...{ [ROVING_ITEM]: '' }}
              className={`tm-person${selected ? ' is-selected' : ''}`}
              onClick={() => pick(p.id)}
            >
              <span className="tm-avatar" style={{ background: p.color }} aria-hidden>
                {memberInitials(p.name)}
              </span>
              <span className="tm-person__name">{p.name}</span>
              {p.id === meId && <span className="tm-person__you">You</span>}
              {selected && <Check size={14} className="tm-person__check" aria-hidden />}
            </button>
          )
        })}
        {!shown.length && <div className="tm-people__empty">Nobody matches “{query.trim()}”</div>}
      </div>
      {!known && <p className="tm-pop__note">Assigned to someone who is not on this board.</p>}
      {assignee && (
        <div className="tm-pop__foot">
          <button
            type="button"
            className="tm-btn tm-btn--danger"
            onClick={() => {
              onChange({ assignee: null })
              onClose('done')
            }}
          >
            <X size={14} aria-hidden />
            Unassign
          </button>
        </div>
      )}
    </>
  )
}
