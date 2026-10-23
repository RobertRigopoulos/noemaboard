/**
 * Board card: a folder-like tile linking to a nested board. Double-click opens it; edit mode
 * (Enter / second click) renames it and offers a cover, icon and colour picker. The tile shows the
 * number of cards on the board: live while that board is loaded here, else the count cached on the
 * card by whoever had it open last.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FocusEvent, type MouseEvent } from 'react'
import { Users } from 'lucide-react'
import type * as Y from 'yjs'
import type { CardProps } from '../types'
import type { BoardCard as BoardData, CardColor } from '../../model/types'
import { getCardMap, getCards, getMeta, isTrashed, SYSTEM_ORIGIN, updateCard } from '../../model/board'
import { isValidId } from '../../model/ids'
import { useBoard } from '../../board/BoardContext'
import { addCardBelow } from '../../board/actions'
import { getCanvasElement, getCardElement } from '../../board/geometry'
import { useSelection } from '../../board/store'
import { docs } from '../../collab/docs'
import { useLibrary } from '../../collab/library'
import { putBlob, useBlobUrl } from '../../collab/blobs'
import { getUser } from '../../collab/identity'
import { openBoard } from '../../app/router'
import { BoardIcon } from '../../ui/icons/BoardIcon'
import { toast } from '../../ui/toast'
import { processImageFile } from '../media/image'
import { BOARD_TITLE_MAX, cardCountLabel, countFreeCards, displayBoardTitle, isBoardDocReady, readChildCount, sanitizeIcon } from './helpers'
import { isCardColor, readCover, syncAppearanceOnUndo, updateBoardAppearance, type BoardAppearance } from './boardAppearance'
import { BoardAppearancePopover } from './BoardAppearancePopover'
import { TitleInput } from './TitleInput'
import './board-card.css'

/** A double-click whose first click put the card in edit mode still opens the board. */
const OPEN_GRACE_MS = 600
/** The cached count is written at most this often while the child board changes. */
const COUNT_WRITE_DELAY_MS = 2000

/** Number of free cards on the child board while its doc happens to be loaded, else null. */
function useChildBoardCount(boardId: string | null): number | null {
  const [count, setCount] = useState<number | null>(() => {
    const d = boardId ? docs.peek(boardId) : undefined
    return d && isBoardDocReady(d) ? countFreeCards(d) : null
  })

  useEffect(() => {
    if (!boardId) {
      setCount(null)
      return
    }
    let detach: (() => void) | null = null
    const attach = (doc: Y.Doc) => {
      detach?.()
      const cards = getCards(doc)
      const meta = getMeta(doc)
      let timer: ReturnType<typeof setTimeout> | null = null
      const recount = () => setCount(isBoardDocReady(doc) ? countFreeCards(doc) : null)
      // Typing inside the child board fires deep events; recount at most a few times a second.
      const schedule = () => {
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          recount()
        }, 250)
      }
      cards.observeDeep(schedule)
      meta.observe(schedule)
      recount()
      detach = () => {
        cards.unobserveDeep(schedule)
        meta.unobserve(schedule)
        if (timer) clearTimeout(timer)
      }
    }
    const loaded = docs.peek(boardId)
    if (loaded) attach(loaded)
    else setCount(null)
    const offLoad = docs.onLoad((loadedId, doc) => {
      if (loadedId === boardId) attach(doc)
    })
    const offUnload = docs.onUnload((unloadedId) => {
      if (unloadedId !== boardId) return
      detach?.()
      detach = null
      setCount(null)
    })
    return () => {
      offLoad()
      offUnload()
      detach?.()
    }
  }, [boardId])

  return count
}

/**
 * Keeps the card's cached count in step with a live count. Derived data, written as a system change
 * (never undone), debounced, and only when it differs.
 */
