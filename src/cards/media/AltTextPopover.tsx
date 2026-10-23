/**
 * Small editor for an image's alt text, anchored to the card (or to the button that opened it when
 * the card is not rendered). Under 520px it becomes a full-width sheet. Saving (Save, Enter or a click
 * outside) is one undoable write; Cancel and Escape discard.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, useFloating, type VirtualElement } from '@floating-ui/react'
import type { BoardContextValue } from '../../board/BoardContext'
import { getCanvasElement, getCardElement } from '../../board/geometry'
import { getCardMap, readCard, updateCard } from '../../model/board'
import { getUser } from '../../collab/identity'
import { MAX_ALT, readAlt } from './altText'

/** The character count appears once the text gets this long. */
const COUNTER_FROM = 800
const NARROW = '(max-width: 519.98px)'

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(NARROW)
    const update = () => setNarrow(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])
  return narrow
}

interface Props {
  ctx: BoardContextValue
  id: string
  /** Screen rect of the control that opened the editor; used when the card has no element. */
  anchor: DOMRect | null
  onClose: () => void
}

export function AltTextPopover({ ctx, id, anchor, onClose }: Props) {
  const { doc } = ctx
  const [initial] = useState(() => {
    const m = getCardMap(doc, id)
    return m ? readAlt((readCard(m) as unknown as Record<string, unknown>).alt) : ''
  })
  const [value, setValue] = useState(initial)
  const narrow = useNarrow()
  const labelId = useId()
  const counterId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  const cardEl = getCardElement(id)
  const reference = useMemo<Element | VirtualElement | null>(
    () => (cardEl && cardEl.isConnected ? cardEl : anchor ? { getBoundingClientRect: () => anchor } : null),
    [cardEl, anchor],
  )
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: 'bottom',
    middleware: [offset(10), flip({ padding: 8 }), shift({ padding: 8 })],
    // The canvas pans with CSS transforms, which only an animation-frame loop notices.
    whileElementsMounted: (ref, floating, update) => autoUpdate(ref, floating, update, { animationFrame: true }),
  })
  useLayoutEffect(() => {
    refs.setPositionReference(reference)
  }, [refs, reference])

  // Focus moves into the field, caret at the end, and goes back where it was on close. A passive
  // effect, so it runs after a closing context menu has put focus back where the menu found it.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const field = fieldRef.current
    if (field) {
      field.focus({ preventScroll: true })
      field.setSelectionRange(field.value.length, field.value.length)
    }
    return () => {
      const back = previous && previous.isConnected && previous !== document.body ? previous : getCanvasElement()
      back?.focus({ preventScroll: true })
    }
  }, [])

  const save = () => {
    const m = getCardMap(doc, id)
    // Untouched text is not written back over what a teammate may have saved meanwhile.
    if (m && !ctx.readOnly && readAlt(value) !== initial) {
      const next = readAlt(value)
      const current = readAlt((readCard(m) as unknown as Record<string, unknown>).alt)
      if (next !== current) {
        ctx.undo.stopCapturing()
        updateCard(doc, id, { alt: next || undefined }, getUser().id)
        ctx.undo.stopCapturing()
      }
    }
    onClose()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    // Board shortcuts (Escape clears the selection, Delete removes cards...) must not see these keys.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.target === fieldRef.current) {
      e.preventDefault()
      save()
    } else if (e.key === 'Tab') {
      // Keep keyboard focus inside the popover while it is open.
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('textarea, button:not([disabled])'))
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
  }

  const length = value.length
  return (
    <FloatingPortal>
      {/* Clicking away keeps what was typed (tapping above the sheet is how it is dismissed on phones);
          Escape and Cancel are the ways to discard. */}
      <div className="alt-pop-scrim" aria-hidden onPointerDown={save} />
      <div
        ref={refs.setFloating}
        style={narrow ? undefined : floatingStyles}
        className={`alt-pop${narrow ? ' alt-pop--sheet' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        onKeyDown={onKeyDown}
        // React events bubble through portals: keep them away from the card and the canvas.
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onCopy={(e) => e.stopPropagation()}
        onCut={(e) => e.stopPropagation()}
      >
        <label id={labelId} className="alt-pop__label" htmlFor={`${labelId}-field`}>
          Describe this image for people who can’t see it
        </label>
        <textarea
          ref={fieldRef}
          id={`${labelId}-field`}
          className="alt-pop__field"
          value={value}
          maxLength={MAX_ALT}
          rows={3}
          placeholder="For example: A red bicycle leaning against a brick wall"
          aria-describedby={length >= COUNTER_FROM ? counterId : undefined}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="alt-pop__foot">
          <span id={counterId} className={`alt-pop__count${length >= MAX_ALT ? ' is-full' : ''}`} aria-live="polite">
            {length >= COUNTER_FROM ? `${length} / ${MAX_ALT}` : ''}
          </span>
          <button type="button" className="alt-pop__btn" onClick={onClose} title="Cancel (Esc)">
            Cancel
          </button>
          <button type="button" className="alt-pop__btn alt-pop__btn--primary" onClick={save} title="Save (Enter)">
            Save
          </button>
        </div>
      </div>
    </FloatingPortal>
  )
}
