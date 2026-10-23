/**
 * Left tool rail: click a card type to add it at the view centre, or drag it onto the board or
 * into a column. Also the line tool, file import, draw, and the trash (a drop target that opens
 * the trash panel).
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { Ellipsis, Eye, ImagePlus, LayoutTemplate, PenLine, Trash2, Upload, type LucideIcon } from 'lucide-react'
import type { BoardContextValue } from '../../board/BoardContext'
import { addCard, viewCenter } from '../../board/actions'
import { useDrag, usePanels, useSelection } from '../../board/store'
import { CARD_DEFINITIONS } from '../../cards/registry'
import type { CardType } from '../../model/types'
import { useActiveEditor } from '../../editor/activeEditor'
import type { RichTextVariant } from '../../editor/extensions'
import { TextToolbar } from '../../editor/TextToolbar'
import { useTrashCount } from '../panels/useTrash'
import { importFilesAt } from './importBridge'
import { useTooltip } from './Tooltip'
import { keepControlKeys } from '../keyGuard'
import { useDialogs } from '../uiStore'
import { EDIT_ON_CREATE, useRailDrag } from './useRailDrag'
import './toolbar.css'

type RailDrag = ReturnType<typeof useRailDrag>

interface CardItem {
  type: CardType
  label: string
  hint?: string
}

const PRIMARY: CardItem[] = [
  { type: 'note', label: 'Note', hint: 'N' },
  { type: 'link', label: 'Link', hint: 'L' },
  { type: 'todo', label: 'To-do', hint: 'T' },
]
const SECONDARY: CardItem[] = [
  { type: 'board', label: 'Board', hint: 'B' },
  { type: 'column', label: 'Column', hint: 'C' },
  { type: 'comment', label: 'Comment', hint: 'M' },
]
const MORE: CardItem[] = [
  { type: 'document', label: 'Document' },
  { type: 'swatch', label: 'Color swatch' },
  { type: 'sketch', label: 'Sketch' },
]

const iconOf = (type: CardType): LucideIcon => CARD_DEFINITIONS[type].icon

/** Editors whose formatting toolbar takes over the rail (documents have their own bar). */
const RAIL_TEXT_VARIANTS: ReadonlySet<RichTextVariant | null> = new Set<RichTextVariant>(['note', 'todo', 'caption'])

export function Toolbar({ ctx }: { ctx: BoardContextValue }) {
  const presenting = usePanels((s) => s.presenting)
  const drag = useRailDrag(ctx)
  const textEditing = useActiveEditor((s) => !!s.editor && RAIL_TEXT_VARIANTS.has(s.variant))
  if (presenting) return null
  if (ctx.readOnly) {
    return (
      <nav className="rail rail--readonly" aria-label="Board tools">
        <div className="rail__badge" role="status" title="You can look around this board but not change it">
          <Eye size={20} strokeWidth={1.75} aria-hidden />
          <span>View only</span>
        </div>
      </nav>
    )
  }

  const add = (type: CardType) => {
    ctx.undo.stopCapturing()
    addCard(ctx.doc, type, {}, { edit: EDIT_ON_CREATE.has(type) })
  }

  return (
    // Space/Enter on rail buttons must add the card, not pan the canvas or edit the selected card.
    <nav className={`rail${textEditing ? ' rail--text' : ''}`} aria-label={textEditing ? 'Text formatting' : 'Board tools'} onKeyDown={keepControlKeys}>
      <div className="rail__scroll">
        {textEditing ? (
          // While a note, to-do or caption is edited the rail becomes its formatting toolbar.
          <TextToolbar placement="rail" />
        ) : (
          <>
            {PRIMARY.map((it) => (
              <CardTypeButton key={it.type} item={it} drag={drag} onAdd={add} />
            ))}
            <LineToolButton />
            {SECONDARY.map((it) => (
              <CardTypeButton key={it.type} item={it} drag={drag} onAdd={add} />
            ))}
            <MoreMenu drag={drag} onAdd={add} />
            <div className="rail__divider" role="separator" />
            <FileButton ctx={ctx} label="Add image" tooltip="Add images from your computer" icon={ImagePlus} accept="image/*" />
            <FileButton ctx={ctx} label="Upload" tooltip="Upload any files" icon={Upload} />
            <RailButton icon={PenLine} label="Draw" tooltip="Draw a sketch" onClick={() => add('sketch')} />
          </>
        )}
      </div>
      <div className="rail__spacer" />
      <TrashButton ctx={ctx} />
      {drag.ghostNode}
    </nav>
  )
}

function RailButton({
  icon: Icon,
  label,
  tooltip,
  hint,
  pressed,
  className,
  onClick,
  onPointerDown,
  extra,
  dataDrop,
}: {
  icon: LucideIcon
  label: string
  tooltip?: string
  hint?: string
  pressed?: boolean
  className?: string
  onClick: () => void
  onPointerDown?: (e: ReactPointerEvent<HTMLButtonElement>) => void
  extra?: React.ReactNode
  dataDrop?: string
}) {
  const tip = useTooltip(tooltip ?? label, hint)
  return (
    <>
      <button
        ref={tip.ref}
        type="button"
        className={`rail__item${className ? ` ${className}` : ''}`}
        aria-label={hint ? `${tooltip ?? label} (${hint})` : (tooltip ?? label)}
        aria-pressed={pressed}
        data-drop={dataDrop}
        {...tip.props({
          onClick,
          onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => {
            tip.close()
            onPointerDown?.(e)
          },
        } as React.HTMLProps<Element>)}
      >
        <Icon size={22} strokeWidth={1.6} aria-hidden />
        <span className="rail__label">{label}</span>
        {extra}
      </button>
      {tip.node}
    </>
  )
}

