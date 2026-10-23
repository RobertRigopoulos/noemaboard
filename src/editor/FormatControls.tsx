/**
 * Formatting controls shared by the selection bubble (FormatMenu) and the docked text toolbar
 * (TextToolbar): text style, inline marks, colours, link, lists and centre alignment.
 *
 * The controls form a role="toolbar" with one tab stop: arrow keys, Home and End move between them
 * (disabled ones are skipped). The style and colour dropdowns are menus of menuitemradio items that
 * open with Enter or Space, and with ArrowDown in a horizontal toolbar (in a vertical one the arrows
 * move between controls). Escape closes an open menu, then returns to the text. Mouse presses never
 * take focus away from the text, so the selection being formatted stays visible.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { useEditorState, type Editor } from '@tiptap/react'
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions, type Placement } from '@floating-ui/react'
import {
  Baseline,
  Bold,
  Check,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  SquareCode,
  Strikethrough,
  TextAlignCenter,
  TextQuote,
  Underline,
  type LucideIcon,
} from 'lucide-react'
import { HIGHLIGHT_COLORS, TEXT_COLORS } from './palette'
import { registerEditorEscape } from './activeEditor'
import { focusRovingGroup, focusRovingItem, moveRovingFocus, ROVING_ITEM, rovingItems } from './toolbarFocus'

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)
export const MOD = IS_MAC ? '⌘' : 'Ctrl+'
export const SHIFT = IS_MAC ? '⇧' : 'Shift+'
const ALT = IS_MAC ? '⌥' : 'Alt+'

export type StyleId = 'h1' | 'h2' | 'h3' | 'p' | 'code' | 'quote'

const STYLES: { id: StyleId; label: string; icon: LucideIcon; shortcut?: string }[] = [
  { id: 'h1', label: 'Large heading', icon: Heading1, shortcut: `${MOD}${ALT}1` },
  { id: 'h2', label: 'Heading', icon: Heading2, shortcut: `${MOD}${ALT}2` },
  { id: 'h3', label: 'Small heading', icon: Heading3, shortcut: `${MOD}${ALT}3` },
  { id: 'p', label: 'Normal', icon: Pilcrow, shortcut: `${MOD}${ALT}0` },
  { id: 'code', label: 'Code', icon: SquareCode, shortcut: `${MOD}${ALT}C` },
  { id: 'quote', label: 'Quote', icon: TextQuote, shortcut: `${MOD}${SHIFT}B` },
]
const STYLE_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s])) as Record<StyleId, (typeof STYLES)[number]>

function currentStyle(editor: Editor): StyleId {
  if (editor.isActive('codeBlock')) return 'code'
  if (editor.isActive('heading', { level: 1 })) return 'h1'
  if (editor.isActive('heading', { level: 2 })) return 'h2'
  if (editor.isActive('heading', { level: 3 })) return 'h3'
  if (editor.isActive('blockquote')) return 'quote'
  return 'p'
}

/**
 * A command chain for a toolbar action. When the text has focus it keeps it; when a keyboard user
 * is in the toolbar the action applies to the (kept) selection without pulling focus back.
 */
function chainFor(editor: Editor) {
  return editor.view.hasFocus() ? editor.chain().focus() : editor.chain()
}

function applyStyle(editor: Editor, id: StyleId) {
  const chain = chainFor(editor)
  switch (id) {
    case 'h1':
    case 'h2':
    case 'h3':
      chain.setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run()
      break
    case 'p':
      if (editor.isActive('blockquote')) chain.lift('blockquote').setParagraph().run()
      else chain.setParagraph().run()
      break
    case 'code':
      chain.toggleCodeBlock().run()
      break
    case 'quote':
      chain.toggleBlockquote().run()
      break
  }
}

/** Keeps the editor focused (and its selection) when pressing toolbar buttons. */
export const keepFocus = (e: ReactMouseEvent) => {
  if (!(e.target as HTMLElement).closest('input')) e.preventDefault()
}

export type FormatPopover = 'style' | 'color' | null