function useCacheChildCount(doc: Y.Doc, cardId: string, live: number | null, stored: number | null, readOnly: boolean) {
  useEffect(() => {
    if (readOnly || live === null || live === stored) return
    const t = setTimeout(() => {
      const m = getCardMap(doc, cardId)
      if (!m || isTrashed(m) || readChildCount(m.get('childCount')) === live) return
      updateCard(doc, cardId, { childCount: live }, getUser().id, SYSTEM_ORIGIN)
    }, COUNT_WRITE_DELAY_MS)
    return () => clearTimeout(t)
  }, [doc, cardId, live, stored, readOnly])
}

export function BoardCard({ id, card, editing, inColumn, readOnly, stopEditing }: CardProps<BoardData>) {
  const board = useBoard()
  const { doc } = board
  const boardId = typeof card.boardId === 'string' && isValidId(card.boardId) ? card.boardId : null
  const libTitle = useLibrary((s) => (boardId ? s.entries[boardId]?.title : undefined))
  const shared = useLibrary((s) => (boardId ? s.entries[boardId]?.shared === true : false))
  const live = useChildBoardCount(boardId)
  const stored = readChildCount(card.childCount)
  useCacheChildCount(doc, id, live, stored, readOnly)
  const count = live ?? stored
  // Undoing a rename / icon / colour / cover change (made here or from a menu) also reverts the
  // library entry and the child board's meta.
  useEffect(() => {
    if (!readOnly) syncAppearanceOnUndo(doc)
  }, [doc, readOnly])

  const title = displayBoardTitle(libTitle, card.title)
  const icon = sanitizeIcon(card.icon)
  const color: CardColor | null = isCardColor(card.color) ? card.color : null
  const cover = readCover(card.cover)
  const coverImage = useBlobUrl(cover, board.boardId)
  const isEditing = editing && !readOnly

  const rootRef = useRef<HTMLDivElement>(null)
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null)
  const setRoot = useCallback((el: HTMLDivElement | null) => {
    rootRef.current = el
    setAnchor(el)
  }, [])
  const popoverRef = useRef<HTMLElement | null>(null)
  const setPopover = useCallback((el: HTMLElement | null) => {
    popoverRef.current = el
  }, [])
  const editStartedAt = useRef(0)
  useLayoutEffect(() => {
    if (isEditing) editStartedAt.current = performance.now()
  }, [isEditing])

  const fileRef = useRef<HTMLInputElement | null>(null)
  // While the system file picker is open the window loses focus; that is not "done editing".
  const choosingFile = useRef(false)
  const [coverBusy, setCoverBusy] = useState(false)
  // React does not listen for 'cancel' on inputs: closing the picker without a file ends the choice.
  // The listener goes away with the element (the ref callback is stable, so each element gets one).
  const setFileInput = useCallback((el: HTMLInputElement | null) => {
    fileRef.current = el
    el?.addEventListener('cancel', () => {
      choosingFile.current = false
    })
  }, [])

  const open = () => {
    if (!boardId) {
      toast('This board link is damaged and cannot be opened.', 'error')
      return
    }
    stopEditing()
    openBoard(boardId)
  }

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    // Handled here so the shell does not treat the double-click as "start editing".
    e.stopPropagation()
    const target = e.target as HTMLElement
    if (popoverRef.current?.contains(target)) return
    // While renaming, double-clicking the field selects a word. The exception is the double-click
    // whose first click is what started edit mode a moment ago.
    if (isEditing && target.closest('input') && performance.now() - editStartedAt.current > OPEN_GRACE_MS) return
    open()
  }

  const apply = (patch: BoardAppearance) => {
    void updateBoardAppearance(doc, id, boardId, patch)
  }

  /** A pick from the popover is an undo step of its own (typing in the title merges as usual). */
  const pick = (patch: BoardAppearance) => {
    board.undo.stopCapturing()
    apply(patch)
    board.undo.stopCapturing()
  }

  const chooseCoverFile = () => {
    choosingFile.current = true
    // Focus comes back to the page after the picker closes, with or without a file.
    const onFocus = () => setTimeout(() => (choosingFile.current = false), 500)
    window.addEventListener('focus', onFocus, { once: true })
    fileRef.current?.click()
  }

  const onCoverFile = async (e: ChangeEvent<HTMLInputElement>) => {
    choosingFile.current = false
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || readOnly) return
    setCoverBusy(true)
    try {
      const image = await processImageFile(file, file.name)
      if (!image) {
        toast('This image could not be read. Try a PNG, JPEG, GIF or WebP file.', 'error')
        return
      }
      const { hash } = await putBlob(image.thumb ?? image.blob, board.boardId)
      if (doc.isDestroyed) return
      pick({ cover: hash })
    } catch (err) {
      console.warn('Could not store the cover image', err)
      toast('Could not add the cover image.', 'error')
    } finally {
      setCoverBusy(false)
    }
  }

  /** Focus moving between the title field and the picker is not "done editing". */
  const isInside = (el: EventTarget | null) => {
    const node = el as HTMLElement | null
    if (!node) return false
    return !!(rootRef.current?.contains(node) || popoverRef.current?.contains(node) || node.hasAttribute?.('data-floating-ui-focus-guard'))
  }
  const onFocusOut = (e: FocusEvent<HTMLElement>) => {
    if (choosingFile.current) return
    // Mouse clicks in the picker never move focus (it prevents mousedown), so any real blur finishes.
    if (!isInside(e.relatedTarget)) stopEditing()
  }

  /**
   * Escape in the picker ends edit mode and the focused control unmounts with the picker. When
   * focus was dropped on the page that way, it goes back to the board with this card focused.
   */
  const onPopoverEscape = () => {
    setTimeout(() => {
      const active = document.activeElement
      if (active && active !== document.body && active.isConnected) return
      const el = getCardElement(id)
      const canvas = getCanvasElement()
      if (canvas && el && canvas.contains(el)) {
        canvas.focus({ preventScroll: true })
        const sel = useSelection.getState()
        if (!sel.selected.has(id)) sel.select([id])
        sel.setKbFocus(id)
      } else if (el && el.tabIndex >= 0) el.focus({ preventScroll: true })
    }, 0)
  }

  const showCover = !!coverImage.url

  return (
    <div ref={setRoot} className={`bcard${inColumn ? ' bcard--row' : ''}`} onDoubleClick={onDoubleClick}>
      <div className={`bcard__icon${showCover ? ' has-cover' : ''}`} aria-hidden>
        {showCover ? (
          <img className="bcard__cover" src={coverImage.url!} alt="" draggable={false} />
        ) : (
          <BoardIcon icon={icon} className="bcard__glyph" strokeWidth={1.6} size={34} />
        )}
      </div>
      <div className="bcard__text">
        {isEditing ? (
          <TitleInput
            className="bcard__input"
            value={title}
            placeholder="Board name"
            maxLength={BOARD_TITLE_MAX}
            ariaLabel="Board name"
            onCommit={(v) => apply({ title: v || 'Untitled board' })}
            onDone={stopEditing}
            onBlur={onFocusOut}
            onCreateNext={() => addCardBelow(doc, id)}
          />
        ) : (
          <div className="bcard__title" title={title}>
            {title}
          </div>
        )}
        <div className="bcard__meta">
          {!boardId && <span className="bcard__warn">Unavailable</span>}
          {count !== null && <span>{cardCountLabel(count)}</span>}
          {shared && (
            <span className="bcard__shared" title="Shared board" aria-label="Shared board">
              <Users size={12} aria-hidden />
            </span>
          )}
        </div>
      </div>
      {(isEditing || coverBusy) && (
        <input
          ref={setFileInput}
          type="file"
          accept="image/*"
          className="bcard__file"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onCoverFile(e)}
        />
      )}
      {isEditing && (
        <BoardAppearancePopover
          anchor={anchor}
          icon={icon}
          color={color}
          cover={cover}
          coverBusy={coverBusy}
          blobBoardId={board.boardId}
          childBoardId={boardId}
          onIcon={(next) => pick({ icon: next })}
          onColor={(next) => pick({ color: next })}
          onCover={(next) => pick({ cover: next })}
          onUploadCover={chooseCoverFile}
          onOpenBoard={open}
          onFocusOut={onFocusOut}
          floatingRef={setPopover}
          onEscape={onPopoverEscape}
        />
      )}
    </div>
  )
}
