/** Menu rows shared by the context menu, its submenus and the selection toolbar dropdowns. */
import { Check, type LucideIcon } from 'lucide-react'
import { keysHint, type CardAction } from '../../cards/cardActions'
import { isMac } from './keys'
import { Submenu, useMenuHost } from './Submenu'

export function actionHint(a: Pick<CardAction, 'keys' | 'hint'>): string | undefined {
  return a.keys ? keysHint(a.keys, isMac) : a.hint
}

export interface ItemProps {
  icon: LucideIcon
  label: string
  hint?: string
  danger?: boolean
  disabled?: boolean
  /** A toggle: rendered as menuitemcheckbox with a check mark. */
  checked?: boolean
  title?: string
  onSelect: (anchor: DOMRect) => void
}

export function Item({ icon: Icon, label, hint, danger, disabled, checked, title, onSelect }: ItemProps) {
  const host = useMenuHost()
  const toggle = checked !== undefined
  return (
    <button
      type="button"
      role={toggle ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={toggle ? checked : undefined}
      className={`ctx-menu__item${danger ? ' ctx-menu__item--danger' : ''}`}
      disabled={disabled}
      title={title}
      data-mi=""
      onPointerEnter={() => host?.hover(null)}
      onClick={(e) => onSelect(e.currentTarget.getBoundingClientRect())}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden className="ctx-menu__icon" />
      <span className="ctx-menu__text">{label}</span>
      {hint && <kbd className="ctx-menu__hint">{hint}</kbd>}
      {toggle && <Check size={15} strokeWidth={2.25} aria-hidden className={`ctx-menu__check${checked ? '' : ' is-off'}`} />}
    </button>
  )
}

export function Sep() {
  return <div className="ctx-menu__sep" role="separator" />
}

/**
 * One card action: a submenu when it has children, else an item. `onRun` closes the menu and runs
 * the action (the anchor rect is measured before the item disappears).
 */
export function ActionItem({ action, onRun }: { action: CardAction; onRun: (a: CardAction, anchor: DOMRect | null) => void }) {
  if (action.children?.length) {
    return (
      <Submenu icon={action.icon} label={action.label} disabled={action.disabled}>
        {action.children.map((c) => (
          <ActionItem key={c.id} action={c} onRun={onRun} />
        ))}
      </Submenu>
    )
  }
  return (
    <Item
      icon={action.icon}
      label={action.label}
      hint={actionHint(action)}
      danger={action.danger}
      disabled={action.disabled || !action.run}
      checked={action.pressed}
      onSelect={(anchor) => onRun(action, anchor)}
    />
  )
}