export interface FormatControlsProps {
  editor: Editor
  orientation: 'horizontal' | 'vertical'
  /** Inline formatting only (captions): no text style, lists or alignment. */
  compact?: boolean
  /** Link button pressed (the element is the button, for anchoring a link field). */
  onLink: (button: HTMLElement) => void
  /** The open dropdown; controlled so Escape in the text can close it. */
  popover: FormatPopover
  setPopover: (p: FormatPopover) => void
  /** Escape on a control while no dropdown is open: back to the text. */
  onEscape: () => void
  label?: string
  /** Marks a docked toolbar (rail, document bar), the target of Alt+F10 when no bubble shows. */
  docked?: boolean
  /** Items per row in a vertical toolbar laid out as a grid. */
  columns?: number
  className?: string
}

interface ButtonItem {
  kind: 'button'
  key: string
  label: string
  shortcut?: string
  icon: LucideIcon
  active?: boolean
  disabled?: boolean
  run: (button: HTMLElement) => void
}
type Item = ButtonItem | { kind: 'style' } | { kind: 'color'; disabled: boolean } | { kind: 'sep'; key: string }

export function FormatControls({
  editor,
  orientation,
  compact = false,
  onLink,
  popover,
  setPopover,
  onEscape,
  label = 'Text formatting',
  docked = false,
  columns,
  className,
}: FormatControlsProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [stop, setStop] = useState(0)
  const vertical = orientation === 'vertical'

  const s = useEditorState({
    editor,
    selector: ({ editor: ed }) => ({
      style: currentStyle(ed),
      bold: ed.isActive('bold'),
      italic: ed.isActive('italic'),
      underline: ed.isActive('underline'),
      strike: ed.isActive('strike'),
      code: ed.isActive('code'),
      highlight: ed.isActive('highlight'),
      link: ed.isActive('link'),
      bullet: ed.isActive('bulletList'),
      ordered: ed.isActive('orderedList'),
      task: ed.isActive('taskList'),
      center: ed.isActive({ textAlign: 'center' }),
      inCodeBlock: ed.isActive('codeBlock'),
      color: (ed.getAttributes('textStyle').color as string | undefined) ?? null,
      highlightColor: (ed.getAttributes('highlight').color as string | undefined) ?? null,
    }),
  })

  const run = (fn: () => void) => () => {
    setPopover(null)
    fn()
  }
  const mark = (key: string, label: string, shortcut: string, icon: LucideIcon, active: boolean, fn: () => void): ButtonItem => ({
    kind: 'button',
    key,
    label,
    shortcut,
    icon,
    active,
    disabled: s.inCodeBlock,
    run: run(fn),
  })

  const items: Item[] = []
  if (!compact) items.push({ kind: 'style' }, { kind: 'sep', key: 'sep-style' })
  items.push(
    mark('bold', 'Bold', `${MOD}B`, Bold, s.bold, () => chainFor(editor).toggleBold().run()),
    mark('italic', 'Italic', `${MOD}I`, Italic, s.italic, () => chainFor(editor).toggleItalic().run()),
    mark('underline', 'Underline', `${MOD}U`, Underline, s.underline, () => chainFor(editor).toggleUnderline().run()),
    mark('strike', 'Strikethrough', `${MOD}${SHIFT}X`, Strikethrough, s.strike, () => chainFor(editor).toggleStrike().run()),
    mark('highlight', 'Highlight', `${MOD}${SHIFT}H`, Highlighter, s.highlight, () => chainFor(editor).toggleHighlight().run()),
    { kind: 'color', disabled: s.inCodeBlock },
    mark('code', 'Inline code', `${MOD}E`, Code, s.code, () => chainFor(editor).toggleCode().run()),
    {
      kind: 'button',
      key: 'link',
      label: s.link ? 'Edit link' : 'Add link',
      shortcut: `${MOD}K`,
      icon: Link2,
      active: s.link,
      disabled: s.inCodeBlock,
      run: (button) => {
        setPopover(null)
        onLink(button)
      },
    },
  )
  if (!compact) {
    items.push(
      { kind: 'sep', key: 'sep-lists' },
      { kind: 'button', key: 'bullet', label: 'Bulleted list', shortcut: `${MOD}${SHIFT}8`, icon: List, active: s.bullet, run: run(() => chainFor(editor).toggleBulletList().run()) },
      { kind: 'button', key: 'ordered', label: 'Numbered list', shortcut: `${MOD}${SHIFT}7`, icon: ListOrdered, active: s.ordered, run: run(() => chainFor(editor).toggleOrderedList().run()) },
      { kind: 'button', key: 'task', label: 'Checklist', shortcut: `${MOD}${SHIFT}9`, icon: ListChecks, active: s.task, run: run(() => chainFor(editor).toggleTaskList().run()) },
      {
        kind: 'button',
        key: 'center',
        label: 'Align center',
        shortcut: `${MOD}${SHIFT}E`,
        icon: TextAlignCenter,
        active: s.center,
        run: run(() => (s.center ? chainFor(editor).unsetTextAlign().run() : chainFor(editor).setTextAlign('center').run())),
      },
    )
  }

  // Tab stop: the last focused control, or the first enabled one when that is disabled now.
  const focusable = items.filter((it) => it.kind !== 'sep')
  const disabledAt = focusable.map((it) => (it.kind === 'button' ? !!it.disabled : it.kind === 'color' ? it.disabled : false))
  const tabStop = disabledAt[stop] === false ? stop : Math.max(0, disabledAt.indexOf(false))

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.closest('[role="menu"]') || e.nativeEvent.isComposing) return
    const root = rootRef.current
    if (!root) return
    // Keys pressed on a control are never board shortcuts: Delete would delete the card being
    // edited, letters would add cards, Enter would start editing.
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      onEscape()
      return
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return
    if (!vertical && e.key === 'ArrowDown' && target.getAttribute('aria-haspopup') === 'menu') return
    if (moveRovingFocus(root, e.key, vertical && columns ? { columns } : undefined)) e.preventDefault()
  }

  const onFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    const root = rootRef.current
    if (!root) return
    const i = rovingItems(root).indexOf(e.target as HTMLElement)
    if (i >= 0 && i !== stop) setStop(i)
  }

  let index = 0
  const placement: Placement = vertical ? 'right-start' : 'bottom-start'
  const cls = ['rt-controls', `rt-controls--${orientation}`, className].filter(Boolean).join(' ')

  return (
    <div
      ref={rootRef}
      className={cls}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      {...(docked ? { 'data-rt-docked': '' } : {})}
      style={vertical && columns ? { gridTemplateColumns: `repeat(${columns}, auto)` } : undefined}
      onMouseDown={keepFocus}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {items.map((it) => {
        if (it.kind === 'sep') return <span key={it.key} className="rt-menu__sep" aria-hidden />
        const i = index++
        const tabIndex = i === tabStop ? 0 : -1
        if (it.kind === 'style') {
          return (
            <StylePicker
              key="style"
              editor={editor}
              current={s.style}
              compactTrigger={vertical}
              placement={placement}
              tabIndex={tabIndex}
              open={popover === 'style'}
              setOpen={(o) => setPopover(o ? 'style' : null)}
            />
          )
        }
        if (it.kind === 'color') {
          return (
            <ColorPicker
              key="color"
              editor={editor}
              textColor={s.color}
              highlightColor={s.highlight ? (s.highlightColor ?? HIGHLIGHT_COLORS[0].value) : null}
              disabled={it.disabled}
              placement={placement}
              tabIndex={tabIndex}
              open={popover === 'color'}
              setOpen={(o) => setPopover(o ? 'color' : null)}
            />
          )
        }
        const Icon = it.icon
        return (
          <ToolButton key={it.key} label={it.label} shortcut={it.shortcut} active={it.active} disabled={it.disabled} tabIndex={tabIndex} onClick={it.run}>
            <Icon size={15} strokeWidth={it.key === 'bold' ? 2.4 : 2} aria-hidden />
          </ToolButton>
        )
      })}
    </div>
  )
}

