/**
 * Accessible modal dialog used by every app dialog: portal, focus trap, focus restore,
 * Escape / backdrop to close, role="dialog" + aria-labelledby/-describedby.
 *
 * Keyboard and clipboard events are stopped at the dialog so the board's window-level
 * shortcuts (N = new note, Delete, Space-to-pan, Ctrl+C on cards...) never fire behind it.
 * While any dialog is open, a capture-phase window guard also catches keys and clipboard events
 * whose target is outside the top dialog (focus slipped out of it) and brings focus back, so
 * nothing behind a modal can react to typing.
 */
import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { MODAL_EXEMPT_SELECTOR, strayKeyAction } from './modalGuard'
import './dialogs.css'

export interface DialogProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** Short supporting text under the title (announced as the dialog description). */
  description?: ReactNode
  children?: ReactNode
  /** Buttons row at the bottom. */
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
  /** False blocks Escape, backdrop clicks and the close button (e.g. first-run name prompt). */
  dismissible?: boolean
  /** Element to focus when the dialog opens. Defaults to the first [data-autofocus] or focusable element. */
  initialFocus?: RefObject<HTMLElement | null>
  className?: string
  /** Extra content placed in the header row (e.g. tabs). */
  headerExtra?: ReactNode
  /** Render without the visible header (the title stays available to screen readers). */
  hideHeader?: boolean
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[inert]') && (el.offsetParent !== null || el === document.activeElement),
  )
}

/** Where focus goes when a dialog opens (and when it has to be brought back into it). */
function initialTarget(root: HTMLElement, initialFocus?: RefObject<HTMLElement | null>): HTMLElement {
  return (
    initialFocus?.current ??
    root.querySelector<HTMLElement>('[data-autofocus]') ??
    focusables(root).find((el) => !el.classList.contains('dlg__close')) ??
    root
  )
}

/** Stops an event from reaching window-level board listeners. */
export const stopEvent = (e: SyntheticEvent) => e.stopPropagation()

/** Spread on any overlay element rendered outside the canvas to isolate it from board shortcuts. */
export const isolateBoardEvents = {
  onKeyDown: stopEvent,
  onKeyUp: stopEvent,
  onCopy: stopEvent,
  onCut: stopEvent,
  onPaste: stopEvent,
}

// ---------------------------------------------------------------------------
// Stack of open dialogs (top-most last): only the top one reacts to Escape and owns focus.

interface Layer {
  id: string
  root: RefObject<HTMLDivElement | null>
  /** Closes the dialog when it is dismissible. */
  dismiss: () => void
  /** Puts focus back inside the dialog (where it last was, else the initial target). */
  refocus: () => void
}

const stack: Layer[] = []

/** True while any modal dialog is open (board-level handlers such as presentation mode defer to it). */
export function hasOpenDialog(): boolean {
  return stack.length > 0
}

function topLayer(): { layer: Layer; root: HTMLDivElement } | null {
  const layer = stack[stack.length - 1]
  const root = layer?.root.current
  return layer && root ? { layer, root } : null
}

function isExempt(target: Node | null): boolean {
  return target instanceof Element && !!target.closest(MODAL_EXEMPT_SELECTOR)
}

/** Keys aimed at something outside the top dialog: never let them reach the board behind it. */
function onStrayKeyDown(e: KeyboardEvent) {
  const top = topLayer()
  if (!top) return
  const target = e.target instanceof Node ? e.target : null
  const inDialog = !!target && top.root.contains(target)
  const action = strayKeyAction(e, inDialog, !inDialog && isExempt(target))
  if (action === 'ignore') return
  e.stopPropagation()
  if (action === 'tab') {
    e.preventDefault()
    const items = focusables(top.root)
    const next = (e.shiftKey ? items[items.length - 1] : items[0]) ?? top.root
    next.focus({ preventScroll: true })
    return
  }
  if (action === 'dismiss') {
    e.preventDefault()
    top.layer.dismiss()
    return
  }
  if (action === 'refocus-block') e.preventDefault()
  // Focus moves during keydown, so a typed character is delivered to the dialog's field.
  top.layer.refocus()
}

/** Copy/cut/paste outside the top dialog must not act on the board's selection behind it. */
function onStrayClipboard(e: Event) {
  const top = topLayer()
  if (!top) return
  const target = e.target instanceof Node ? e.target : null
  if ((target && top.root.contains(target)) || isExempt(target)) return
  e.stopPropagation()
}

const CLIPBOARD_EVENTS = ['copy', 'cut', 'paste'] as const

