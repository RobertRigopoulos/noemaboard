/**
 * Formatting toolbar for the card being edited, outside the selection bubble, so formatting is
 * reachable without selecting text first (and by keyboard: Alt+F10, then the arrow keys).
 *
 * placement 'rail': a vertical "Text" group in the tool rail with a Done button. Below 640px wide it
 * becomes a horizontal bar docked to the bottom of the window instead.
 * placement 'bar': a horizontal toolbar in the document editor's top bar.
 *
 * Renders nothing without a live editor, on read-only boards and while presenting; the rail leaves
 * documents to their own bar.
 */
import { useContext, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { autoUpdate, flip, FloatingPortal, offset, shift, useDismiss, useFloating, useInteractions } from '@floating-ui/react'
import { Check } from 'lucide-react'
import type { Editor } from '@tiptap/core'
import { BoardContext } from '../board/BoardContext'
import { usePanels, useSelection } from '../board/store'
import { getCanvasElement } from '../board/geometry'
import { useActiveEditor } from './activeEditor'
import { FormatControls, keepFocus, type FormatPopover } from './FormatControls'
import { LinkForm, selectWordAtCursor } from './FormatMenu'
import { returnToText } from './toolbarFocus'
import './richtext.css'

export interface TextToolbarProps {
  placement: 'rail' | 'bar'
}

const NARROW = '(max-width: 639.98px)'

function subscribeNarrow(cb: () => void) {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {}
  const mq = window.matchMedia(NARROW)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

function isNarrow(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(NARROW).matches
}

export function TextToolbar({ placement }: TextToolbarProps) {
  const editor = useActiveEditor((s) => s.editor)
  const variant = useActiveEditor((s) => s.variant)
  const board = useContext(BoardContext)
  const presenting = usePanels((s) => s.presenting)
  const narrow = useSyncExternalStore(subscribeNarrow, isNarrow, () => false)

  if (!editor || editor.isDestroyed || !editor.isEditable || !variant) return null
  if (!board || board.readOnly || presenting) return null
  if (placement === 'rail' && variant === 'document') return null
  if (placement === 'bar' && variant !== 'document') return null

  if (placement === 'bar') return <DocBar editor={editor} />
  if (narrow) return createPortal(<DockedBar editor={editor} compact={variant === 'caption'} />, document.body)
  return <RailGroup editor={editor} compact={variant === 'caption'} />
}

/** Leaves edit mode from the toolbar and hands keyboard focus to the board. */
function done() {
  useSelection.getState().setEditing(null)
  const canvas = getCanvasElement()
  if (canvas) canvas.focus({ preventScroll: true })
  else (document.activeElement as HTMLElement | null)?.blur?.()
}

/** Link field in a popover next to the toolbar's link button. */
function useLinkPopover(editor: Editor) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  // Another card started editing: its text is not the one the field was for.
  useEffect(() => setAnchor(null), [editor])
  const open = (button: HTMLElement) => {
    if (editor.state.selection.empty) {
      if (editor.isActive('link')) editor.chain().extendMarkRange('link').run()
      else selectWordAtCursor(editor)
    }
    setAnchor(button)
  }
  const node = anchor ? (
    <LinkPopover
      editor={editor}
      anchor={anchor}
      onClose={() => {
        setAnchor(null)
      }}
    />
  ) : null
  return { open, node }
}

function LinkPopover({ editor, anchor, onClose }: { editor: Editor; anchor: HTMLElement; onClose: () => void }) {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (o) => {
      if (!o) onClose()
    },
    placement: anchor.closest('[aria-orientation="vertical"]') ? 'right-start' : 'bottom-start',
    strategy: 'fixed',
    elements: { reference: anchor },
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const dismiss = useDismiss(context, { escapeKey: false })
  const { getFloatingProps } = useInteractions([dismiss])
  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className="rt-pop rt-pop--link"
        role="dialog"
        aria-label="Link"
        {...getFloatingProps({
          onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
          onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
        })}
      >
        <LinkForm
          editor={editor}
          onDone={() => {
            onClose()
            returnToText(editor)
          }}
        />
      </div>
    </FloatingPortal>
  )
}

function useControls(editor: Editor) {
  const [popover, setPopover] = useState<FormatPopover>(null)
  const link = useLinkPopover(editor)
  // A different card started editing: drop menus that belonged to the previous one.
  const last = useRef(editor)
  useEffect(() => {
    if (last.current === editor) return
    last.current = editor
    setPopover(null)
  }, [editor])
  return {
    popover,
    setPopover,
    link,
    onEscape: () => {
      setPopover(null)
      returnToText(editor)
    },
  }
}

function RailGroup({ editor, compact }: { editor: Editor; compact: boolean }) {
  const c = useControls(editor)
  const titleId = useId()
  return (
    <div className="rt-rail" role="group" aria-labelledby={titleId} onMouseDown={keepFocus}>
      <div className="rt-rail__title" id={titleId}>
        Text
      </div>
      <FormatControls
        editor={editor}
        orientation="vertical"
        columns={2}
        compact={compact}
        docked
        label="Text formatting"
        onLink={c.link.open}
        popover={c.popover}
        setPopover={c.setPopover}
        onEscape={c.onEscape}
        className="rt-rail__controls"
      />
      <DoneButton className="rt-rail__done" />
      {c.link.node}
    </div>
  )
}

function DockedBar({ editor, compact }: { editor: Editor; compact: boolean }) {
  const c = useControls(editor)
  return (
    <div className="rt-dock" onMouseDown={keepFocus} onPointerDown={(e) => e.stopPropagation()}>
      <FormatControls
        editor={editor}
        orientation="horizontal"
        compact={compact}
        docked
        label="Text formatting"
        onLink={c.link.open}
        popover={c.popover}
        setPopover={c.setPopover}
        onEscape={c.onEscape}
        className="rt-dock__controls"
      />
      <DoneButton className="rt-dock__done" />
      {c.link.node}
    </div>
  )
}

function DocBar({ editor }: { editor: Editor }) {
  const c = useControls(editor)
  return (
    <div className="rt-docbar" onMouseDown={keepFocus}>
      <FormatControls
        editor={editor}
        orientation="horizontal"
        docked
        label="Document formatting"
        onLink={c.link.open}
        popover={c.popover}
        setPopover={c.setPopover}
        onEscape={c.onEscape}
        className="rt-docbar__controls"
      />
      {c.link.node}
    </div>
  )
}

function DoneButton({ className }: { className: string }) {
  return (
    <button
      type="button"
      className={`rt-done ${className}`}
      title="Done editing (Esc)"
      onKeyDown={(e) => {
        // Keys on this button are not board shortcuts (Delete would delete the card being edited).
        e.stopPropagation()
      }}
      onClick={done}
    >
      <Check size={15} aria-hidden />
      <span>Done</span>
    </button>
  )
}