/** Focuses the first enabled control of a toolbar element (Alt+F10 on the bubble). */
export function focusFirstControl(root: Element | null): boolean {
  const bar = root?.matches('[role="toolbar"]') ? root : root?.querySelector('[role="toolbar"]')
  return !!bar && focusRovingGroup(bar, 'first')
}

// ---------------------------------------------------------------------------

function ToolButton({
  label,
  shortcut,
  active,
  disabled,
  tabIndex,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  active?: boolean
  disabled?: boolean
  tabIndex: number
  onClick: (button: HTMLElement) => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="rt-btn"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={active ? 'true' : 'false'}
      disabled={disabled}
      tabIndex={tabIndex}
      {...{ [ROVING_ITEM]: '' }}
      onClick={(e) => onClick(e.currentTarget)}
    >
      {children}
    </button>
  )
}

interface MenuState {
  open: boolean
  setOpen: (open: boolean) => void
  placement: Placement
}

/**
 * A dropdown menu next to its trigger, in a portal so it is never clipped by the rail or scaled by
 * the canvas. Opened from the keyboard it takes focus (the checked item); opened with the mouse it
 * leaves focus in the text.
 */
function useMenu({ open, setOpen, placement }: MenuState) {
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const byKeyboard = useRef(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    strategy: 'fixed',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const dismiss = useDismiss(context, { escapeKey: false })
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss])

  // Opened with the mouse, focus stays in the text: Escape there closes the menu first.
  useEffect(() => {
    if (!open || byKeyboard.current) return
    return registerEditorEscape(() => setOpen(false))
  }, [open, setOpen])

  useLayoutEffect(() => {
    if (!open || !byKeyboard.current) return
    const menu = menuRef.current
    if (!menu) return
    const items = rovingItems(menu)
    const checked = items.find((el) => el.getAttribute('aria-checked') === 'true') ?? items.find((el) => !(el as HTMLButtonElement).disabled)
    if (checked) focusRovingItem(menu, checked)
  }, [open])

  const toggle = (keyboard: boolean) => {
    byKeyboard.current = keyboard && !open
    setOpen(!open)
  }

  /** Closes the menu; a keyboard user goes back to the trigger. */
  const close = () => {
    const refocus = byKeyboard.current || !!menuRef.current?.contains(document.activeElement)
    byKeyboard.current = false
    setOpen(false)
    if (refocus) triggerRef.current?.focus({ preventScroll: true })
  }

  const triggerProps = () =>
    getReferenceProps({
      ref: (el: HTMLButtonElement | null) => {
        triggerRef.current = el
        refs.setReference(el)
      },
      // Keyboard-initiated clicks (Enter, Space) have no pointer position.
      onClick: (e: ReactMouseEvent) => toggle(e.detail === 0),
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (e.key === 'ArrowDown' && (e.currentTarget.closest('[aria-orientation="horizontal"]') || open)) {
          e.preventDefault()
          e.stopPropagation()
          byKeyboard.current = true
          if (!open) setOpen(true)
          else if (menuRef.current) focusRovingGroup(menuRef.current, 'first')
        }
      },
    })

  const menuKeyDown = (columns?: number) => (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    // Like the toolbar: keys in a menu are never board shortcuts.
    e.stopPropagation()
    if (!menu || e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      byKeyboard.current = false
      setOpen(false)
      return
    }
    if (moveRovingFocus(menu, e.key, columns ? { columns } : undefined)) e.preventDefault()
  }

  /** Runs a picked item: closes first, so focus is back on the trigger before the text changes. */
  const pick = (fn: () => void) => {
    close()
    fn()
  }

  const menuProps = (columns?: number) =>
    getFloatingProps({
      ref: (el: HTMLDivElement | null) => {
        menuRef.current = el
        refs.setFloating(el)
      },
      style: floatingStyles,
      role: 'menu',
      onKeyDown: menuKeyDown(columns),
      onMouseDown: keepFocus,
      onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
      onDoubleClick: (e: ReactMouseEvent) => e.stopPropagation(),
    })

  return { triggerProps, menuProps, pick }
}

