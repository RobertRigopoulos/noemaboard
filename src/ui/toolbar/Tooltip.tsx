/**
 * Small hover/focus tooltip with an optional keyboard hint, positioned with floating-ui.
 * Usage: const tip = useTooltip('Note', 'N', 'right'); <button ref={tip.ref} {...tip.props()} />{tip.node}
 */
import { useState, type HTMLProps, type ReactNode } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
  type Placement,
} from '@floating-ui/react'
import './toolbar.css'

export function useTooltip(label: string, hint?: string, placement: Placement = 'right', disabled = false) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open: open && !disabled,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const hover = useHover(context, { delay: { open: 350, close: 0 }, move: false })
  const focus = useFocus(context, { visibleOnly: true })
  const dismiss = useDismiss(context, { referencePress: true })
  const role = useRole(context, { role: 'tooltip' })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])

  const node: ReactNode =
    open && !disabled ? (
      <FloatingPortal>
        <div ref={refs.setFloating} className="noema-tooltip" style={floatingStyles} {...getFloatingProps()}>
          <span>{label}</span>
          {hint && <kbd className="noema-tooltip__kbd">{hint}</kbd>}
        </div>
      </FloatingPortal>
    ) : null

  return {
    ref: refs.setReference,
    props: (userProps?: HTMLProps<Element>) => getReferenceProps(userProps),
    close: () => setOpen(false),
    node,
  }
}