function CardTypeButton({ item, drag, onAdd }: { item: CardItem; drag: RailDrag; onAdd: (type: CardType) => void }) {
  return (
    <RailButton
      icon={iconOf(item.type)}
      label={item.label}
      tooltip={`Add ${item.label.toLowerCase()}`}
      hint={item.hint}
      onPointerDown={(e) => drag.onPointerDown(item.type, e)}
      onClick={() => {
        if (drag.consumeClick()) return
        onAdd(item.type)
      }}
    />
  )
}

function LineToolButton() {
  const active = useSelection((s) => s.tool === 'line')
  return (
    <RailButton
      icon={CARD_DEFINITIONS.line.icon}
      label="Line"
      tooltip={active ? 'Stop drawing lines' : 'Draw lines and arrows between cards'}
      hint={active ? 'Esc' : undefined}
      pressed={active}
      onClick={() => {
        const sel = useSelection.getState()
        sel.setTool(sel.tool === 'line' ? 'select' : 'line')
      }}
    />
  )
}

function MoreMenu({ drag, onAdd }: { drag: RailDrag; onAdd: (type: CardType) => void }) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'right-start',
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const click = useClick(context)
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'menu' })
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role])
  const tip = useTooltip('More card types', undefined, 'right', open)

  const onKeyDown = (e: ReactKeyboardEvent) => {
    const items = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    const i = items.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? i + 1 : i - 1
      items[(next + items.length) % items.length]?.focus()
    }
    // Keep single-letter board shortcuts from firing while the menu has focus.
    if (e.key !== 'Escape') e.stopPropagation()
  }

  return (
    <>
      <button
        ref={(el) => {
          refs.setReference(el)
          tip.ref(el)
        }}
        type="button"
        className="rail__item"
        aria-label="More card types"
        aria-expanded={open}
        {...getReferenceProps(tip.props() as React.HTMLProps<Element>)}
      >
        <Ellipsis size={22} strokeWidth={1.6} aria-hidden />
        <span className="rail__label">More</span>
      </button>
      {!open && tip.node}
      {open && (
        <FloatingPortal>
          <div
            ref={(el) => {
              listRef.current = el
              refs.setFloating(el)
            }}
            className="rail-more"
            style={floatingStyles}
            {...getFloatingProps({ onKeyDown })}
          >
            {MORE.map((it) => {
              const Icon = iconOf(it.type)
              return (
                <button
                  key={it.type}
                  type="button"
                  role="menuitem"
                  className="rail-more__item"
                  title="Click to add, or drag onto the board"
                  onPointerDown={(e) => drag.onPointerDown(it.type, e, () => setOpen(false))}
                  onClick={() => {
                    if (drag.consumeClick()) return
                    setOpen(false)
                    onAdd(it.type)
                  }}
                >
                  <Icon size={18} strokeWidth={1.6} aria-hidden />
                  <span>{it.label}</span>
                </button>
              )
            })}
            <div className="rail-more__sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="rail-more__item"
              onClick={() => {
                setOpen(false)
                // The menu item disappears with the menu: give focus back to "More" first, so the
                // dialog returns focus there when it closes.
                const more = refs.domReference.current as HTMLElement | null
                more?.focus({ preventScroll: true })
                useDialogs.getState().open('templates')
              }}
            >
              <LayoutTemplate size={18} strokeWidth={1.6} aria-hidden />
              <span>Board from template…</span>
            </button>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function FileButton({
  ctx,
  label,
  tooltip,
  icon,
  accept,
}: {
  ctx: BoardContextValue
  label: string
  tooltip: string
  icon: LucideIcon
  accept?: string
}) {
  const input = useRef<HTMLInputElement | null>(null)
  return (
    <>
      <RailButton icon={icon} label={label} tooltip={tooltip} onClick={() => input.current?.click()} />
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          // Reset so choosing the same file again still fires a change.
          e.currentTarget.value = ''
          const picked = accept === 'image/*' ? files.filter((f) => f.type.startsWith('image/')) : files
          if (picked.length) void importFilesAt(ctx.doc, picked, viewCenter())
        }}
      />
    </>
  )
}

function TrashButton({ ctx }: { ctx: BoardContextValue }) {
  const count = useTrashCount(ctx.doc)
  const panel = usePanels((s) => s.panel)
  const setPanel = usePanels((s) => s.setPanel)
  const targeted = useDrag((s) => s.drag?.target?.kind === 'trash')
  const cardsDragging = useDrag((s) => !!s.drag && s.drag.ids.length > 0 && s.drag.w === undefined)
  const open = panel === 'trash'
  const className = ['rail__trash', targeted && 'is-drop-target', cardsDragging && 'is-drop-ready'].filter(Boolean).join(' ')
  return (
    <RailButton
      icon={Trash2}
      label="Trash"
      tooltip={targeted ? 'Release to delete' : open ? 'Close trash' : 'Trash · drop cards here to delete'}
      pressed={open}
      className={className}
      dataDrop="trash"
      onClick={() => setPanel(open ? null : 'trash')}
      extra={
        count > 0 ? (
          <span className="rail__badge-count" aria-label={`${count} in trash`}>
            {count > 99 ? '99+' : count}
          </span>
        ) : null
      }
    />
  )
}
