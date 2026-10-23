/**
 * Accessible dropdown menu (button + role="menu") built on @floating-ui/react:
 * arrow-key navigation, Escape / outside click to close, focus returns to the button.
 */
import { useRef, useState, type ReactNode } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListNavigation,
  useRole,
  type Placement,
} from '@floating-ui/react'
import { Check, type LucideIcon } from 'lucide-react'
import './menu.css'

export type MenuEntry =
  | {
      kind?: 'item'
      label: string
      icon?: LucideIcon | ReactNode
      onSelect: () => void
      disabled?: boolean
      /** Keyboard hint shown on the right. */
      shortcut?: string
      /** Radio-style item (shows a check when true). */
      checked?: boolean
      /** With `checked`: an on/off toggle (menuitemcheckbox) rather than one choice of a group. */
      toggle?: boolean
      danger?: boolean
      title?: string
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }

interface MenuProps {
  /** Accessible name of the trigger button. */
  label: string
  /** Visible trigger content. */
  children: ReactNode
  items: MenuEntry[]
  className?: string
  title?: string
  placement?: Placement
  disabled?: boolean
}

function isLucide(icon: unknown): icon is LucideIcon {
  return typeof icon === 'function' || (typeof icon === 'object' && icon !== null && '$$typeof' in icon && 'render' in icon)
}

export function Menu({ label, children, items, className = 'icon-btn', title, placement = 'bottom-end', disabled }: MenuProps) {
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const listRef = useRef<Array<HTMLElement | null>>([])

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(6),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.maxHeight = `${Math.max(160, availableHeight)}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })

  const actionable = items.filter((i) => !i.kind || i.kind === 'item') as Extract<MenuEntry, { label: string; onSelect: () => void }>[]
  const disabledIndices = actionable.flatMap((i, n) => (i.disabled ? [n] : []))

  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    useClick(context, { enabled: !disabled }),
    // Escape is handled below so it does not also reach the board's shortcuts.
    useDismiss(context, { escapeKey: false }),
    useRole(context, { role: 'menu' }),
    useListNavigation(context, { listRef, activeIndex, onNavigate: setActiveIndex, loop: true, disabledIndices }),
  ])

  let n = -1
  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className={className}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        data-open={open || undefined}
        {...getReferenceProps({
          onKeyDown: (e) => {
            // Keep Space/Enter/arrows on the button away from canvas shortcuts.
            if (e.key === ' ' || e.key === 'Enter' || e.key.startsWith('Arrow')) e.stopPropagation()
          },
        })}
      >
        {children}
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={0} returnFocus>
            <div
              ref={refs.setFloating}
              className="menu"
              style={floatingStyles}
              {...getFloatingProps({
                onKeyDown: (e) => {
                  e.stopPropagation()
                  if (e.key === 'Escape' || e.key === 'Tab') {
                    if (e.key === 'Escape') e.preventDefault()
                    setOpen(false)
                  }
                },
                onKeyUp: (e) => e.stopPropagation(),
              })}
            >
              {items.map((item, i) => {
                if (item.kind === 'separator') return <div key={`sep-${i}`} role="separator" className="menu__sep" />
                if (item.kind === 'label')
                  return (
                    <div key={`label-${i}`} className="menu__label" role="presentation">
                      {item.label}
                    </div>
                  )
                const index = ++n
                const Icon = item.icon
                const radio = item.checked !== undefined
                return (
                  <button
                    key={`${item.label}-${i}`}
                    type="button"
                    role={radio ? (item.toggle ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem'}
                    aria-checked={radio ? item.checked : undefined}
                    aria-disabled={item.disabled || undefined}
                    className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
                    title={item.title}
                    tabIndex={activeIndex === index ? 0 : -1}
                    {...getItemProps({
                      ref: (node: HTMLButtonElement | null) => {
                        listRef.current[index] = node
                      },
                      onClick: () => {
                        if (item.disabled) return
                        setOpen(false)
                        // Run after FloatingFocusManager has returned focus to the trigger (in a
                        // microtask), so a dialog opened by the action keeps focus and later returns it here.
                        setTimeout(item.onSelect, 0)
                      },
                    })}
                  >
                    <span className="menu__icon" aria-hidden>
                      {radio ? item.checked ? <Check size={15} /> : null : isLucide(Icon) ? <Icon size={15} /> : Icon}
                    </span>
                    <span className="menu__text">{item.label}</span>
                    {item.shortcut && <span className="menu__shortcut">{item.shortcut}</span>}
                  </button>
                )
              })}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}
