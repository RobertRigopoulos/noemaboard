/**
 * The "More" (Ellipsis) menu in a to-do card's header: hide completed tasks, delete completed tasks.
 * Keyboard: Enter, Space or ArrowDown opens it on the first item; arrows, Home and End move;
 * Escape closes it and returns to the button.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions } from '@floating-ui/react'
import { Check, Ellipsis, EyeOff, ListX } from 'lucide-react'
import { focusRovingGroup, moveRovingFocus, ROVING_ITEM } from '../../editor/toolbarFocus'

interface Props {
  hideDone: boolean
  canDelete: boolean
  onToggleHide: () => void
  onDelete: () => void
}

export function TodoMenu({ hideDone, canDelete, onToggleHide, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const byKeyboard = useRef(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    strategy: 'fixed',
    middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const dismiss = useDismiss(context, { escapeKey: false })
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss])

  useLayoutEffect(() => {
    if (open && byKeyboard.current && menuRef.current) focusRovingGroup(menuRef.current, 'first')
  }, [open])

  const close = (refocus: boolean) => {
    setOpen(false)
    byKeyboard.current = false
    if (refocus) buttonRef.current?.focus({ preventScroll: true })
  }

  const run = (fn: () => void) => () => {
    const keyboard = !!menuRef.current?.contains(document.activeElement)
    close(keyboard)
    fn()
  }

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close(true)
    } else if (e.key === 'Tab') {
      close(false)
      return
    } else if (menuRef.current && moveRovingFocus(menuRef.current, e.key)) {
      e.preventDefault()
    }
    // Keys inside the menu are not board shortcuts.
    e.stopPropagation()
  }

  return (
    <>
      <button
        type="button"
        className={`todo-card__menu-btn no-drag${open ? ' is-open' : ''}`}
        aria-label="To-do options"
        title="To-do options"
        aria-haspopup="menu"
        aria-expanded={open}
        {...getReferenceProps({
          ref: (el: HTMLButtonElement | null) => {
            buttonRef.current = el
            refs.setReference(el)
          },
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
          onClick: (e: React.MouseEvent) => {
            e.stopPropagation()
            byKeyboard.current = e.detail === 0
            setOpen(!open)
          },
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              e.stopPropagation()
              byKeyboard.current = true
              if (open && menuRef.current) focusRovingGroup(menuRef.current, 'first')
              else setOpen(true)
            }
          },
        })}
      >
        <Ellipsis size={16} aria-hidden />
      </button>
      {open && (
        <FloatingPortal>
          <div
            className="todo-menu"
            role="menu"
            aria-label="To-do options"
            {...getFloatingProps({
              ref: (el: HTMLDivElement | null) => {
                menuRef.current = el
                refs.setFloating(el)
              },
              style: floatingStyles,
              onKeyDown: onMenuKeyDown,
              onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
              onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
            })}
          >
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={hideDone}
              tabIndex={-1}
              {...{ [ROVING_ITEM]: '' }}
              className="todo-menu__item"
              onClick={run(onToggleHide)}
            >
              <EyeOff size={15} aria-hidden />
              <span>Hide completed</span>
              {hideDone && <Check size={14} className="todo-menu__check" aria-hidden />}
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={!canDelete}
              {...{ [ROVING_ITEM]: '' }}
              className="todo-menu__item todo-menu__item--danger"
              onClick={run(onDelete)}
            >
              <ListX size={15} aria-hidden />
              <span>Delete completed</span>
            </button>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
