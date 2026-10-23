/**
 * Selection-toolbar button for a card action with sub-actions: opens a small menu (same keyboard
 * model as the context menu). Escape or an outside press closes it and focus returns to the button.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react'
import { ChevronDown } from 'lucide-react'
import type { CardAction } from '../../cards/cardActions'
import { ActionItem, actionHint } from './menuItems'
import { focusFirstItem, onMenuKeyDown } from './menuKeys'
import { MenuHostProvider, useMenuHostState, useNarrowMenus } from './Submenu'

interface Props {
  action: CardAction
  /** Runs a leaf action (selection sync, closing) on behalf of the toolbar. */
  onRun: (a: CardAction, anchor: DOMRect | null) => void
}

export function ActionDropdown({ action, onRun }: Props) {
  const [open, setOpen] = useState(false)
  const focusOnOpen = useRef(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const narrow = useNarrowMenus()
  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }, [])
  const closeAll = useCallback(() => close(false), [close])
  const host = useMenuHostState(closeAll, narrow)

  const { refs, floatingStyles, isPositioned } = useFloating({
    open,
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: [
      offset(6),
      flip({ padding: 8, fallbackPlacements: ['top-start', 'bottom-end', 'top-end'] }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, Math.floor(availableHeight))}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || listRef.current?.contains(t) || triggerRef.current?.contains(t) || t.closest?.('[data-submenu]')) return
      close(false)
    }
    const onBlur = () => close(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, close])

  useEffect(() => {
    if (!open || !isPositioned) return
    if (focusOnOpen.current) {
      focusOnOpen.current = false
      focusFirstItem(listRef.current)
    }
  }, [open, isPositioned])

  const run = (a: CardAction, anchor: DOMRect | null) => {
    close(false)
    onRun(a, anchor)
  }

  const onTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      focusOnOpen.current = true
      if (open) focusFirstItem(listRef.current)
      else setOpen(true)
    }
  }

  const hint = actionHint(action)
  const label = hint ? `${action.label} (${hint})` : action.label
  const Icon = action.icon

  return (
    <>
      <button
        ref={(el) => {
          triggerRef.current = el
          refs.setReference(el)
        }}
        type="button"
        className={`sel-bar__btn sel-bar__btn--menu${action.danger ? ' sel-bar__btn--danger' : ''}`}
        aria-label={action.label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-pressed={action.pressed}
        disabled={action.disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <Icon size={16} strokeWidth={1.75} aria-hidden />
        <ChevronDown size={11} strokeWidth={2.25} aria-hidden className="sel-bar__caret" />
      </button>
      {open && (
        <FloatingPortal>
          <div
            ref={(el) => {
              listRef.current = el
              refs.setFloating(el)
            }}
            className="ctx-menu ctx-menu--dropdown"
            role="menu"
            aria-label={action.label}
            style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
            onKeyDown={(e) => onMenuKeyDown(e, listRef.current, () => close(true))}
            onPointerDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
          >
            <MenuHostProvider value={host}>
              {(action.children ?? []).map((c) => (
                <ActionItem key={c.id} action={c} onRun={run} />
              ))}
            </MenuHostProvider>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
