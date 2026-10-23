import { BoardIcon } from '../icons/BoardIcon'
import { isBoardIconId } from '../../model/boardIcons'
/** The board title in the header; click to rename (not on Home or read-only boards). */
import { useEffect, useRef, useState } from 'react'
import { APP_NAME } from '../../config'
import { useLibrary } from '../../collab/library'
import { updateMeta } from '../../model/board'
import type { BoardContextValue } from '../../board/BoardContext'
import { useBoardMeta } from './hooks'

export const MAX_TITLE = 120

/** Title shown for a board: Home, the synced meta title, or the cached library title while loading. */
export function useBoardTitle(ctx: BoardContextValue): string {
  const meta = useBoardMeta(ctx.doc)
  const cached = useLibrary((s) => s.entries[ctx.boardId]?.title)
  if (ctx.isHome) return 'Home'
  if (!meta.loaded) return cached || 'Untitled board'
  return meta.title.trim() || 'Untitled board'
}

export function BoardTitle({ ctx }: { ctx: BoardContextValue }) {
  const title = useBoardTitle(ctx)
  const meta = useBoardMeta(ctx.doc)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const canRename = !ctx.isHome && !ctx.readOnly

  useEffect(() => {
    document.title = ctx.isHome ? APP_NAME : `${title} – ${APP_NAME}`
  }, [title, ctx.isHome])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const start = () => {
    if (!canRename) return
    setValue(title)
    setEditing(true)
  }

  const commit = () => {
    if (!inputRef.current) return
    setEditing(false)
    const t = value.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE)
    if (!t || t === title) return
    updateMeta(ctx.doc, { title: t })
    // Only refresh a known board's entry: never create a keyless library entry from a rename.
    if (useLibrary.getState().entries[ctx.boardId]) useLibrary.getState().upsert({ id: ctx.boardId, title: t })
  }

  const icon = !ctx.isHome && isBoardIconId(meta.icon) ? meta.icon : null

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="board-title board-title--input"
        aria-label="Board name"
        value={value}
        maxLength={MAX_TITLE}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            // Detach first so the blur caused by unmounting cannot commit.
            inputRef.current = null
            setEditing(false)
          }
        }}
      />
    )
  }

  if (!canRename) {
    return (
      <h1 className="board-title" title={title}>
        {icon && <BoardIcon icon={icon} size={18} className="board-title__icon" />}
        <span className="board-title__text">{title}</span>
      </h1>
    )
  }

  return (
    <h1 className="board-title-wrap">
      <button type="button" className="board-title board-title--button" title="Rename board" aria-label={`${title}. Rename board`} onClick={start}>
        {icon && <BoardIcon icon={icon} size={18} className="board-title__icon" />}
        <span className="board-title__text">{title}</span>
      </button>
    </h1>
  )
}
