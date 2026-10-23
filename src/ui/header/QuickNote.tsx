/**
 * Header "Quick note": jot something down without placing it. The note lands in the Unsorted
 * drawer of this board or of Home, to be sorted later. Also opened with Mod+Alt+N.
 */
import { useEffect, useId, useRef, useState } from 'react'
import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react'
import { NotebookPen } from 'lucide-react'
import { create } from 'zustand'
import type { BoardContextValue } from '../../board/BoardContext'
import { usePanels } from '../../board/store'
import { docs } from '../../collab/docs'
import { getUser } from '../../collab/identity'
import { addUnsortedNote } from '../../model/unsorted'
import { openBoard } from '../../app/router'
import { HOME_BOARD_ID } from '../../config'
import { isolateBoardEvents } from '../dialogs/Dialog'
import { toast } from '../toast'
import { MOD } from './hooks'

const MAX_NOTE = 20_000

type Target = 'board' | 'home'

/** Open state and the unsent draft (kept while the popover is closed, until saved). */
export const useQuickNote = create<{ open: boolean; draft: string }>(() => ({ open: false, draft: '' }))

export function openQuickNote() {
  useQuickNote.setState({ open: true })
}

export function QuickNote({ ctx }: { ctx: BoardContextValue }) {
  const open = useQuickNote((s) => s.open)
  const setOpen = (o: boolean) => useQuickNote.setState({ open: o })
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [
      offset(8),
      flip({ padding: 8 }),
      shift({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableWidth, elements }) {
          elements.floating.style.maxWidth = `${Math.max(240, Math.floor(availableWidth))}px`
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  })
  // Escape is handled inside the popover so it never reaches the board.
  const dismiss = useDismiss(context, { escapeKey: false })
  const role = useRole(context, { role: 'dialog' })
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role])

  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        className="icon-btn"
        aria-label="Quick note"
        title={`Quick note (${MOD}+Alt+N)`}
        aria-expanded={open}
        data-open={open || undefined}
        {...getReferenceProps({ onClick: () => setOpen(!open) })}
      >
        <NotebookPen size={18} aria-hidden />
      </button>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} returnFocus initialFocus={-1}>
            <div ref={refs.setFloating} className="quick-note" style={floatingStyles} {...getFloatingProps(isolateBoardEvents)}>
              <QuickNoteForm ctx={ctx} onClose={() => setOpen(false)} />
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  )
}

function QuickNoteForm({ ctx, onClose }: { ctx: BoardContextValue; onClose: () => void }) {
  const draft = useQuickNote((s) => s.draft)
  const boardAllowed = !ctx.isHome && !ctx.readOnly
  const [target, setTarget] = useState<Target>(boardAllowed ? 'board' : 'home')
  const [saving, setSaving] = useState(false)
  const textRef = useRef<HTMLTextAreaElement | null>(null)
  const id = useId()

  useEffect(() => {
    textRef.current?.focus({ preventScroll: true })
  }, [])

  const save = async () => {
    const text = draft.trim()
    if (!text || saving) return
    setSaving(true)
    const userId = getUser().id
    const onThisBoard = target === 'board' || ctx.isHome
    try {
      if (onThisBoard) {
        ctx.undo.stopCapturing()
        addUnsortedNote(ctx.doc, text, userId)
      } else {
        await docs.withDoc(HOME_BOARD_ID, (home) => addUnsortedNote(home, text, userId))
      }
    } catch (err) {
      console.warn('Quick note failed', err)
      toast('The note could not be saved.', 'error')
      setSaving(false)
      return
    }
    useQuickNote.setState({ draft: '' })
    setSaving(false)
    onClose()
    const here = onThisBoard
    toast(here || ctx.isHome ? 'Saved to Unsorted' : 'Saved to Unsorted on Home', 'success', 5000, {
      label: 'Show',
      run: () => {
        usePanels.getState().setPanel('unsorted')
        if (!here && !ctx.isHome) openBoard(HOME_BOARD_ID)
      },
    })
  }

  return (
    <form
      className="quick-note__form"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void save()
        }
      }}
    >
      <div className="quick-note__head">
        <h2 className="quick-note__title" id={`${id}-title`}>
          Quick note
        </h2>
        <span className="quick-note__hint">Lands in Unsorted</span>
      </div>
      <textarea
        ref={textRef}
        className="textarea quick-note__text"
        aria-label="Note text"
        placeholder="Type a thought, a link, a to-do…"
        rows={5}
        maxLength={MAX_NOTE}
        value={draft}
        onChange={(e) => useQuickNote.setState({ draft: e.target.value })}
      />
      {!ctx.isHome && (
        <div className="seg quick-note__target" role="radiogroup" aria-label="Save to">
          {(
            [
              { value: 'board', label: 'This board', disabled: !boardAllowed },
              { value: 'home', label: 'Home', disabled: false },
            ] as const
          ).map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={target === o.value}
              className="seg__opt"
              disabled={o.disabled}
              title={o.disabled ? 'This board is view only' : undefined}
              tabIndex={target === o.value ? 0 : -1}
              onClick={() => setTarget(o.value)}
              onKeyDown={(e) => {
                if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key) || !boardAllowed) return
                e.preventDefault()
                const next: Target = target === 'board' ? 'home' : 'board'
                setTarget(next)
                ;(e.currentTarget.parentElement?.querySelector(`[aria-checked="false"]`) as HTMLElement | null)?.focus()
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
      <div className="quick-note__actions">
        <span className="quick-note__keys">
          <kbd className="kbd">{MOD}</kbd>
          <kbd className="kbd">Enter</kbd> to save
        </span>
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn--primary" disabled={!draft.trim() || saving}>
          Save
        </button>
      </div>
    </form>
  )
}
