/**
 * Template gallery (useDialogs 'templates'): picking a tile adds a new board made from that
 * template to the current board, near the middle of the view, and opens it.
 */
import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import type { BoardContextValue } from '../../board/BoardContext'
import { openBoard } from '../../app/router'
import { TEMPLATE_CHOICES, type BoardTemplate } from '../../templates/registry'
import { createBoardFromTemplate } from '../../templates/create'
import { useDialogs } from '../uiStore'
import { toast } from '../toast'
import { Dialog } from './Dialog'
import './templates-dialog.css'

export function TemplatesDialog({ ctx }: { ctx: BoardContextValue }) {
  const open = useDialogs((s) => s.dialog === 'templates')
  const close = useDialogs((s) => s.close)

  useEffect(() => {
    if (!open || !ctx.readOnly) return
    close()
    toast('This board is view only, so no boards can be added to it.')
  }, [open, ctx.readOnly, close])

  return (
    <Dialog
      open={open && !ctx.readOnly}
      onClose={close}
      size="lg"
      title="New board from a template"
      description="Pick a starting point. Everything on it can be changed afterwards."
    >
      <TemplateGallery ctx={ctx} onDone={close} />
    </Dialog>
  )
}

function TemplateGallery({ ctx, onDone }: { ctx: BoardContextValue; onDone: () => void }) {
  const id = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const busy = useRef(false)

  const choose = (t: BoardTemplate) => {
    // A double click must not create two boards.
    if (busy.current || ctx.readOnly) return
    busy.current = true
    let boardId: string
    try {
      ctx.undo.stopCapturing()
      boardId = createBoardFromTemplate(ctx.doc, t.id)
    } catch (err) {
      console.warn('Could not create a board from a template', err)
      busy.current = false
      toast('Could not create the board. Please try again.', 'error')
      return
    }
    onDone()
    openBoard(boardId)
  }

  // Arrow keys move through the grid like a gallery; Tab still moves through tiles one by one.
  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const tiles = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.tpl-tile') ?? [])
    const i = tiles.indexOf(document.activeElement as HTMLButtonElement)
    if (i < 0 || e.altKey || e.ctrlKey || e.metaKey) return
    const top = tiles[0].getBoundingClientRect().top
    const perRow = Math.max(1, tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length)
    let next: number
    switch (e.key) {
      case 'ArrowRight':
        next = i + 1
        break
      case 'ArrowLeft':
        next = i - 1
        break
      case 'ArrowDown':
        next = i + perRow
        break
      case 'ArrowUp':
        next = i - perRow
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = tiles.length - 1
        break
      default:
        return
    }
    e.preventDefault()
    tiles[Math.max(0, Math.min(tiles.length - 1, next))]?.focus()
  }

  return (
    <ul ref={listRef} className="tpl-grid" role="list" aria-label="Templates" onKeyDown={onKeyDown}>
      {TEMPLATE_CHOICES.map((t, i) => {
        const nameId = `${id}-${t.id}-name`
        const descId = `${id}-${t.id}-desc`
        const style = t.color ? ({ '--tpl-strong': `var(--c-${t.color})`, '--tpl-tint': `var(--c-${t.color}-tint)` } as CSSProperties) : undefined
        return (
          <li key={t.id} className="tpl-grid__item">
            <button
              type="button"
              className={`tpl-tile${t.color ? '' : ' tpl-tile--plain'}`}
              aria-labelledby={nameId}
              aria-describedby={descId}
              data-autofocus={i === 0 ? true : undefined}
              onClick={() => choose(t)}
            >
              <span className="tpl-tile__icon" style={style} aria-hidden>
                <t.icon size={22} strokeWidth={1.75} />
              </span>
              <span id={nameId} className="tpl-tile__name">
                {t.name}
              </span>
              <span id={descId} className="tpl-tile__desc">
                {t.description}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
