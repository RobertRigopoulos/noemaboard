/**
 * Nested menus for the context menu and the toolbar dropdowns. A submenu opens after a short hover,
 * or with ArrowRight / Enter / Space (focusing its first item), and closes with ArrowLeft or Escape
 * (focus returns to its trigger) or when another item of the parent menu is hovered. On narrow
 * windows it expands inline, like an accordion, instead of flying out.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { autoUpdate, flip, FloatingPortal, offset, shift, size, useFloating } from '@floating-ui/react'
import { ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react'
import { focusFirstItem, onMenuKeyDown } from './menuKeys'

const HOVER_OPEN_MS = 120
const HOVER_CLOSE_MS = 160
/** Below this window width submenus expand inline. */
export const INLINE_SUBMENU_MAX = 519

export interface MenuHost {
  /** Id of the open submenu at this level. */
  open: string | null
  setOpen: (id: string | null) => void
  /** Pointer entered an item: a submenu trigger (its id) or a plain item (null). */
  hover: (id: string | null) => void
  /** The pointer reached an open submenu: keep it open. */
  holdOpen: () => void
  inline: boolean
  /** Closes the whole menu (after an item ran). */
  closeAll: () => void
}

const HostContext = createContext<MenuHost | null>(null)

export function useMenuHost(): MenuHost | null {
  return useContext(HostContext)
}

function narrowQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(`(max-width: ${INLINE_SUBMENU_MAX}px)`) : null
}

/** True on windows too narrow for fly-out submenus. */
export function useNarrowMenus(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const q = narrowQuery()
      q?.addEventListener('change', cb)
      return () => q?.removeEventListener('change', cb)
    },
    () => narrowQuery()?.matches ?? false,
  )
}

/** State for one menu level; wrap that level's items in <MenuHostProvider value={host}>. */
export function useMenuHostState(closeAll: () => void, inline: boolean): MenuHost {
  const [open, setOpenState] = useState<string | null>(null)
  const openRef = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => clear, [])
  const setOpen = useCallback((id: string | null) => {
    clear()
    openRef.current = id
    setOpenState(id)
  }, [])
  const hover = useCallback(
    (id: string | null) => {
      clear()
      // Inline sections stay as the user left them; only fly-outs follow the pointer.
      if (inline || id === openRef.current) return
      timer.current = setTimeout(() => setOpen(id), id ? HOVER_OPEN_MS : HOVER_CLOSE_MS)
    },
    [inline, setOpen],
  )
  return useMemo(() => ({ open, setOpen, hover, holdOpen: clear, inline, closeAll }), [open, setOpen, hover, inline, closeAll])
}

export function MenuHostProvider({ value, children }: { value: MenuHost; children: ReactNode }) {
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>
}

interface SubmenuProps {
  icon: LucideIcon
  label: string
  disabled?: boolean
  /** The child items (rendered inside the submenu's own host). */
  children: ReactNode
  /** Extra attributes for the trigger (e.g. data-row). */
  triggerProps?: Record<string, string>
}

export function Submenu({ icon: Icon, label, disabled, children, triggerProps }: SubmenuProps) {
  const parent = useMenuHost()
  const id = useId()
  const inline = parent?.inline ?? false
  const open = parent?.open === id
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const focusOnOpen = useRef(false)
  const closeAll = parent?.closeAll ?? (() => {})
  const host = useMenuHostState(closeAll, inline)

  const { refs, floatingStyles, isPositioned } = useFloating({
    open: open && !inline,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [
      offset({ mainAxis: 2, alignmentAxis: -4 }),
      flip({ fallbackPlacements: ['left-start', 'right-end', 'left-end'], padding: 8 }),
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

  // Keyboard opening focuses the first child once it can take focus (placed, or rendered inline).
  useEffect(() => {
    if (!open || !focusOnOpen.current) return
    if (!inline && !isPositioned) return
    focusOnOpen.current = false
    focusFirstItem(listRef.current)
  }, [open, inline, isPositioned])

  const openByKey = () => {
    focusOnOpen.current = true
    parent?.setOpen(id)
  }
  const closeToTrigger = () => {
    parent?.setOpen(null)
    triggerRef.current?.focus({ preventScroll: true })
  }

  const onTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return
    if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      if (open && !inline) focusFirstItem(listRef.current)
      else openByKey()
    } else if (e.key === 'ArrowLeft' && inline && open) {
      e.preventDefault()
      e.stopPropagation()
      parent?.setOpen(null)
    }
  }

  const onListKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeToTrigger()
      return
    }
    if (inline) return // the parent menu's roving focus covers inline items
    onMenuKeyDown(e, listRef.current, closeAll)
    e.stopPropagation()
  }

  const Chevron = inline ? ChevronDown : ChevronRight
  const trigger = (
    <button
      ref={(el) => {
        triggerRef.current = el
        refs.setReference(el)
      }}
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={open}
      className={`ctx-menu__item ctx-menu__item--sub${open ? ' is-open' : ''}`}
      disabled={disabled}
      data-mi=""
      {...triggerProps}
      onPointerEnter={() => parent?.hover(id)}
      onClick={() => {
        if (open && inline) parent?.setOpen(null)
        else parent?.setOpen(id)
      }}
      onKeyDown={onTriggerKeyDown}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden className="ctx-menu__icon" />
      <span className="ctx-menu__text">{label}</span>
      <Chevron size={14} strokeWidth={2} aria-hidden className={`ctx-menu__chevron${inline && open ? ' is-open' : ''}`} />
    </button>
  )

  if (inline) {
    return (
      <>
        {trigger}
        {open && (
          <div ref={listRef} className="ctx-menu__inline" role="group" aria-label={label} onKeyDown={onListKeyDown}>
            <MenuHostProvider value={host}>{children}</MenuHostProvider>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      {trigger}
      {open && (
        <FloatingPortal>
          <div
            ref={(el) => {
              listRef.current = el
              refs.setFloating(el)
            }}
            className="ctx-menu ctx-menu--sub"
            role="menu"
            aria-label={label}
            data-submenu=""
            style={{ ...floatingStyles, visibility: isPositioned ? 'visible' : 'hidden' }}
            onPointerEnter={() => parent?.holdOpen()}
            onKeyDown={onListKeyDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <MenuHostProvider value={host}>{children}</MenuHostProvider>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