function pushLayer(layer: Layer) {
  if (!stack.length) {
    window.addEventListener('keydown', onStrayKeyDown, true)
    for (const t of CLIPBOARD_EVENTS) window.addEventListener(t, onStrayClipboard, true)
  }
  stack.push(layer)
}

function popLayer(layer: Layer) {
  const i = stack.lastIndexOf(layer)
  if (i >= 0) stack.splice(i, 1)
  if (!stack.length) {
    window.removeEventListener('keydown', onStrayKeyDown, true)
    for (const t of CLIPBOARD_EVENTS) window.removeEventListener(t, onStrayClipboard, true)
  }
}

export function Dialog(props: DialogProps) {
  if (!props.open || typeof document === 'undefined') return null
  return createPortal(<DialogInner {...props} />, document.body)
}

function DialogInner({
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  initialFocus,
  className,
  headerExtra,
  hideHeader = false,
}: DialogProps) {
  const id = useId()
  const titleId = `${id}-title`
  const descId = `${id}-desc`
  const ref = useRef<HTMLDivElement>(null)
  const pressedOnBackdrop = useRef(false)
  const lastFocus = useRef<HTMLElement | null>(null)
  const latest = useRef({ onClose, dismissible, initialFocus })
  useLayoutEffect(() => {
    latest.current = { onClose, dismissible, initialFocus }
  })

  // Declared before the focus effect so, on close, the guard is gone before focus is restored.
  useLayoutEffect(() => {
    const layer: Layer = {
      id,
      root: ref,
      dismiss: () => {
        if (latest.current.dismissible) latest.current.onClose()
        else layer.refocus()
      },
      refocus: () => {
        const root = ref.current
        if (!root) return
        const last = lastFocus.current
        const back =
          last && last.isConnected && root.contains(last) && !last.matches(':disabled') ? last : initialTarget(root, latest.current.initialFocus)
        back.focus({ preventScroll: true })
      },
    }
    pushLayer(layer)
    return () => popLayer(layer)
  }, [id])

  // Initial focus + restore focus to the opener on close.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const root = ref.current
    if (root) initialTarget(root, initialFocus).focus({ preventScroll: true })
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true })
    }
    // Focus only once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isTop = () => stack[stack.length - 1]?.id === id

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (!isTop()) return
    if (e.key === 'Escape') {
      e.preventDefault()
      if (dismissible) latest.current.onClose()
      return
    }
    if (e.key !== 'Tab' || !ref.current) return
    const items = focusables(ref.current)
    if (!items.length) {
      e.preventDefault()
      ref.current.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (e.shiftKey && (active === first || !ref.current.contains(active) || active === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && (active === last || !ref.current.contains(active))) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="dlg-backdrop"
      onPointerDown={(e) => {
        pressedOnBackdrop.current = e.target === e.currentTarget
      }}
      onMouseDown={(e) => {
        // The backdrop is not focusable: without this a click on it blurs the dialog's field and
        // focus falls to <body>, outside the dialog (e.g. on the non-dismissible first-run prompt).
        if (e.target === e.currentTarget) e.preventDefault()
      }}
      onClick={(e) => {
        // Only a click that started and ended on the backdrop closes (not a text-selection drag).
        if (dismissible && pressedOnBackdrop.current && e.target === e.currentTarget) latest.current.onClose()
        pressedOnBackdrop.current = false
      }}
      onContextMenu={stopEvent}
      onWheel={stopEvent}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={['dlg', `dlg--${size}`, className].filter(Boolean).join(' ')}
        onKeyDown={onKeyDown}
        onKeyUp={stopEvent}
        onCopy={stopEvent}
        onCut={stopEvent}
        onPaste={stopEvent}
        onFocus={(e) => {
          lastFocus.current = e.target as HTMLElement
        }}
      >
        {hideHeader ? (
          <>
            <h2 id={titleId} className="sr-only">
              {title}
            </h2>
            {description && (
              <p id={descId} className="sr-only">
                {description}
              </p>
            )}
          </>
        ) : (
          <div className="dlg__header">
            <div className="dlg__titles">
              <h2 id={titleId} className="dlg__title">
                {title}
              </h2>
              {description && (
                <p id={descId} className="dlg__desc">
                  {description}
                </p>
              )}
            </div>
            {headerExtra}
            {dismissible && (
              <button type="button" className="icon-btn dlg__close" aria-label="Close" title="Close (Esc)" onClick={() => latest.current.onClose()}>
                <X size={18} aria-hidden />
              </button>
            )}
          </div>
        )}
        <div className="dlg__body">{children}</div>
        {footer && <div className="dlg__footer">{footer}</div>}
      </div>
    </div>
  )
}