function StylePicker({
  editor,
  current,
  compactTrigger,
  placement,
  tabIndex,
  open,
  setOpen,
}: {
  editor: Editor
  current: StyleId
  /** Icon-only trigger (vertical toolbar). */
  compactTrigger: boolean
  placement: Placement
  tabIndex: number
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const menu = useMenu({ open, setOpen, placement })
  const cur = STYLE_BY_ID[current]
  const CurIcon = cur.icon
  return (
    <>
      <button
        type="button"
        className={`rt-btn rt-btn--style${compactTrigger ? ' rt-btn--style-compact' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Text style: ${cur.label}`}
        title="Text style"
        tabIndex={tabIndex}
        {...{ [ROVING_ITEM]: '' }}
        {...menu.triggerProps()}
      >
        {compactTrigger ? <CurIcon size={15} aria-hidden /> : <span>{cur.label}</span>}
        <ChevronDown size={compactTrigger ? 10 : 13} aria-hidden />
      </button>
      {open && (
        <FloatingPortal>
          <div className="rt-pop rt-pop--styles" aria-label="Text style" {...menu.menuProps()}>
            {STYLES.map((st) => (
              <button
                key={st.id}
                type="button"
                role="menuitemradio"
                aria-checked={current === st.id}
                tabIndex={-1}
                {...{ [ROVING_ITEM]: '' }}
                className={`rt-pop__item rt-style rt-style--${st.id}`}
                title={st.shortcut ? `${st.label} (${st.shortcut})` : st.label}
                onClick={() => menu.pick(() => applyStyle(editor, st.id))}
              >
                <span className="rt-style__label">{st.label}</span>
                {current === st.id && <Check size={14} aria-hidden />}
              </button>
            ))}
          </div>
        </FloatingPortal>
      )}
    </>
  )
}

function ColorPicker({
  editor,
  textColor,
  highlightColor,
  disabled,
  placement,
  tabIndex,
  open,
  setOpen,
}: {
  editor: Editor
  textColor: string | null
  highlightColor: string | null
  disabled?: boolean
  placement: Placement
  tabIndex: number
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const menu = useMenu({ open, setOpen, placement })
  const setText = (value: string | null) => {
    if (value) chainFor(editor).setColor(value).run()
    else chainFor(editor).unsetColor().removeEmptyTextStyle().run()
  }
  const setHighlight = (value: string | null) => {
    if (value) chainFor(editor).setHighlight({ color: value }).run()
    else chainFor(editor).unsetHighlight().run()
  }
  const swatch = { tabIndex: -1, role: 'menuitemradio' as const, [ROVING_ITEM]: '' }
  return (
    <>
      <button
        type="button"
        className="rt-btn rt-btn--color"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Text color"
        title="Text color"
        disabled={disabled}
        tabIndex={tabIndex}
        {...{ [ROVING_ITEM]: '' }}
        {...menu.triggerProps()}
      >
        <Baseline size={15} aria-hidden />
        <span className="rt-btn__colorbar" style={{ background: textColor ?? 'currentColor' }} aria-hidden />
      </button>
      {open && (
        <FloatingPortal>
          <div className="rt-pop rt-pop--colors" aria-label="Text and highlight color" {...menu.menuProps(7)}>
            <div className="rt-pop__title" aria-hidden>
              Text
            </div>
            <div className="rt-swatches" role="group" aria-label="Text color">
              <button
                type="button"
                {...swatch}
                aria-checked={!textColor}
                className="rt-swatch rt-swatch--text"
                aria-label="Default text color"
                title="Default"
                onClick={() => menu.pick(() => setText(null))}
              >
                A
              </button>
              {TEXT_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  {...swatch}
                  aria-checked={textColor === c.value}
                  className="rt-swatch rt-swatch--text"
                  style={{ color: c.value }}
                  aria-label={`${c.name} text`}
                  title={c.name}
                  onClick={() => menu.pick(() => setText(c.value))}
                >
                  A
                </button>
              ))}
            </div>
            <div className="rt-pop__title" aria-hidden>
              Highlight
            </div>
            <div className="rt-swatches" role="group" aria-label="Highlight">
              <button
                type="button"
                {...swatch}
                aria-checked={!highlightColor}
                className="rt-swatch rt-swatch--none"
                aria-label="No highlight"
                title="None"
                onClick={() => menu.pick(() => setHighlight(null))}
              />
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  {...swatch}
                  aria-checked={highlightColor === c.value}
                  className="rt-swatch"
                  style={{ background: c.value }}
                  aria-label={`${c.name} highlight`}
                  title={c.name}
                  onClick={() => menu.pick(() => setHighlight(c.value))}
                />
              ))}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  )
}
