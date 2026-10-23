/**
 * '@' mention picker for comment text fields. Typing '@' at the start of the text or after a space
 * opens a listbox anchored at the caret; Up/Down/Enter/Tab pick, Escape closes it without leaving
 * the field. Focus never leaves the textarea (aria-activedescendant points into the list).
 */
import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react'
import { avatarInitials } from './helpers'
import { insertMention, matchPeople, mentionQueryAt } from './linkify'

export interface MentionPerson {
  id: string
  name: string
  color: string
}

// Kebab-case so they can be copied with getPropertyValue / setProperty.
const MIRROR_PROPS = [
  'box-sizing',
  'width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-style',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'tab-size',
  'word-break',
  'overflow-wrap',
]

export interface CaretOffset {
  left: number
  top: number
  height: number
}

/** Caret position at `position` in the textarea's own (unscaled) pixels, measured with an off-screen copy. */
export function caretOffset(el: HTMLTextAreaElement, position: number): CaretOffset {
  const style = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const p of MIRROR_PROPS) mirror.style.setProperty(p, style.getPropertyValue(p))
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflow = 'hidden'
  mirror.style.height = 'auto'
  mirror.textContent = el.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = el.value.slice(position, position + 1) || '.'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  const left = marker.offsetLeft
  const lineHeight = parseFloat(style.lineHeight) || marker.offsetHeight || 16
  mirror.remove()
  return { left, top, height: lineHeight }
}

/** Screen rect of a caret offset; the textarea may sit in the zoomed canvas. */
export function caretClientRect(el: HTMLTextAreaElement, off: CaretOffset): DOMRect {
  const r = el.getBoundingClientRect()
  const scale = el.offsetWidth ? r.width / el.offsetWidth : 1
  return new DOMRect(r.left + (off.left - el.scrollLeft) * scale, r.top + (off.top - el.scrollTop) * scale, 0, off.height * scale)
}

interface Options {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  text: string
  /** Candidates, read when a mention query starts (cheap enough to call on every '@'). */
  people: () => readonly MentionPerson[]
  /** The text with '@Name ' inserted, the caret after it, and who was picked. */
  onInsert: (text: string, caret: number, person: MentionPerson) => void
}

interface Picker {
  /** Spread onto the textarea. */
  inputProps: {
    'aria-autocomplete': 'list'
    'aria-expanded': boolean
    'aria-controls': string | undefined
    'aria-activedescendant': string | undefined
    onSelect: () => void
    onBlur: () => void
  }
  /** Call first in the textarea's onKeyDown; true when the key was used by the picker. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  isOpen: boolean
  /** Render next to the textarea (it portals itself out of the canvas). */
  picker: ReactNode
}

export function useMentionPicker({ textareaRef, text, people, onInsert }: Options): Picker {
  const listId = useId()
  const [query, setQuery] = useState<{ start: number; query: string } | null>(null)
  const [candidates, setCandidates] = useState<readonly MentionPerson[]>([])
  const [active, setActive] = useState(0)
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const pendingCaret = useRef<number | null>(null)
  const peopleRef = useRef(people)
  peopleRef.current = people
  const queryRef = useRef(query)
  queryRef.current = query

  const refresh = useCallback(() => {
    const el = textareaRef.current
    const prev = queryRef.current
    const typing = !!el && document.activeElement === el && el.selectionStart === el.selectionEnd
    const next = typing ? mentionQueryAt(el.value, el.selectionStart) : null
    if (!next) {
      if (prev) setQuery(null)
      setDismissedAt(null)
      return
    }
    if (!prev || prev.start !== next.start) {
      setCandidates(peopleRef.current())
      setActive(0)
    }
    if (!prev || prev.start !== next.start || prev.query !== next.query) setQuery(next)
  }, [textareaRef])

  // The text changed (typing, paste, a draft restored): re-read the query, restore a picked caret.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el && pendingCaret.current !== null) {
      const at = Math.min(pendingCaret.current, el.value.length)
      pendingCaret.current = null
      el.setSelectionRange(at, at)
    }
    refresh()
  }, [text, refresh, textareaRef])

  const items = useMemo(() => (query ? matchPeople(candidates, query.query) : []), [candidates, query])
  const isOpen = !!query && items.length > 0 && dismissedAt !== query.start
  // Measured once per '@': the list stays put while the name is typed after it.
  const start = isOpen && query ? query.start : -1
  const offsetAt = useMemo(() => {
    const el = textareaRef.current
    return el && start >= 0 ? caretOffset(el, start) : null
  }, [start, textareaRef])
  const activeIndex = Math.min(active, Math.max(0, items.length - 1))

  const pick = (person: MentionPerson) => {
    const el = textareaRef.current
    if (!el || !query) return
    const r = insertMention(el.value, query.start, el.selectionStart, person.name)
    pendingCaret.current = r.caret
    setQuery(null)
    onInsert(r.text, r.caret, person)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!isOpen || e.nativeEvent.isComposing) return false
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const n = items.length
        setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
        break
      }
      case 'Enter':
      case 'Tab':
        if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false
        pick(items[activeIndex])
        break
      case 'Escape':
        // Only the picker closes: the composer (and the card's edit mode) stay.
        setDismissedAt(query!.start)
        break
      default:
        return false
    }
    e.preventDefault()
    e.stopPropagation()
    return true
  }

  const optionId = (i: number) => `${listId}-opt-${i}`

  return {
    inputProps: {
      'aria-autocomplete': 'list',
      'aria-expanded': isOpen,
      'aria-controls': isOpen ? listId : undefined,
      'aria-activedescendant': isOpen ? optionId(activeIndex) : undefined,
      onSelect: refresh,
      onBlur: () => setQuery(null),
    },
    onKeyDown,
    isOpen,
    picker: isOpen ? (
      <MentionList
        id={listId}
        optionId={optionId}
        anchor={() => {
          const el = textareaRef.current
          return el && offsetAt ? caretClientRect(el, offsetAt) : new DOMRect()
        }}
        items={items}
        active={activeIndex}
        onHover={setActive}
        onPick={pick}
      />
    ) : null,
  }
}

function MentionList({
  id,
  optionId,
  anchor,
  items,
  active,
  onHover,
  onPick,
}: {
  id: string
  optionId: (i: number) => string
  anchor: () => DOMRect
  items: readonly MentionPerson[]
  active: number
  onHover: (i: number) => void
  onPick: (p: MentionPerson) => void
}) {
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(300, availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: (reference, floating, update) => autoUpdate(reference, floating, update, { animationFrame: true }),
  })

  useLayoutEffect(() => {
    refs.setPositionReference({ getBoundingClientRect: () => anchorRef.current() })
  }, [refs])

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        id={id}
        className="cmt-mention scrollable"
        role="listbox"
        aria-label="People to mention"
        // Clicks must not move focus out of the text field (or reach the card and canvas).
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        {items.map((p, i) => (
          <div
            key={p.id}
            id={optionId(i)}
            role="option"
            aria-selected={i === active}
            className={`cmt-mention__item${i === active ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(p)}
          >
            <span className="cmt-mention__avatar" style={{ background: p.color }} aria-hidden>
              {avatarInitials(p.name)}
            </span>
            <span className="cmt-mention__name">{p.name}</span>
          </div>
        ))}
      </div>
    </FloatingPortal>
  )
}
